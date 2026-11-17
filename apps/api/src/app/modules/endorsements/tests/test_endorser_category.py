"""An endorser may only endorse in a category they are themself endorsed in.

Bug: the API accepted an ``endorsement`` record from any tier-3 author in *any*
category, so the profile's Endorse dropdown offered every category.  An
endorsement vouches that someone may submit in a category; a Reviewer who holds
no standing in that category has nothing to vouch with.  The rule is:

* tier 3 (Reviewer): only categories the endorser holds an *active*
  endorsement in -- anything else is refused with ``403`` and a problem naming
  the category, before the ledger append;
* tier 4 (Moderator): any category.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from app.modules import ledger
from app.modules.endorsements import save_endorsement

from .test_endorsements import PROBLEM_JSON, URL, Author, _body, _make_account, _stored, _tier_of

CATEGORY_NOT_ENDORSED = "urn:scholium:problem:category-not-endorsed"


def _fresh_did() -> str:
    return did_key_from_signing_key(SigningKey.generate())


def _grant_standing(endorser: Author, category: str, *, expires_at=None) -> None:
    """Give ``endorser`` an endorsement in ``category``, as a third party would."""
    save_endorsement(
        record_cid=f"cid-{uuid.uuid4().hex}",
        endorser_did=_fresh_did(),
        endorsee_did=endorser.did,
        category=category,
        expires_at=expires_at,
    )


def _reviewer(*categories: str) -> Author:
    reviewer = Author(tier=3)
    _make_account(reviewer.did, tier=3)
    for category in categories:
        _grant_standing(reviewer, category)
    return reviewer


def test_a_reviewer_without_standing_in_the_category_is_refused(client):
    endorser = _reviewer("cs.AI")
    endorsee = _fresh_did()
    record = endorser.record(_body(endorsee=endorsee, category="cs.LG"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    problem = response.json()
    assert problem["status"] == 403
    assert problem["type"] == CATEGORY_NOT_ENDORSED
    assert "cs.LG" in problem["detail"]
    assert "endorsed" in problem["detail"]

    # Refused before the ledger append: nothing stored, nothing granted.
    assert _stored(record["id"]) is None
    assert ledger.entry_by_cid(record["id"]) is None
    assert _tier_of(endorsee) is None


def test_a_reviewer_with_no_endorsements_at_all_is_refused_everywhere(client):
    endorser = _reviewer()
    record = endorser.record(_body(category="cs.AI"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text
    assert response.json()["type"] == CATEGORY_NOT_ENDORSED


def test_a_reviewer_may_endorse_in_a_category_they_are_endorsed_in(client):
    endorser = _reviewer("cs.AI", "cs.MA")
    endorsee = _fresh_did()
    record = endorser.record(_body(endorsee=endorsee, category="cs.MA"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    assert _stored(record["id"]) is not None
    assert _tier_of(endorsee) == 2


def test_an_expired_endorsement_gives_a_reviewer_no_standing(client):
    endorser = Author(tier=3)
    _make_account(endorser.did, tier=3)
    lapsed = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    _grant_standing(endorser, "cs.AI", expires_at=lapsed)
    record = endorser.record(_body(category="cs.AI"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text
    assert response.json()["type"] == CATEGORY_NOT_ENDORSED


def test_a_moderator_may_endorse_in_any_category(client):
    endorser = Author(tier=4)
    _make_account(endorser.did, tier=4)
    endorsee = _fresh_did()
    record = endorser.record(_body(endorsee=endorsee, category="math.NT"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 201, response.text
    assert _tier_of(endorsee) == 2


def test_the_endorsers_tier_is_still_checked_before_the_category(client):
    endorser = Author(tier=2)
    _make_account(endorser.did, tier=2)
    _grant_standing(endorser, "cs.AI")
    record = endorser.record(_body(category="cs.AI"))

    response = client.post(URL, json=record, headers=endorser.headers)

    assert response.status_code == 403, response.text
    assert response.json()["type"] == "urn:scholium:problem:insufficient-tier"
