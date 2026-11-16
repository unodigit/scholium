"""Feature 84: a ledger subscription saves the recomputed status to ``papers.status``.

The papers and versions are put in place below the HTTP layer (the submissions
plugin's own ``save_paper`` / ``save_version``), the records the feature reacts
to are appended with ``ledger.append``, and the saved value is read straight
from the ``papers`` row.  Nothing here calls the status plugin to save a status:
whatever the row holds has to come from the subscription.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger, status
from app.modules.submissions import (
    Paper,
    VersionAuthor,
    save_paper,
    save_version,
)

_clock = itertools.count()
_BASE = datetime(2026, 11, 1, tzinfo=timezone.utc)
_RUBRIC = ("soundness", "evidence", "reproducibility", "novelty", "clarity", "limitations")


@pytest.fixture(autouse=True)
def subscribed():
    """Exactly this plugin's subscription, whatever other tests did to the registry."""
    status.uninstall()
    status.install()
    yield
    status.uninstall()
    status.install()


def _sign(key: SigningKey, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
    # Strictly increasing ``created`` so "the newest decision" is well defined.
    created = (_BASE + timedelta(seconds=next(_clock))).strftime("%Y-%m-%dT%H:%M:%SZ")
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(key),
            "created": created,
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        key,
    )


class Scene:
    """A paper with ``versions`` versions in the ``papers`` / ``paper_versions`` tables."""

    def __init__(self, versions: int = 1) -> None:
        self.tag = uuid.uuid4().hex
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        genesis = _sign(
            self.key,
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Status paper {self.tag}",
                "abstract": "A paper.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        ledger.append(genesis)
        save_paper(paper_cid=genesis["id"], categories=("cs.CR",), licence="CC-BY-4.0")
        self.paper_cid = genesis["id"]
        self.short_id = derive_short_id(self.paper_cid)
        self.versions: list[str] = []
        prev = self.paper_cid
        for n in range(1, versions + 1):
            version = _sign(
                self.key,
                "paper.version",
                {
                    "paper": self.paper_cid,
                    "n": n,
                    "title": f"v{n} {self.tag}",
                    "abstract": "What changed.",
                    "authors": [{"did": self.did, "position": 1}],
                    "manifest": "bafyreimanifest",
                    "licence": "CC-BY-4.0",
                },
                prev=prev,
            )
            ledger.append(version)
            save_version(
                version_cid=version["id"],
                paper_cid=self.paper_cid,
                n=n,
                title=f"v{n} {self.tag}",
                abstract="What changed.",
                manifest_cid="bafyreimanifest",
                licence="CC-BY-4.0",
                prev_cid=prev,
                change_note=None,
                authors=(VersionAuthor(self.did, 1, ()),),
            )
            self.versions.append(version["id"])
            prev = version["id"]

    @property
    def saved(self) -> str:
        """``papers.status`` as the database holds it."""
        with db.SessionLocal() as session:
            return session.get(Paper, self.paper_cid).status

    def review(
        self,
        recommendation: str = "minor_revisions",
        *,
        target: Optional[str] = None,
        paper: bool = True,
        reviewer: Optional[SigningKey] = None,
    ) -> dict:
        body = {
            "target": target or self.versions[-1],
            "scores": {name: 4 for name in _RUBRIC},
            "confidence": 4,
            "recommendation": recommendation,
        }
        if paper:
            body["paper"] = self.paper_cid
        record = _sign(reviewer or SigningKey.generate(), "review.formal", body)
        ledger.append(record)
        return record

    def commit(self) -> dict:
        record = _sign(
            SigningKey.generate(),
            "review.commit",
            {"target": self.versions[-1], "nullifier": uuid.uuid4().hex},
        )
        ledger.append(record)
        return record

    def notice(self, kind: str, target: Optional[str] = None) -> dict:
        record = _sign(
            self.key, kind, {"target": target or self.paper_cid, "reason": f"A {kind}."}
        )
        ledger.append(record)
        return record

    def moderate(self, action: str, target: Optional[str] = None) -> dict:
        record = _sign(
            SigningKey.generate(),
            "moderation.decision",
            {"target": target or self.versions[-1], "action": action, "clause": "MOD-01"},
        )
        ledger.append(record)
        return record


# --------------------------------------------------------------------------- #
# The subscription
# --------------------------------------------------------------------------- #


def test_subscribes_to_exactly_the_records_a_status_is_computed_from():
    status.uninstall()
    for record_type in ledger.subscribed_types():
        assert status.on_status_record not in ledger.service._subscribers.get(record_type, [])

    status.install()

    # Other plugins subscribe to some of the same record types (reviews opens
    # every ``review.formal``), so assert where *this* handler is installed,
    # not how many types the registry gained.
    subscribed = {
        record_type
        for record_type, callbacks in ledger.service._subscribers.items()
        if status.on_status_record in callbacks
    }
    assert subscribed == set(status.STATUS_RECORD_TYPES)
    for record_type in ("ai.review", "withdrawal", "discussion.post", "paper.version"):
        assert status.on_status_record not in ledger.service._subscribers.get(record_type, [])


def test_install_is_idempotent():
    status.install()
    status.install()
    for record_type in status.STATUS_RECORD_TYPES:
        assert ledger.subscriber_count(record_type) >= 1
        assert ledger.service._subscribers[record_type].count(status.on_status_record) == 1


def test_on_startup_reinstalls_a_cleared_subscription():
    status.uninstall()
    assert status.on_status_record not in ledger.service._subscribers.get("retraction", [])

    status.on_startup()

    assert status.on_status_record in ledger.service._subscribers["retraction"]


# --------------------------------------------------------------------------- #
# What gets saved to papers.status
# --------------------------------------------------------------------------- #


def test_a_new_paper_starts_as_preprint():
    assert Scene().saved == "preprint"


def test_each_appended_record_recomputes_and_saves_the_status():
    paper = Scene()

    paper.commit()
    assert paper.saved == "under_review"

    paper.review("minor_revisions")
    assert paper.saved == "under_review"  # one reviewer is not enough

    paper.review("minor_revisions")
    assert paper.saved == "reviewed"

    paper.notice("correction")
    assert paper.saved == "corrected"

    paper.notice("retraction")
    assert paper.saved == "retracted"


def test_a_rejecting_review_makes_the_paper_contested():
    paper = Scene()
    paper.review("minor_revisions")
    paper.review("reject")

    assert paper.saved == "contested"


def test_a_moderation_hold_contests_the_paper_until_it_is_lifted():
    paper = Scene(versions=2)

    paper.moderate("hold", paper.versions[1])
    assert paper.saved == "contested"

    paper.moderate("list", paper.versions[1])
    assert paper.saved == "preprint"


def test_a_notice_naming_a_version_is_saved_on_the_paper():
    paper = Scene(versions=2)

    paper.notice("retraction", target=paper.versions[0])

    assert paper.saved == "retracted"


def test_a_review_that_names_only_its_target_still_belongs_to_the_paper():
    paper = Scene()

    paper.review("minor_revisions", paper=False)
    paper.review("minor_revisions", paper=False)

    assert paper.saved == "reviewed"


def test_a_review_of_an_older_version_counts_for_the_paper():
    paper = Scene(versions=2)

    paper.review("minor_revisions", target=paper.versions[0])
    paper.review("minor_revisions", target=paper.versions[1])

    assert paper.saved == "reviewed"


def test_a_record_changes_only_its_own_papers_status():
    retracted, reviewed, untouched = Scene(), Scene(), Scene()

    retracted.notice("retraction")
    reviewed.review()
    reviewed.review()

    assert retracted.saved == "retracted"
    assert reviewed.saved == "reviewed"
    assert untouched.saved == "preprint"


def test_a_notice_for_another_paper_is_not_counted():
    mine, other = Scene(), Scene()
    other.notice("retraction")

    review = mine.review()

    assert mine.saved == "under_review"
    assert [r.id for r in status.paper_records(mine.paper_cid)] == [review["id"]]


def test_a_review_whose_target_belongs_to_another_paper_is_not_counted_for_the_named_one():
    mine, other = Scene(), Scene()

    # Names ``mine`` as its paper but targets a version of ``other``.
    stray = _sign(
        SigningKey.generate(),
        "review.formal",
        {
            "target": other.versions[0],
            "paper": mine.paper_cid,
            "scores": {name: 4 for name in _RUBRIC},
            "confidence": 4,
            "recommendation": "reject",
        },
    )
    ledger.append(stray)

    assert other.saved == "contested"
    assert mine.saved == "preprint"


# --------------------------------------------------------------------------- #
# What does not recompute
# --------------------------------------------------------------------------- #


def test_a_record_for_a_paper_this_node_does_not_hold_changes_nothing():
    paper = Scene()
    stray = _sign(
        SigningKey.generate(),
        "retraction",
        {"target": "bafyreinotheld", "reason": "Not ours."},
    )

    ledger.append(stray)  # must not raise

    assert paper.saved == "preprint"


def test_a_record_with_no_usable_body_is_ignored():
    # ``on_status_record`` is called by the ledger with whatever was appended.
    class Entry:
        record_type = "review.formal"
        record_cid = "bafyreiodd"
        body = {"target": 42, "paper": ["not", "a", "cid"]}

    status.on_status_record(Entry())  # must not raise


def test_withdrawal_is_not_a_status_change():
    paper = Scene()
    paper.notice("withdrawal")

    assert paper.saved == "preprint"


def test_the_status_is_saved_only_when_it_changes():
    paper = Scene()
    paper.notice("retraction")
    assert paper.saved == "retracted"

    result = status.recompute_paper_status(paper.paper_cid)

    assert result is not None and result.status == "retracted"
    assert paper.saved == "retracted"


def test_recomputing_an_unknown_paper_returns_none():
    assert status.recompute_paper_status("bafyreiunknown") is None


def test_recompute_repairs_a_status_a_failed_handler_left_stale():
    paper = Scene()
    status.uninstall()  # the subscription "missed" these records
    paper.review()
    paper.review()
    assert paper.saved == "preprint"

    status.install()
    result = status.recompute_paper_status(paper.paper_cid)

    assert result.status == "reviewed"
    assert paper.saved == "reviewed"


def test_paper_records_returns_the_papers_status_records_oldest_first():
    paper = Scene(versions=2)
    first = paper.review("minor_revisions", target=paper.versions[0])
    second = paper.notice("correction", target=paper.versions[1])

    records = status.paper_records(paper.paper_cid)

    assert [r.id for r in records] == [first["id"], second["id"]]
