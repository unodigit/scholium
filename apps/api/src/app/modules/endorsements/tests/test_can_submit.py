"""Tests for submission rights and the endorsement listing (feature 42).

``can_submit(did, category)`` is ``True`` exactly when an active (unexpired)
endorsement of that DID for that category exists; ``GET /v1/me/endorsements``
lists the caller's active endorsements with their expiry.  Isolation: every
test uses fresh DIDs and a category unique to the test, so parallel workers
never see each other's rows.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from app.modules.endorsements import (
    active_endorsements,
    can_submit,
    save_endorsement,
)
from app.security import issue_access_token

URL = "/v1/me/endorsements"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _did() -> str:
    return did_key_from_signing_key(SigningKey.generate())


def _category() -> str:
    """A category unique to one test, so shared databases never collide."""
    return f"cs.AI.{uuid.uuid4().hex}"


def _endorse(
    endorsee: str,
    category: str,
    *,
    expires_at: object = None,
    endorser: str | None = None,
) -> None:
    save_endorsement(
        record_cid=f"cid-{uuid.uuid4().hex}",
        endorser_did=endorser or _did(),
        endorsee_did=endorsee,
        category=category,
        expires_at=expires_at,
    )


def _headers(did: str, tier: int = 2) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


# --------------------------------------------------------------------------- #
# can_submit
# --------------------------------------------------------------------------- #


def test_can_submit_is_false_without_an_endorsement():
    assert can_submit(_did(), _category()) is False


def test_can_submit_is_true_for_an_active_endorsement():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category)

    assert can_submit(endorsee, category) is True


def test_can_submit_is_true_while_an_expiry_lies_in_the_future():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category, expires_at="2099-01-02T03:04:05Z")

    assert can_submit(endorsee, category) is True


def test_can_submit_is_false_after_the_endorsement_expires():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category, expires_at="2000-01-02T03:04:05Z")

    assert can_submit(endorsee, category) is False


def test_can_submit_uses_the_instant_it_is_given():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category, expires_at="2030-01-02T03:04:05Z")

    before = datetime(2029, 1, 1, tzinfo=timezone.utc)
    after = datetime(2031, 1, 1, tzinfo=timezone.utc)
    assert can_submit(endorsee, category, now=before) is True
    assert can_submit(endorsee, category, now=after) is False


def test_can_submit_is_false_for_a_category_that_was_not_endorsed():
    endorsee, endorsed = _did(), _category()
    _endorse(endorsee, endorsed)

    assert can_submit(endorsee, _category()) is False


def test_can_submit_is_false_for_another_did():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category)

    assert can_submit(_did(), category) is False


def test_can_submit_answers_false_for_junk_arguments():
    endorsee, category = _did(), _category()
    _endorse(endorsee, category)

    assert can_submit(None, category) is False
    assert can_submit(endorsee, None) is False
    assert can_submit("", category) is False
    assert can_submit(endorsee, "") is False
    assert can_submit(123, category) is False


def test_active_endorsements_omits_expired_rows():
    endorsee, active, expired = _did(), _category(), _category()
    _endorse(endorsee, active)
    _endorse(endorsee, expired, expires_at="2000-01-02T03:04:05Z")

    rows = active_endorsements(endorsee)

    assert [row.category for row in rows] == [active]
    assert rows[0].record_cid


# --------------------------------------------------------------------------- #
# GET /v1/me/endorsements
# --------------------------------------------------------------------------- #


def test_listing_requires_authentication(client):
    response = client.get(URL)

    assert response.status_code == 401, response.text
    assert response.headers["content-type"].startswith("application/problem+json")


def test_listing_is_empty_for_an_unendorsed_account(client):
    response = client.get(URL, headers=_headers(_did()))

    assert response.status_code == 200, response.text
    assert response.json() == []


def test_listing_returns_active_endorsements_with_their_expiry(client):
    endorsee, expiring, perpetual = _did(), _category(), _category()
    expired = _category()
    _endorse(endorsee, expiring, expires_at="2099-01-02T03:04:05Z")
    _endorse(endorsee, perpetual)
    _endorse(endorsee, expired, expires_at="2000-01-02T03:04:05Z")

    response = client.get(URL, headers=_headers(endorsee))

    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, list)
    by_category = {item["category"]: item for item in body}
    assert set(by_category) == {expiring, perpetual}

    expiring_item = by_category[expiring]
    assert expiring_item["endorsee_did"] == endorsee
    assert expiring_item["expires_at"] == "2099-01-02T03:04:05Z"
    assert expiring_item["expiry"] == "2099-01-02T03:04:05Z"

    assert by_category[perpetual]["expires_at"] is None
    assert by_category[perpetual]["expiry"] is None


def test_listing_only_shows_the_callers_own_endorsements(client):
    me, someone_else = _did(), _did()
    mine, theirs = _category(), _category()
    _endorse(me, mine)
    _endorse(someone_else, theirs)

    response = client.get(URL, headers=_headers(me))

    assert response.status_code == 200, response.text
    assert [item["category"] for item in response.json()] == [mine]


@pytest.mark.parametrize("tier", [0, 1, 2, 3, 4])
def test_any_tier_may_read_its_own_listing(client, tier):
    endorsee, category = _did(), _category()
    _endorse(endorsee, category)

    response = client.get(URL, headers=_headers(endorsee, tier=tier))

    assert response.status_code == 200, response.text
    assert [item["category"] for item in response.json()] == [category]
