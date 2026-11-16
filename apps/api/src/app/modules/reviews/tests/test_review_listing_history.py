"""Tests for the earlier-version reviews the listing carries (plugin: reviews).

``GET /v1/papers/{id}/reviews`` lists the reviews of one version.  A reviewer
who revealed a review against an earlier version and has not revised it yet is
still one of that paper's reviewers: the listing of the latest version carries
their newest revealed review, marked with the version it targets, so the
reviews tab can show it and offer them *Update for v{latest}*.

What stays as it was (REV-4 and the escrow): an earlier review is carried only
once it is revealed, it keeps the anonymous label it had, nothing that names
the reviewer is served, and carrying it does not open the report gate of the
version being listed.

The paper, the reviewers and the signing helpers are the ones
``test_review_update`` and ``test_review_reveal`` build; as there, every test
makes its own keys and paper.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from scholium_record_core import did_key_from_signing_key

from app import db
from app.modules import reviews
from app.modules.reviews.models import Review

from .test_review_reveal import (
    Paper,
    Reviewer,
    discard_reveal_gate_shadows,
)
from .test_review_update import (
    client,
    commit_on,
    history_of,
    listed_reviews,
    listing_url,
    post_update,
    publish_version,
    revealed_review,
    update_record,
)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back (other suites clear them)."""
    reviews._install_ledger_subscriber()


def date_commit(commit_cid: str, minutes: int) -> None:
    """Date a commit ``minutes`` into a fixed hour, so label order is not a coin toss.

    Records are dated to the second, so two commits made together would take
    either order.  The base is in the past but within the 21 days that would
    open a report gate by itself.
    """
    base = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
    with db.SessionLocal() as session:
        session.query(Review).filter(Review.review_cid == commit_cid).update(
            {"committed_at": base + timedelta(minutes=minutes)}
        )
        session.commit()


def labels_by_review(paper: Paper, version: Optional[int] = None) -> dict[str, str]:
    return {item["review_cid"]: item["label"] for item in listed_reviews(paper, version)}


# --------------------------------------------------------------------------- #
# The latest version's listing carries the reviewer's earlier, revealed review
# --------------------------------------------------------------------------- #


def test_the_latest_listing_carries_a_revealed_review_of_an_earlier_version():
    reviewer, paper = Reviewer(), Paper()
    commit, first = revealed_review(reviewer, paper)
    v2 = publish_version(paper, 2, open_gate=False)

    listing = client.get(listing_url(paper)).json()

    assert listing["version_cid"] == v2 and listing["version"] == 2
    [item] = listing["reviews"]
    assert item["review_cid"] == commit["id"]
    assert item["label"] == "Reviewer A"
    # Marked with the version it targets: v1, not the listing's v2.
    assert item["version"] == 1
    assert item["version_cid"] == item["versionCid"] == paper.version_cid
    assert item["id"] == item["formal_cid"] == item["reveal_cid"] == first["id"]
    assert history_of(item) == [first["id"]]
    assert item["recommendation"] == "minor_revisions"
    assert {s["score"] for s in item["scores"].values()} == {4}
    assert item["revealed_at"] is not None


def test_the_carried_review_is_the_reviewers_newest_one():
    reviewer, paper = Reviewer(), Paper()
    commit, first = revealed_review(reviewer, paper)
    v2 = publish_version(paper, 2)
    update = update_record(reviewer, paper, v2, first["id"], score=2, recommendation="major_concerns")
    assert post_update(reviewer, update).status_code == 201
    v3 = publish_version(paper, 3, open_gate=False)

    listing = client.get(listing_url(paper)).json()

    assert listing["version_cid"] == v3
    [item] = listing["reviews"]
    # Their v2 update stands, and the v1 review is still in the history.
    assert item["version"] == 2 and item["version_cid"] == v2
    assert item["id"] == update["id"]
    assert item["recommendation"] == "major_concerns"
    assert history_of(item) == [first["id"], update["id"]]


def test_an_earlier_review_that_is_still_sealed_is_not_carried():
    reviewer, paper = Reviewer(), Paper()
    commit = reviewer.post_commit(paper, reviewer.rubric(paper))
    discard_reveal_gate_shadows(paper.version_cid)
    publish_version(paper, 2, open_gate=False)

    # It is listed, sealed, on its own version ...
    assert [item["review_cid"] for item in listed_reviews(paper, version=1)] == [commit["id"]]
    # ... and not on the latest, where nothing has been revealed.
    response = client.get(listing_url(paper))
    assert response.json()["reviews"] == []
    assert commit["id"] not in response.text


def test_a_review_of_the_latest_version_is_listed_beside_the_carried_one():
    paper, earlier, newcomer = Paper(), Reviewer(), Reviewer()
    commit, first = revealed_review(earlier, paper)
    v2 = publish_version(paper, 2)
    body = newcomer.rubric(paper)
    body["target"] = v2
    newcomer_commit = commit_on(newcomer, paper, v2, body)
    discard_reveal_gate_shadows(v2)
    date_commit(commit["id"], 0)
    date_commit(newcomer_commit["id"], 1)

    items = {item["review_cid"]: item for item in listed_reviews(paper)}

    assert set(items) == {commit["id"], newcomer_commit["id"]}
    assert items[commit["id"]]["version"] == 1
    assert items[commit["id"]]["label"] == "Reviewer A"
    assert items[newcomer_commit["id"]]["version"] == 2
    assert items[newcomer_commit["id"]]["label"] == "Reviewer B"


def test_the_listing_of_an_earlier_version_is_unchanged():
    paper, earlier, newcomer = Paper(), Reviewer(), Reviewer()
    commit, first = revealed_review(earlier, paper)
    v2 = publish_version(paper, 2)
    body = newcomer.rubric(paper)
    body["target"] = v2
    newcomer_commit = commit_on(newcomer, paper, v2, body)
    discard_reveal_gate_shadows(v2)

    # v1 lists v1's review and nothing of what happened on v2.
    [item] = listed_reviews(paper, version=1)

    assert item["review_cid"] == commit["id"]
    assert item["version"] == 1
    assert newcomer_commit["id"] not in client.get(listing_url(paper, 1)).text


# --------------------------------------------------------------------------- #
# Anonymity (REV-4 and the escrow) is as it was
# --------------------------------------------------------------------------- #


def test_a_carried_review_keeps_the_label_it_had_on_its_own_version():
    paper, sealed, revealed = Paper(), Reviewer(), Reviewer()
    # The first to commit never reveals; the second does, so on v1 they are B.
    sealed_commit = sealed.post_commit(paper, sealed.rubric(paper))
    revealed_body = revealed.rubric(paper, score=3)
    revealed_commit = revealed.post_commit(paper, revealed_body)
    date_commit(sealed_commit["id"], 0)
    date_commit(revealed_commit["id"], 1)
    assert revealed.post_reveal(paper, revealed_body).status_code == 201
    discard_reveal_gate_shadows(paper.version_cid)
    publish_version(paper, 2, open_gate=False)
    assert labels_by_review(paper, version=1) == {
        sealed_commit["id"]: "Reviewer A",
        revealed_commit["id"]: "Reviewer B",
    }

    # Only the revealed review is carried, and it is still Reviewer B: the
    # label follows the paper's commit order, not who the listing happens to show.
    assert labels_by_review(paper) == {revealed_commit["id"]: "Reviewer B"}


def test_carried_reviews_do_not_open_the_report_gate_of_the_latest_version():
    paper, first_reviewer, second_reviewer = Paper(), Reviewer(), Reviewer()
    first_commit, first = revealed_review(first_reviewer, paper)
    second_commit, second = revealed_review(second_reviewer, paper)
    publish_version(paper, 2, open_gate=False)
    # On v1 two reviewers are committed: its reports are served.
    on_v1 = client.get(listing_url(paper, 1)).json()
    assert on_v1["gate_open"] is True
    assert first["body"]["report"] in client.get(listing_url(paper, 1)).text

    listing = client.get(listing_url(paper)).json()

    # Nothing is committed on v2, so its reports stay sealed (REV-4): the two
    # carried reviews are listed with their scores, but no report body.
    assert {item["review_cid"] for item in listing["reviews"]} == {
        first_commit["id"],
        second_commit["id"],
    }
    assert listing["gate_open"] is False
    for item in listing["reviews"]:
        assert "report" not in item
        assert all("report" not in entry for entry in item["history"])
    assert first["body"]["report"] not in client.get(listing_url(paper)).text


def test_a_carried_review_names_no_one():
    reviewer, paper = Reviewer(), Paper()
    commit, first = revealed_review(reviewer, paper)
    publish_version(paper, 2, open_gate=False)

    response = client.get(listing_url(paper))
    [item] = response.json()["reviews"]

    assert item["signed_by"] is None
    assert reviewer.did not in response.text
    assert did_key_from_signing_key(reviewer.review_key(paper)) not in response.text
    assert reviewer.nullifier(paper) not in response.text
