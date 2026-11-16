"""Journey: three of five guardians recover a lost key, the new key signs and the old key is refused.

The story, told through ``/v1`` (and the job runner, which is the node's clock):

1. an account holder signs in, links their ORCID iD and names five recovery
   guardians -- the setup a holder must have done *before* losing the key;
2. the key is lost.  With only the ORCID iD and the public half of a new key the
   holder opens a recovery request, which needs no access token, and the five
   guardians are told about it;
3. two guardians approve, each from their own session and each by signing the
   request (id, account DID and new key) with their own key: not enough, and
   nothing opens; a guardian approving twice still counts once;
4. the third guardian's approval opens the 72-hour contest window.  Inside it
   nothing has changed: the old key still signs for the account, the new key
   does not yet, and the background job that would finalize the recovery has
   nothing to do;
5. the contest window elapses and the background job finalizes the recovery,
   appending a ``key.rotation`` record that carries the guardians' proofs;
6. the new key now signs records for the account and they are accepted with 201,
   while a record signed by the old key is refused with 401 and stored nowhere.

The account's DID never changes: a ``did:key`` names the key it was born with,
and what moves on is the key that may sign for it.  Records therefore keep the
old DID as their ``author`` and differ only in who signed them.

Records are relayed by a third party's session.  That is allowed -- a record is
self-authenticating, its authority is its signature -- and it is how a person
who has lost their key submits at all, since signing in proves possession of the
key the DID was born with, which is exactly what they no longer have.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from app import db, jobs
from app.modules.identity.models import Account, ensure_account_table
from app.modules.notifications import get_outbox
from app.modules.recovery import approval_message
from app.security import issue_access_token

from .helpers import (
    Actor,
    assert_problem,
    elapse_recovery_contest_window,
    recovery_finalize_jobs,
)

ORCID_ID = "0000-0002-1825-0097"

#: The ``kind`` of the notification a guardian receives about a recovery request.
RECOVERY_NOTIFICATION = "recovery.request"

#: ``type`` of the problem document for a signature the author's active key did not make.
RECORD_SIGNATURE_INVALID = "urn:scholium:problem:record-signature-invalid"

#: A tier-1 record type (REV-1); the holder is promoted to tier 1 below so that
#: only the signature -- never the author's tier -- decides the outcome.
RECORD_TYPE = "discussion.post"

WINDOW = timedelta(hours=72)
REQUESTS = "/v1/recovery/requests"


def post_body(text: str) -> dict:
    """A ``discussion.post`` body; ``text`` keeps every record's cid distinct."""
    return {"target": "bafyreiexamplepaper", "anchor": "bafyreiexamplepaper", "text": text}


def approve(client, request_id: str, guardian: Actor, account_did: str, new_key: str):
    """``guardian`` approves ``request_id`` from their own session.

    The access token names the guardian, and the detached signature by that
    guardian's key binds the request id, the account DID and the new key -- an
    anonymous approval naming a guardian in the body is not enough.
    """
    token = issue_access_token(guardian.did, 0)
    return client.post(
        f"{REQUESTS}/{request_id}/approvals",
        json={
            "guardian_did": guardian.did,
            "signature": guardian.sign(approval_message(request_id, account_did, new_key)),
        },
        headers={"Authorization": f"Bearer {token}"},
    )


def logged(client, record_type: str) -> list[dict]:
    """The entries of ``record_type`` in the node's public event log, oldest first."""
    response = client.get("/v1/sync/range")
    assert response.status_code == 200, response.text
    return [entry for entry in response.json() if entry["record_type"] == record_type]


def parse_instant(text: str) -> datetime:
    """An API timestamp as an aware UTC datetime (the API may or may not mark it with a ``Z``)."""
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _promote_to_member(did: str) -> None:
    """Make ``did`` a tier-1 Member so its ``discussion.post`` records pass the tier gate."""
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            session.add(Account(did=did, tier=1, created_at=datetime.now(timezone.utc).replace(tzinfo=None)))
        else:
            account.tier = max(int(account.tier or 0), 1)
        session.commit()


def test_three_of_five_guardians_recover_the_account_and_the_old_key_is_refused(client, node):
    holder = Actor(client)  # the account; its did:key is its genesis key
    new_key = SigningKey.generate()  # what the holder will sign with from now on
    new_key_did = did_key_from_signing_key(new_key)
    guardians = [Actor(client) for _ in range(5)]
    relay = Actor(client)  # whoever carries a signed record to the node

    # 1. Before the key is lost: ORCID linked, five guardians named.
    holder.sign_in()
    credential = holder.link_orcid(ORCID_ID)
    assert credential["credentialSubject"] == {"id": holder.did, "orcid": ORCID_ID}
    named = client.put(
        "/v1/me/guardians", json={"guardians": [g.did for g in guardians]}, headers=holder.headers
    )
    assert named.status_code == 200, named.text
    assert named.json() == {"guardians": [g.did for g in guardians]}
    _promote_to_member(holder.did)
    relay.sign_in()

    def submit_signed_by(signer: SigningKey, text: str):
        """Relay a record authored by the account and signed by ``signer``."""
        record = holder.record(RECORD_TYPE, post_body(text), signer=signer)
        return record, relay.submit(record)

    # 2. The key is lost.  The holder opens a recovery request with no token at
    #    all: their ORCID iD identifies the account, the new key is its future.
    opened = client.post(
        REQUESTS, json={"orcid": ORCID_ID, "new_public_key": new_key_did}
    )
    assert opened.status_code == 201, opened.text
    assert opened.json()["status"] == "pending"
    assert opened.json()["guardians_notified"] == 5
    request_id = opened.json()["request_id"]
    assert holder.did not in opened.text, "an open endpoint must not turn an ORCID iD into a DID"

    told = {m["did"] for m in get_outbox() if m.get("kind") == RECOVERY_NOTIFICATION}
    assert told == {g.did for g in guardians}, "each of the five guardians is notified"

    # 3. Two approvals are not enough.  The same guardian approving again changes nothing.
    first = approve(client, request_id, guardians[0], holder.did, new_key_did)
    assert first.status_code == 200, first.text
    assert (first.json()["approval_count"], first.json()["status"]) == (1, "pending")
    again = approve(client, request_id, guardians[0], holder.did, new_key_did)
    assert again.status_code == 200, again.text
    assert again.json()["approval_count"] == 1, "one guardian is one approval, however often they sign"
    second = approve(client, request_id, guardians[1], holder.did, new_key_did)
    assert second.status_code == 200, second.text
    assert (second.json()["approval_count"], second.json()["status"]) == (2, "pending")
    assert second.json()["contest_until"] is None
    assert recovery_finalize_jobs(request_id) == [], "no contest window yet, so nothing to finalize"

    # 4. The third approval opens the 72-hour contest window.
    opened_at = datetime.now(timezone.utc)
    third = approve(client, request_id, guardians[2], holder.did, new_key_did)
    assert third.status_code == 200, third.text
    window = third.json()
    assert (window["approval_count"], window["status"]) == (3, "contest")
    assert window["opened_contest_window"] is True
    closes_at = parse_instant(window["contest_until"])
    assert opened_at + WINDOW - timedelta(minutes=1) <= closes_at <= datetime.now(timezone.utc) + WINDOW
    assert len(recovery_finalize_jobs(request_id)) == 1, "a job waits for the window's end"

    # Inside the window nothing has moved: the old key still signs for the account,
    # the new key may not yet, and the job runner leaves the recovery alone.
    still_old, accepted = submit_signed_by(holder.seed, "Written inside the contest window.")
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["id"] == still_old["id"]
    too_soon, refused = submit_signed_by(new_key, "The new key is not active yet.")
    assert assert_problem(refused, 401)["type"] == RECORD_SIGNATURE_INVALID
    assert client.get(f"/v1/records/{too_soon['id']}").status_code == 404
    assert jobs.run_pending() == 0, "the window is still open: the finalize job is not due"
    assert len(recovery_finalize_jobs(request_id)) == 1
    assert logged(client, "key.rotation") == [], "nothing is rotated while the window is open"

    # A fourth guardian approving later does not reopen or extend anything.
    late = approve(client, request_id, guardians[3], holder.did, new_key_did)
    assert late.status_code == 200, late.text
    assert (late.json()["approval_count"], late.json()["status"]) == (4, "contest")
    assert late.json()["contest_until"] == window["contest_until"]
    assert late.json()["opened_contest_window"] is False

    # 5. Seventy-two hours pass; the background job finalizes the recovery.
    assert elapse_recovery_contest_window(request_id) == 1
    assert recovery_finalize_jobs(request_id) == [], "the finalize job has run"

    # It recorded the hand-over in the public log: a key.rotation for the account,
    # to the new key, carrying the proofs of the guardians who approved -- and only them.
    (rotation,) = logged(client, "key.rotation")
    assert rotation["author_did"] == holder.did
    assert rotation["body"]["newKey"] == did_key_from_signing_key(new_key)
    proofs = json.dumps(rotation["body"]["recoveryProof"])
    assert all(g.did in proofs for g in guardians[:4]), "the four approvals are carried as proofs"
    assert guardians[4].did not in proofs, "the guardian who never approved is not"

    # 6. The new key signs for the account; the old key no longer does.
    by_new_key, accepted = submit_signed_by(new_key, "Back, on a new key.")
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["id"] == by_new_key["id"]
    assert accepted.json()["state"] == "accepted"
    stored = client.get(f"/v1/records/{by_new_key['id']}")
    assert stored.status_code == 200, stored.text
    assert by_new_key["author"] == holder.did, "the account keeps its DID; only its key moved"

    by_old_key, refused = submit_signed_by(holder.seed, "Signed with the key that was lost.")
    problem = assert_problem(refused, 401)
    assert problem["type"] == RECORD_SIGNATURE_INVALID
    assert client.get(f"/v1/records/{by_old_key['id']}").status_code == 404, "a refused record is stored nowhere"
