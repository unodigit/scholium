"""Tests for email verification (feature 178).

Covers the two halves of the feature:

* ``PUT /v1/profiles/{did}`` emails a signed link to the address it just saved;
* ``POST /v1/profiles/{did}/verify-email`` redeems that token, answers ``200``
  with ``email_verified: true`` and flips :func:`email_verified`, the predicate
  tier 1 requires.

Also pinned here: the token is bound to the DID *and* to the saved address, so
changing the address (or erasing the profile) invalidates it; the link carries
no plaintext address; and a caller may post the token as a query parameter (the
shape of the emailed link) or as JSON.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import pytest

from app.modules.notifications import clear_outbox, get_outbox
from app.modules.profiles import (
    DEFAULT_VERIFICATION_TTL,
    EMAIL_VERIFICATION_KIND,
    InvalidEmailVerificationToken,
    ProfileData,
    email_fingerprint,
    email_verified,
    ensure_tables,
    issue_verification_token,
    mark_email_verified,
    read_profile,
    save_profile,
    verify_verification_token,
)
from app.modules.profiles.service import ProfileNotFound
from app.security import UNAUTHENTICATED_TYPE

PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}


@pytest.fixture(autouse=True)
def _fresh_outbox():
    """The notifications outbox is process-global; every test starts empty."""
    clear_outbox()
    yield
    clear_outbox()


def _last_email() -> dict:
    emails = get_outbox()
    assert emails, "the PUT did not hand an email to the notifications plugin"
    return emails[-1]


def _last_link() -> str:
    body = _last_email()["body"]
    match = re.search(r"Open:\s*(\S+)", body)
    assert match, f"no link in the notification email body: {body!r}"
    return match.group(1)


def _last_token() -> str:
    return parse_qs(urlparse(_last_link()).query)["token"][0]


def _verify(client, did: str, token: str, **kwargs):
    return client.post(
        f"/v1/profiles/{did}/verify-email",
        params={"token": token},
        **kwargs,
    )


def _problem(response) -> dict:
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == response.status_code
    assert body["title"]
    return body


# --- PUT sends the link -----------------------------------------------------


def test_put_emails_a_verification_link_to_the_saved_address(client, did, auth):
    response = client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    assert response.status_code == 200

    email = _last_email()
    assert email["to"] == PROFILE["email"]
    assert email["did"] == did
    assert email["kind"] == EMAIL_VERIFICATION_KIND

    link = _last_link()
    assert f"/v1/profiles/{did}/verify-email" in link
    assert "token=" in link


def test_the_emailed_link_carries_no_plaintext_address(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    token = _last_token()

    assert PROFILE["email"] not in token
    assert PROFILE["email"] not in _last_link()


def test_every_save_emails_a_fresh_link(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    first = _last_token()
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    second = _last_token()

    assert first != second


# --- redeeming the link -----------------------------------------------------


def test_the_emailed_link_verifies_the_address(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    token = _last_token()
    assert email_verified(did) is False

    response = _verify(client, did, token)

    assert response.status_code == 200
    assert response.json() == {"did": did, "email_verified": True}
    assert response.headers["cache-control"] == "no-store"
    assert email_verified(did) is True


def test_the_token_may_be_posted_in_a_json_body(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = client.post(
        f"/v1/profiles/{did}/verify-email",
        json={"token": _last_token()},
    )

    assert response.status_code == 200
    assert response.json()["email_verified"] is True
    assert email_verified(did) is True


def test_the_owner_may_verify_while_signed_in(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = _verify(client, did, _last_token(), headers=auth(did))

    assert response.status_code == 200
    assert email_verified(did) is True


def test_verifying_twice_is_idempotent(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    token = _last_token()

    assert _verify(client, did, token).status_code == 200
    response = _verify(client, did, token)

    assert response.status_code == 200
    assert response.json()["email_verified"] is True


def test_verification_stops_counting_when_the_address_changes(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    old_token = _last_token()
    assert _verify(client, did, old_token).status_code == 200
    assert email_verified(did) is True

    moved = {**PROFILE, "email": "ada.king@example.org"}
    client.put(f"/v1/profiles/{did}", json=moved, headers=auth(did))

    assert email_verified(did) is False
    assert _verify(client, did, old_token).status_code == 400
    assert email_verified(did) is False

    assert _verify(client, did, _last_token()).status_code == 200
    assert email_verified(did) is True


def test_resaving_the_same_address_keeps_its_verification(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    assert _verify(client, did, _last_token()).status_code == 200

    renamed = {**PROFILE, "name": "Ada King"}
    client.put(f"/v1/profiles/{did}", json=renamed, headers=auth(did))

    assert email_verified(did) is True


def test_erasure_clears_the_verification(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    assert _verify(client, did, _last_token()).status_code == 200
    assert email_verified(did) is True

    assert client.delete(f"/v1/profiles/{did}", headers=auth(did)).status_code == 202

    assert email_verified(did) is False
    # No readable profile: there is nothing left to verify.
    assert _verify(client, did, _last_token()).status_code == 404

    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    assert email_verified(did) is False  # saving after erasure starts unverified
    assert _verify(client, did, _last_token()).status_code == 200
    assert email_verified(did) is True


# --- rejections -------------------------------------------------------------


def test_a_forged_token_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    token = _last_token()
    tampered = token[:-4] + ("AAAA" if not token.endswith("AAAA") else "BBBB")

    response = _verify(client, did, tampered)

    assert response.status_code == 400
    _problem(response)
    assert email_verified(did) is False


def test_a_missing_token_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = client.post(f"/v1/profiles/{did}/verify-email")

    assert response.status_code == 400
    _problem(response)
    assert email_verified(did) is False


def test_a_token_for_another_did_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    other = f"did:key:z6Mk{uuid.uuid4().hex}"
    foreign = issue_verification_token(other, PROFILE["email"])

    response = _verify(client, did, foreign)

    assert response.status_code == 400
    assert email_verified(did) is False


def test_a_token_for_another_address_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    foreign = issue_verification_token(did, "mallory@example.org")

    response = _verify(client, did, foreign)

    assert response.status_code == 400
    assert email_verified(did) is False


def test_an_expired_token_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    issued_long_ago = datetime.now(timezone.utc) - DEFAULT_VERIFICATION_TTL - timedelta(minutes=1)
    expired = issue_verification_token(did, PROFILE["email"], now=issued_long_ago)

    assert _verify(client, did, expired).status_code == 400
    assert email_verified(did) is False


def test_a_token_from_the_future_is_rejected(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    token = issue_verification_token(did, PROFILE["email"], now=future)

    assert _verify(client, did, token).status_code == 400


def test_verifying_a_did_with_no_profile_is_404(client, did):
    token = issue_verification_token(did, PROFILE["email"])

    response = _verify(client, did, token)

    assert response.status_code == 404
    _problem(response)


def test_a_signed_in_stranger_cannot_verify_someone_elses_address(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    stranger = f"did:key:z6Mk{uuid.uuid4().hex}"

    response = _verify(client, did, _last_token(), headers=auth(stranger))

    assert response.status_code == 403
    _problem(response)
    assert email_verified(did) is False


def test_a_broken_bearer_token_is_a_401(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = _verify(
        client,
        did,
        _last_token(),
        headers={"Authorization": "Bearer not-a-jwt"},
    )

    assert response.status_code == 401
    assert _problem(response)["type"] == UNAUTHENTICATED_TYPE
    assert email_verified(did) is False


# --- the underlying primitives and predicate --------------------------------


def test_the_predicate_is_false_for_an_unknown_did(did):
    assert email_verified(did) is False


def test_a_direct_save_is_pending_until_its_link_is_redeemed(did):
    save_profile(did, ProfileData(**PROFILE))
    token = issue_verification_token(did, PROFILE["email"])

    assert email_verified(did) is False

    with pytest.raises(ProfileNotFound):
        mark_email_verified(f"did:key:z6Mk{uuid.uuid4().hex}", token)
    with pytest.raises(InvalidEmailVerificationToken):
        mark_email_verified(did, issue_verification_token(did, "other@example.org"))

    outcome = mark_email_verified(did, token)

    assert outcome.did == did
    assert outcome.email == PROFILE["email"]
    assert email_verified(did) is True


def test_tokens_are_bound_to_the_normalised_address(did):
    email = "Ada@Example.ORG"
    token = issue_verification_token(did, email)

    assert verify_verification_token(token, did, "ada@example.org") is True
    assert verify_verification_token(token, did, "ada@example.com") is False
    assert email_fingerprint(did, " Ada@Example.ORG ") == email_fingerprint(
        did, "ada@example.org"
    )


def test_the_fingerprint_stored_outside_the_blob_reveals_nothing(did):
    save_profile(did, ProfileData(**PROFILE))
    ensure_tables()

    from sqlalchemy import text

    from app import db

    with db.engine.connect() as conn:
        fingerprint = conn.execute(
            text("SELECT email_fingerprint FROM profile_email_verification WHERE did = :d"),
            {"d": did},
        ).scalar_one()

    assert PROFILE["email"] not in fingerprint
    assert read_profile(did).email == PROFILE["email"]  # still only in the encrypted blob
