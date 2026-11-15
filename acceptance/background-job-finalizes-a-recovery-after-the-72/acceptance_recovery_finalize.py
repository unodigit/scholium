"""Acceptance tests for: background job finalizes a recovery after the 72-hour
contest window, while POST /v1/recovery/requests/{id}/cancel signed by the old
key returns 200 and cancels it (feature 40).

The story under test::

    account holder lost their key
      -> POST /v1/recovery/requests            (ORCID iD + new public key)
      -> POST /v1/recovery/requests/{id}/approvals   x3 guardians
         (the third opens a 72-hour contest window)
      -> EITHER the window elapses and a background job finalizes the recovery
         by appending a key.rotation record carrying the guardian proofs
         -> the old key is no longer the account's active key
      -> OR the old key signs POST /v1/recovery/requests/{id}/cancel
         -> 200, the recovery is cancelled and the old key stays active

Criteria (app_spec.xml, feature 40):

* After 3 approvals and the contest window elapsing, records signed by the old
  key return 401 from POST /v1/records.
* POST /v1/recovery/requests/{id}/cancel signed by the old key returns 200 and
  the old key stays active.

How the tests observe "the old key is (not) active"
---------------------------------------------------
Through the public write path, exactly as the criteria phrase it: a record
signed by the old key is submitted to ``POST /v1/records``.  The record is an
``endorsement`` envelope built with the project's record core and relayed with
a bystander's access token (records are self-authenticating, and relaying an
authentic record is allowed), so the only thing that can make the endpoint
refuse it is the signature check against the account's *active* key.  A probe
handler open to tier 0 is registered for the type for the duration of a test
(the same device the POST /v1/records acceptance suite uses) so the author's
trust tier is not in play either.

How the contest window "elapses"
--------------------------------
72 hours cannot be waited out, so the tests move time on by data, then run the
background job through the project's own runner (``app.jobs``):

1. the request's ``contest_until`` (documented column of ``recovery_requests``)
   is set to a moment in the past;
2. any queued job that concerns recovery -- by kind, or by naming the request
   or the account -- has its ``run_after`` moved into the past, so a job the
   feature deferred "until the window ends" is now due;
3. ``jobs.run_pending()`` runs every job that is due *now*, on the real clock.

So the contract the feature must meet is: finalization is a job on
``app.jobs`` that does its work once the request's ``contest_until`` has
passed, and does nothing for a request that is still inside its window or has
been cancelled.  The tests do not care whether it was queued per request or is
a periodic sweep, nor what it is called.

How "signed by the old key" is presented to the cancel endpoint
---------------------------------------------------------------
The spec fixes no wire format for the cancel call, so the request carries the
old key's signature in both ways this API uses to authenticate a key holder: a
bearer access token obtained by signing a fresh sign-in challenge with the old
key, and a detached Ed25519 signature by the old key over the request id (the
same message a guardian signs to approve) in the JSON body.  Nothing is
asserted about the response body.
"""

from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    did_key_from_signing_key,
    encode_signature,
    sign_record,
    verify_record,
)
from sqlalchemy import MetaData, Table, inspect, update

from app import db, jobs
from app.modules import ingest

#: Endpoints.
RECORDS_URL = "/v1/records"
REQUESTS_URL = "/v1/recovery/requests"

#: RFC 9457 media type every API error on this app is served as.
PROBLEM_JSON = "application/problem+json"

#: A real Phase 1 record type whose body schema needs no other record to exist
#: (an endorsement names a DID and a category).
RECORD_TYPE = "endorsement"

#: Guardians who must approve before the contest window opens.
APPROVALS_NEEDED = 3

#: Number of recovery guardians an account names.
GUARDIAN_COUNT = 5


def _utcnow() -> datetime:
    """Naive UTC now -- the datetime shape the project's tables store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _probe_handler(*args, **kwargs):
    """Stands in for the type's real handler; accepts anything."""
    return None


# --------------------------------------------------------------------------- #
# Keys, sign-in and signatures
# --------------------------------------------------------------------------- #


def sign_text(seed: SigningKey, text: str) -> str:
    """A detached Ed25519 signature over ``text``, as unpadded base64url."""
    return encode_signature(bytes(seed.sign(text.encode("utf-8")).signature))


def sign_in(client, seed: SigningKey) -> str:
    """Sign ``seed``'s did:key in (challenge, then verify); return the access token."""
    did = did_key_from_signing_key(seed)
    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]
    verify = client.post(
        "/v1/auth/verify",
        json={"did": did, "nonce": nonce, "signature": sign_text(seed, nonce)},
    )
    assert verify.status_code == 200, verify.text
    return verify.json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def new_orcid() -> str:
    """A fresh, well-formed ORCID iD with a valid MOD 11-2 check character."""
    digits = [random.randrange(10) for _ in range(15)]
    total = 0
    for digit in digits:
        total = (total + digit) * 2
    check = (12 - total % 11) % 11
    text = "".join(map(str, digits)) + ("X" if check == 10 else str(check))
    return "-".join(text[i : i + 4] for i in range(0, 16, 4))


# --------------------------------------------------------------------------- #
# Driving the recovery through the API
# --------------------------------------------------------------------------- #


class Recovery:
    """An account whose recovery has been opened and approved by three guardians.

    ``old_seed`` is the key that was lost (the account's did:key *is* that
    key), ``new_seed`` the key the recovery moves the account to.  The contest
    window is open: ``request_id`` has three guardian approvals.
    """

    def __init__(self, client) -> None:
        self.client = client
        self.old_seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.old_seed)
        self.new_seed = SigningKey.generate()
        self.new_public_key = did_key_from_signing_key(self.new_seed)
        self.guardians = [SigningKey.generate() for _ in range(GUARDIAN_COUNT)]
        self.orcid = new_orcid()
        # Records are relayed with a bystander's token, so the only thing that
        # can refuse one is its signature -- never the caller's own session.
        self.relay_headers = bearer(sign_in(client, SigningKey.generate()))

        owner_token = sign_in(client, self.old_seed)
        self._link_orcid(owner_token)
        self._set_guardians(owner_token)
        self.request_id = self._open_request()
        for guardian in self.guardians[:APPROVALS_NEEDED]:
            self._approve(guardian)

    # -- setup steps --------------------------------------------------------- #

    def _link_orcid(self, owner_token: str) -> None:
        start = self.client.get("/v1/auth/orcid/start", headers=bearer(owner_token))
        assert start.status_code == 200, start.text
        callback = self.client.get(
            "/v1/auth/orcid/callback",
            params={"code": f"mock-{self.orcid}", "state": start.json()["state"]},
        )
        assert callback.status_code == 200, callback.text

    def _set_guardians(self, owner_token: str) -> None:
        response = self.client.put(
            "/v1/me/guardians",
            json={"guardians": [did_key_from_signing_key(g) for g in self.guardians]},
            headers=bearer(owner_token),
        )
        assert response.status_code == 200, response.text

    def _open_request(self) -> str:
        response = self.client.post(
            REQUESTS_URL,
            json={"orcid": self.orcid, "new_public_key": self.new_public_key},
        )
        assert response.status_code == 201, response.text
        return response.json()["request_id"]

    def _approve(self, guardian: SigningKey) -> None:
        """One guardian signs the request id and approves."""
        response = self.client.post(
            f"{REQUESTS_URL}/{self.request_id}/approvals",
            json={
                "guardian_did": did_key_from_signing_key(guardian),
                "signature": sign_text(guardian, self.request_id),
            },
        )
        assert response.status_code in (200, 201), response.text

    # -- what the tests do -------------------------------------------------- #

    def cancel_signed_by_old_key(self):
        """POST the cancel call, signed by the old key (see the module docstring)."""
        token = sign_in(self.client, self.old_seed)
        signature = sign_text(self.old_seed, self.request_id)
        return self.client.post(
            f"{REQUESTS_URL}/{self.request_id}/cancel",
            json={
                "did": self.did,
                "signer": self.did,
                "signature": signature,
                "sig": signature,
            },
            headers=bearer(token),
        )

    def old_key_record(self) -> dict:
        """A sound, fresh record signed by the old key (the account's author key)."""
        unsigned = {
            "v": 1,
            "type": RECORD_TYPE,
            "author": self.did,
            "created": _utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "endorsee": did_key_from_signing_key(SigningKey.generate()),
                "category": "cs.CR",
                "statement": f"acceptance {uuid.uuid4().hex}",
            },
            "proofs": [],
        }
        record = sign_record(unsigned, self.old_seed)
        # Guard the fixture itself: the record is intact, so a refusal can only
        # come from the old key no longer being the account's active key.
        assert verify_record(record)
        return record

    def post_old_key_record(self):
        """Submit a fresh record signed by the old key to ``POST /v1/records``."""
        return self.client.post(
            RECORDS_URL, json=self.old_key_record(), headers=self.relay_headers
        )

    def run_background_jobs(self) -> None:
        """Run whatever background jobs are due right now."""
        jobs.run_pending()

    def let_the_contest_window_elapse(self, *, request_row_required: bool = True) -> None:
        """Move past the 72-hour window and let the background job have its turn.

        See "How the contest window elapses" in the module docstring.
        """
        past = _utcnow() - timedelta(minutes=1)

        requests_table = Table("recovery_requests", MetaData(), autoload_with=db.engine)
        with db.engine.begin() as conn:
            updated = conn.execute(
                update(requests_table)
                .where(requests_table.c.id == self.request_id)
                .values(contest_until=past)
            ).rowcount
        if request_row_required:
            assert updated == 1, "the recovery request must still be stored"

        if inspect(db.engine).has_table(jobs.Job.__tablename__):
            with db.SessionLocal() as session:
                queued = session.query(jobs.Job).filter(jobs.Job.status == jobs.STATUS_QUEUED)
                for job in queued:
                    if self._concerns_this_recovery(job):
                        job.run_after = past
                session.commit()

        self.run_background_jobs()

    def _concerns_this_recovery(self, job) -> bool:
        text = f"{job.kind} {json.dumps(job.payload, default=str)}".lower()
        return any(
            marker in text for marker in ("recover", self.request_id.lower(), self.did.lower())
        )


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def registered_type():
    """Make ``RECORD_TYPE`` a known type that any tier may submit.

    A real handler registered for the type by another feature is set aside for
    the duration of the test and put back afterwards.
    """
    previous = ingest.get(RECORD_TYPE)
    if previous is not None:
        ingest.unregister(RECORD_TYPE)
    ingest.register(RECORD_TYPE, _probe_handler, min_tier=0)
    try:
        yield RECORD_TYPE
    finally:
        ingest.unregister(RECORD_TYPE)
        if previous is not None:
            ingest.register(RECORD_TYPE, previous.handler, previous.min_tier)


@pytest.fixture
def recovery(client, registered_type) -> Recovery:
    """A recovery with three guardian approvals: the contest window is open."""
    return Recovery(client)


# --------------------------------------------------------------------------- #
# Assertions
# --------------------------------------------------------------------------- #


def assert_problem_details(response, status: int) -> dict:
    """Assert ``response`` is an RFC 9457 problem document with ``status``.

    Only what "returns problem details" states: the problem media type and the
    document's own status matching the HTTP status, plus the ``title`` every
    problem document on this API carries.  The ``type`` URN is not pinned.
    """
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), (
        f"a {status} must be served as {PROBLEM_JSON}, "
        f"got {response.headers['content-type']!r}"
    )
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def assert_old_key_accepted(response) -> None:
    """The old key is still the account's active key: its record was appended."""
    assert response.status_code == 201, (
        f"a record signed by the account's active key must be accepted, "
        f"got {response.status_code}: {response.text}"
    )


# --------------------------------------------------------------------------- #
# Criterion 1: after 3 approvals and the window elapsing, the old key gets 401
# --------------------------------------------------------------------------- #


def test_after_3_approvals_and_the_contest_window_elapsing_records_signed_by_the_old_key_return_401(
    recovery,
):
    # Control: with the window still open the old key is the active key, and
    # running the background job changes nothing -- so what flips the outcome
    # below is the window elapsing, not the test harness.
    recovery.run_background_jobs()
    assert_old_key_accepted(recovery.post_old_key_record())

    recovery.let_the_contest_window_elapse()

    response = recovery.post_old_key_record()

    assert_problem_details(response, 401)


# --------------------------------------------------------------------------- #
# Criterion 2: cancel signed by the old key returns 200 and the old key stays
# --------------------------------------------------------------------------- #


def test_cancel_signed_by_the_old_key_returns_200_and_the_old_key_stays_active(recovery):
    response = recovery.cancel_signed_by_old_key()

    assert response.status_code == 200, response.text

    # The old key is the active key straight after the cancel ...
    assert_old_key_accepted(recovery.post_old_key_record())

    # ... and stays so when the 72 hours are over and the background job runs:
    # a cancelled recovery must not be finalized.
    recovery.let_the_contest_window_elapse(request_row_required=False)

    assert_old_key_accepted(recovery.post_old_key_record())
