"""Helpers shared by the API journey tests.

A journey is told from the outside: people sign in, save profiles, submit signed
records and read answers back, all through ``/v1``.  :class:`Actor` is such a
person -- a fresh Ed25519 key, the ``did:key`` it encodes, and whatever tokens
the API has handed them so far.  Nothing here reaches into the database or the
plugins, except to reach the two things HTTP cannot: the mail the node sent
(:func:`verification_link_for`) and the passage of time
(:func:`elapse_recovery_contest_window`).
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_record_id,
    did_key_from_signing_key,
    encode_signature,
    sign_envelope,
    sign_record,
)

from app import db, jobs
from app.modules.notifications import get_outbox
from app.modules.profiles import EMAIL_VERIFICATION_KIND
from app.modules.recovery import CONTEST_WINDOW, JOB_KIND as RECOVERY_FINALIZE_JOB, RecoveryRequest
from app.security import decode_access_token

PROBLEM_JSON = "application/problem+json"


def now() -> str:
    """The current instant as the RFC 3339 UTC string a record's ``created`` carries."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def assert_problem(response: Any, status: int) -> dict:
    """Assert ``response`` is an RFC 9457 problem document with ``status``; return it."""
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def verification_link_for(did: str) -> str:
    """The path and query of the latest verification link emailed to ``did``.

    Without ``SMTP_URL`` the node keeps outgoing mail in an in-process outbox,
    which stands in for the user's inbox here.  The link is returned the way a
    mail client would follow it: as a request target, host dropped.
    """
    mails = [m for m in get_outbox() if m.get("did") == did and m.get("kind") == EMAIL_VERIFICATION_KIND]
    assert mails, f"no verification email was sent to {did}"
    match = re.search(r"Open:\s*(\S+)", mails[-1]["body"])
    assert match, f"no link in the verification email: {mails[-1]['body']!r}"
    link = urlparse(match.group(1))
    return f"{link.path}?{link.query}"


def sign_text(seed: SigningKey, text: str) -> str:
    """A detached Ed25519 signature over ``text`` by ``seed``, as the API writes signatures."""
    return encode_signature(bytes(seed.sign(text.encode("utf-8")).signature))


def recovery_finalize_jobs(request_id: str) -> list[jobs.Job]:
    """The ``recovery.finalize`` jobs still queued for the recovery request ``request_id``."""
    with db.SessionLocal() as session:
        queued = session.query(jobs.Job).filter(
            jobs.Job.kind == RECOVERY_FINALIZE_JOB, jobs.Job.status == jobs.STATUS_QUEUED
        )
        found = [job for job in queued if (job.payload or {}).get("request_id") == request_id]
        session.expunge_all()
    return found


def elapse_recovery_contest_window(request_id: str) -> int:
    """Let the 72-hour contest window of ``request_id`` run out, then run the due jobs.

    Nobody can wait three days in a test and HTTP has no clock to turn, so time
    is moved the one way the data allows: everything the node stored about this
    window -- the request's ``contest_until`` and the ``run_after`` of the job
    scheduled for the window's end -- is moved back by the window's length plus a
    minute, exactly as if the third approval had come in 72 hours and a minute ago.
    Then the job runner is run on the real clock, which is what the node's worker
    thread does on its own in production.  Only this request's rows are touched.

    Returns how many job attempts the runner made.
    """
    shift = CONTEST_WINDOW + timedelta(minutes=1)
    with db.SessionLocal() as session:
        request = session.get(RecoveryRequest, request_id)
        assert request is not None and request.contest_until is not None, "no contest window is open"
        request.contest_until -= shift
        for job in session.query(jobs.Job).filter(
            jobs.Job.kind == RECOVERY_FINALIZE_JOB, jobs.Job.status == jobs.STATUS_QUEUED
        ):
            if (job.payload or {}).get("request_id") == request_id and job.run_after is not None:
                job.run_after -= shift
        session.commit()
    return jobs.run_pending()


class Actor:
    """A person with a ``did:key`` who uses the API only over HTTP."""

    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None

    # --- authentication ------------------------------------------------------

    def sign_in(self) -> None:
        """Run the challenge/response sign-in and keep the tokens it issues."""
        challenge = self.client.post("/v1/auth/challenge", json={"did": self.did})
        assert challenge.status_code == 200, challenge.text
        nonce = challenge.json()["nonce"]

        signature = encode_signature(self.seed.sign(nonce.encode("utf-8")).signature)
        verified = self.client.post(
            "/v1/auth/verify", json={"did": self.did, "nonce": nonce, "signature": signature}
        )
        assert verified.status_code == 200, verified.text
        self._keep(verified.json())

    def refresh(self) -> None:
        """Trade the refresh token for a new pair, which carries the account's current tier."""
        assert self.refresh_token, "sign in first"
        refreshed = self.client.post("/v1/auth/refresh", json={"refresh_token": self.refresh_token})
        assert refreshed.status_code == 200, refreshed.text
        self._keep(refreshed.json())

    def _keep(self, tokens: dict) -> None:
        self.access_token = tokens["access_token"]
        self.refresh_token = tokens["refresh_token"]

    @property
    def headers(self) -> dict[str, str]:
        assert self.access_token, "sign in first"
        return {"Authorization": f"Bearer {self.access_token}"}

    @property
    def tier(self) -> int:
        """The trust tier the API put in the access token this actor holds now."""
        assert self.access_token, "sign in first"
        return decode_access_token(self.access_token).tier

    def link_orcid(self, orcid: str) -> dict:
        """Link ``orcid`` through the (mock) ORCID login; return the credential the node issues."""
        start = self.client.get("/v1/auth/orcid/start", headers=self.headers)
        assert start.status_code == 200, start.text
        callback = self.client.get(
            "/v1/auth/orcid/callback",
            params={"code": f"mock-{orcid}", "state": start.json()["state"]},
        )
        assert callback.status_code == 200, callback.text
        return callback.json()

    def sign(self, text: str) -> str:
        """A detached signature over ``text`` by this actor's key (what a guardian signs to approve)."""
        return sign_text(self.seed, text)

    # --- records -------------------------------------------------------------

    def record(self, record_type: str, body: dict, *, signer: Optional[SigningKey] = None) -> dict:
        """A ``record_type`` record with ``body``, authored by this actor's DID.

        It is signed by this actor's key unless ``signer`` names another: after
        a recovery the account keeps its DID but a different key signs for it.
        (:func:`~scholium_record_core.sign_record` refuses to sign for an author
        whose did:key is not the signing key's, so that case completes the
        envelope with its cid and signature by hand.)
        """
        envelope = {
            "v": 1,
            "type": record_type,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": body,
            "proofs": [],
        }
        if signer is None:
            return sign_record(envelope, self.seed)
        envelope["id"] = compute_record_id(envelope)
        envelope["sig"] = sign_envelope(envelope, signer)
        return envelope

    def submit(self, record: dict) -> Any:
        """``POST /v1/records`` the record with this actor's access token."""
        return self.client.post("/v1/records", json=record, headers=self.headers)
