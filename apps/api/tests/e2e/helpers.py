"""Helpers shared by the API journey tests.

A journey is told from the outside: people sign in, save profiles, submit signed
records and read answers back, all through ``/v1``.  :class:`Actor` is such a
person -- a fresh Ed25519 key, the ``did:key`` it encodes, and whatever tokens
the API has handed them so far.  Nothing here reaches into the database or the
plugins, except to read the one thing HTTP cannot show: the mail the node sent
(:func:`verification_link_for`).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature, sign_record

from app.modules.notifications import get_outbox
from app.modules.profiles import EMAIL_VERIFICATION_KIND
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

    # --- records -------------------------------------------------------------

    def record(self, record_type: str, body: dict) -> dict:
        """A ``record_type`` record with ``body``, signed by this actor's key."""
        envelope = {
            "v": 1,
            "type": record_type,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": body,
            "proofs": [],
        }
        return sign_record(envelope, self.seed)

    def submit(self, record: dict) -> Any:
        """``POST /v1/records`` the record with this actor's access token."""
        return self.client.post("/v1/records", json=record, headers=self.headers)
