"""The declaration and the signature a reviewer signed (plugin: reviews).

The review form puts two things on a signed ``review.formal`` that the listing
must carry to the Reviews tab:

* ``aiAssisted`` -- the reviewer's declaration "I used AI assistance in writing
  this review".  It is not named by the record schema (which allows extra
  properties), but it is part of the signed body, so a node that keeps the
  review can serve it once revealed.
* ``signed: true`` -- public credit.  The review row already stores the
  caller's DID in ``signed_by``; the listing must also name the reviewer (their
  public profile name, or no name when the profile is erased) so the card can
  say *Signed by …* and link to ``/u/{did}`` instead of calling every card
  anonymous.

Neither may change an anonymous review: it keeps its ``Reviewer A`` label, no
``signed_by`` and no name.

The paper and reviewer helpers are ``test_review_reveal``'s, and every test
makes its own keys, DIDs and paper, so nothing is shared through the worker's
database.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules import reviews
from app.modules.profiles.service import ProfileData, erase_profile, save_profile
from app.modules.reviews import get_review

from .test_review_reveal import (
    REVEAL_URL,
    REVEAL_TYPE,
    Paper,
    Reviewer,
    _sign,
    discard_reveal_gate_shadows,
)
from .test_review_update import listed_reviews, publish_version, update_body

client = TestClient(app)

PROFILE = ProfileData(
    name="Ada Lovelace",
    affiliation="Analytical Engines",
    email="ada@example.org",
)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back (other suites clear them)."""
    reviews._install_ledger_subscriber()


def _reveal(reviewer: Reviewer, paper: Paper, body: dict) -> tuple[dict, dict]:
    """Commit and reveal ``body``; return the commit and the reveal answer.

    The reveal gate is opened by ``post_commit`` and the extra commit it added
    is discarded afterwards, so the listing has only the review under test.
    """
    commit = reviewer.post_commit(paper, body)
    response = reviewer.post_reveal(paper, body)
    assert response.status_code == 201, response.text
    discard_reveal_gate_shadows(paper.version_cid)
    return commit, response.json()


def _signed_body(reviewer: Reviewer, paper: Paper) -> dict:
    body = reviewer.rubric(paper)
    body["signed"] = True
    return body


# --------------------------------------------------------------------------- #
# AI-assistance declaration
# --------------------------------------------------------------------------- #


def test_the_listing_serves_the_ai_assistance_declaration():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["aiAssisted"] = True
    commit, _ = _reveal(reviewer, paper, body)

    [item] = listed_reviews(paper)

    assert item["review_cid"] == commit["id"]
    assert item["ai_assisted"] is True
    assert item["aiAssisted"] is True


def test_the_review_row_keeps_the_declaration():
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    body["aiAssisted"] = True
    commit, _ = _reveal(reviewer, paper, body)

    assert get_review(commit["id"]).ai_assisted is True


def test_an_undisclosed_review_is_not_marked_as_ai_assisted():
    reviewer, paper = Reviewer(), Paper()
    commit, _ = _reveal(reviewer, paper, reviewer.rubric(paper))

    [item] = listed_reviews(paper)

    assert item["review_cid"] == commit["id"]
    assert item["ai_assisted"] is False
    assert get_review(commit["id"]).ai_assisted is False


def test_an_update_carries_its_own_declaration():
    """An update writes no row; its declaration is read from its record."""
    reviewer, paper = Reviewer(), Paper()
    _, first = _reveal(reviewer, paper, reviewer.rubric(paper))
    v2 = publish_version(paper, 2)
    body = update_body(reviewer, paper, v2)
    body["aiAssisted"] = True
    update = _sign(
        reviewer.review_key(paper), REVEAL_TYPE, body, prev=first["id"]
    )

    response = client.post(REVEAL_URL, json=update, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    discard_reveal_gate_shadows(v2)

    [item] = listed_reviews(paper)

    assert item["version"] == 2
    assert item["ai_assisted"] is True


# --------------------------------------------------------------------------- #
# A signed review's name
# --------------------------------------------------------------------------- #


def test_the_listing_serves_the_signed_reviewers_public_name():
    reviewer, paper = Reviewer(), Paper()
    save_profile(reviewer.did, PROFILE)
    _reveal(reviewer, paper, _signed_body(reviewer, paper))

    [item] = listed_reviews(paper)

    assert item["signed_by"] == reviewer.did
    assert item["signed_by_name"] == "Ada Lovelace"
    assert item["signedByName"] == "Ada Lovelace"
    # The anonymous label is unchanged: the name is served beside it.
    assert item["label"] == "Reviewer A"


def test_an_erased_profile_leaves_the_signed_review_without_a_name():
    reviewer, paper = Reviewer(), Paper()
    save_profile(reviewer.did, PROFILE)
    erase_profile(reviewer.did)
    _reveal(reviewer, paper, _signed_body(reviewer, paper))

    [item] = listed_reviews(paper)

    # The signature stands (public credit), but erasure leaves only the DID.
    assert item["signed_by"] == reviewer.did
    assert item["signed_by_name"] is None
    assert item["signedByName"] is None


def test_an_unsigned_review_serves_no_signature_and_no_name():
    reviewer, paper = Reviewer(), Paper()
    save_profile(reviewer.did, PROFILE)
    _reveal(reviewer, paper, reviewer.rubric(paper))

    [item] = listed_reviews(paper)

    assert item["signed_by"] is None
    assert item["signed_by_name"] is None
    assert item["label"] == "Reviewer A"
