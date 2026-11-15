"""compute_status: deterministic paper status from moderation, review and notice records.

Feature 83.  The function is pure, so these tests build record envelopes by
hand: no database, no app, no signatures (``compute_status`` takes records the
node has already accepted).
"""

from __future__ import annotations

import copy
import itertools
import pkgutil
import random

import pytest
from pydantic import BaseModel

from app.modules import status as status_module
from app.modules.status import (
    InvalidRecordError,
    RULES,
    STATUSES,
    STATUS_PRECEDENCE,
    STATUS_RECORD_TYPES,
    StatusResult,
    compute_status,
    explain_status,
)

PAPER = "bafyreigenesis"
V1 = "bafyreiversion1"
V2 = "bafyreiversion2"

_ids = itertools.count(1)


def at(minute: int, hour: int = 5) -> str:
    return f"2026-11-14T{hour:02d}:{minute:02d}:00Z"


def rec(kind, body=None, *, id=None, author="did:key:zSomeone", created=None, prev=None):
    """A record envelope; ``id`` defaults to a unique placeholder."""
    return {
        "v": 1,
        "type": kind,
        "author": author,
        "created": created or at(0),
        "prev": prev,
        "body": body if body is not None else {},
        "proofs": [],
        "id": id or f"rec-{next(_ids)}",
    }


def commit(reviewer="did:key:zRevA", **kw):
    return rec("review.commit", {"target": V1, "commitment": "ab" * 16}, author=reviewer, **kw)


def review(recommendation, reviewer="did:key:zRevA", target=V1, **kw):
    body = {"target": target, "scores": {}, "confidence": 3}
    if recommendation is not None:
        body["recommendation"] = recommendation
    return rec("review.formal", body, author=reviewer, **kw)


def two_reviews(first="minor_revisions", second="minor_revisions"):
    return [review(first, "did:key:zRevA"), review(second, "did:key:zRevB")]


def moderation(action, target=V1, *, clause="MOD-07", **kw):
    return rec(
        "moderation.decision",
        {"target": target, "action": action, "clause": clause, "reasonCid": "bafyreireason"},
        author="did:key:zModerator",
        **kw,
    )


def notice(kind, target=PAPER, **kw):
    return rec(kind, {"target": target, "reason": "because"}, author="did:key:zAuthor", **kw)


def ai_review(**body):
    base = {"target": V1, "agents": ["methodology"], "models": ["m@1"], "findingsCid": "bafyreif"}
    return rec("ai.review", {**base, **body}, author="did:key:zNode")


# --------------------------------------------------------------------------- #
# The six statuses, one rule each
# --------------------------------------------------------------------------- #


def test_no_records_is_a_preprint():
    assert compute_status([]) == "preprint"


def test_paper_records_alone_are_a_preprint():
    records = [
        rec("paper.genesis", {"seed": "x"}, id=PAPER),
        rec("paper.version", {"paper": PAPER, "n": 1}, id=V1, prev=PAPER),
        rec("coauthor.consent", {"version": V1, "decision": "accept"}),
        moderation("list"),
    ]
    assert compute_status(records) == "preprint"


def test_sealed_review_commits_are_under_review():
    assert compute_status([commit("did:key:zRevA")]) == "under_review"
    assert compute_status([commit("did:key:zRevA"), commit("did:key:zRevB")]) == "under_review"


def test_two_revealed_minor_revision_reviews_are_reviewed():
    # The acceptance scenario of feature 84.
    assert compute_status(two_reviews("minor_revisions", "minor_revisions")) == "reviewed"


def test_reviewed_with_commits_and_reveals_together():
    records = [commit("did:key:zRevA"), commit("did:key:zRevB"), *two_reviews()]
    assert compute_status(records) == "reviewed"


@pytest.mark.parametrize("first", ["accept", "Sound as is", "minor", "Sound with minor revisions"])
def test_every_supportive_recommendation_counts(first):
    assert compute_status(two_reviews(first, "minor_revisions")) == "reviewed"


@pytest.mark.parametrize("spelling", ["Minor revisions", "minor-revisions", " MINOR_REVISIONS ", "minor.revisions"])
def test_recommendation_spelling_is_normalised(spelling):
    assert compute_status(two_reviews(spelling, spelling)) == "reviewed"


def test_one_revealed_review_is_not_enough_for_reviewed():
    assert compute_status([review("minor_revisions")]) == "under_review"
    assert compute_status([review("accept")]) == "under_review"


def test_a_review_that_asks_for_major_revisions_keeps_the_paper_under_review():
    assert compute_status(two_reviews("minor_revisions", "major_revisions")) == "under_review"
    assert compute_status(two_reviews("major_revisions", "major_concerns")) == "under_review"


@pytest.mark.parametrize("recommendation", [None, "", "maybe", 4, ["minor_revisions"]])
def test_unreadable_recommendation_blocks_reviewed_but_does_not_contest(recommendation):
    records = [review("minor_revisions", "did:key:zRevA"), review(recommendation, "did:key:zRevB")]
    assert compute_status(records) == "under_review"


def test_a_rejecting_review_contests_the_paper():
    assert compute_status([review("reject")]) == "contested"
    assert compute_status([review("Fundamentally flawed")]) == "contested"
    assert compute_status(two_reviews("minor_revisions", "reject")) == "contested"


def test_a_moderation_hold_contests_the_paper():
    assert compute_status([moderation("hold")]) == "contested"


def test_a_correction_marks_the_paper_corrected():
    assert compute_status([notice("correction")]) == "corrected"


def test_a_retraction_marks_the_paper_retracted():
    assert compute_status([notice("retraction")]) == "retracted"


def test_every_status_is_reachable_and_documented():
    reached = {
        compute_status([]),
        compute_status([commit()]),
        compute_status(two_reviews()),
        compute_status([moderation("hold")]),
        compute_status([notice("correction")]),
        compute_status([notice("retraction")]),
    }
    assert reached == set(STATUSES)
    assert STATUSES == (
        "preprint",
        "under_review",
        "reviewed",
        "contested",
        "corrected",
        "retracted",
    )


# --------------------------------------------------------------------------- #
# Precedence
# --------------------------------------------------------------------------- #

EVERYTHING = {
    "retraction": notice("retraction"),
    "hold": moderation("hold"),
    "rejection": review("reject", "did:key:zRevC"),
    "correction": notice("correction"),
}


def test_retraction_outranks_every_other_signal():
    records = [
        EVERYTHING["retraction"],
        EVERYTHING["hold"],
        EVERYTHING["rejection"],
        EVERYTHING["correction"],
        *two_reviews(),
    ]
    assert compute_status(records) == "retracted"
    assert explain_status(records).rule == "retraction"


def test_open_dispute_outranks_a_correction_and_review_standing():
    for dispute in (EVERYTHING["hold"], EVERYTHING["rejection"]):
        records = [dispute, EVERYTHING["correction"], *two_reviews()]
        assert compute_status(records) == "contested"


def test_correction_outranks_review_standing():
    assert compute_status([EVERYTHING["correction"], *two_reviews()]) == "corrected"
    assert compute_status([EVERYTHING["correction"], commit()]) == "corrected"


def test_reviewed_outranks_under_review():
    assert compute_status([commit("did:key:zRevC"), *two_reviews()]) == "reviewed"


def test_precedence_follows_the_documented_order():
    # Peel signals off from the top: each removal falls to the next status.
    layers = [
        ("retracted", [EVERYTHING["retraction"]]),
        ("contested", [EVERYTHING["hold"]]),
        ("corrected", [EVERYTHING["correction"]]),
        ("reviewed", two_reviews()),
        ("under_review", [commit()]),
    ]
    assert tuple(s for s, _ in layers) + ("preprint",) == STATUS_PRECEDENCE
    for start in range(len(layers)):
        records = [r for _, rs in layers[start:] for r in rs]
        assert compute_status(records) == layers[start][0]
    assert compute_status([]) == "preprint"


def test_rules_are_listed_in_the_order_they_are_tried():
    assert RULES == (
        "retraction",
        "moderation_hold",
        "review_rejection",
        "correction",
        "reviews_supportive",
        "review_activity",
        "default",
    )


# --------------------------------------------------------------------------- #
# Reviews: reviewers are counted, not review records
# --------------------------------------------------------------------------- #


def test_a_reviewer_who_updates_replaces_their_earlier_review():
    first = review("major_revisions", "did:key:zRevB", id="b1", created=at(10))
    other = review("minor_revisions", "did:key:zRevA")
    assert compute_status([other, first]) == "under_review"

    update = review("minor_revisions", "did:key:zRevB", target=V2, id="b2", prev="b1", created=at(20))
    assert compute_status([other, first, update]) == "reviewed"


def test_the_journey_after_v2_the_reviewer_who_updates_flips_the_status():
    # v1 reviewed by A (minor) and B (major); v2 posted; B updates against v2.
    # A's v1 review still stands: reviews count whichever version they target.
    a = review("minor_revisions", "did:key:zRevA", id="a1", created=at(10))
    b = review("major_revisions", "did:key:zRevB", id="b1", created=at(11))
    v2 = rec("paper.version", {"paper": PAPER, "n": 2}, id=V2, prev=V1, created=at(30))
    assert compute_status([a, b, v2]) == "under_review"
    b2 = review("minor_revisions", "did:key:zRevB", target=V2, id="b2", prev="b1", created=at(40))
    assert compute_status([a, b, v2, b2]) == "reviewed"


def test_a_rejecting_review_stops_contesting_once_its_reviewer_updates():
    a = review("minor_revisions", "did:key:zRevA")
    b = review("reject", "did:key:zRevB", id="b1", created=at(10))
    assert compute_status([a, b]) == "contested"
    b2 = review("minor_revisions", "did:key:zRevB", id="b2", prev="b1", created=at(20))
    assert compute_status([a, b, b2]) == "reviewed"


def test_prev_decides_which_review_is_current_not_the_clock():
    # The update carries an earlier ``created`` (clock skew); ``prev`` wins.
    old = review("reject", "did:key:zRevB", id="b1", created=at(30))
    new = review("minor_revisions", "did:key:zRevB", id="b2", prev="b1", created=at(5))
    assert compute_status([review("accept", "did:key:zRevA"), old, new]) == "reviewed"


def test_one_reviewer_cannot_count_twice():
    twice = [
        review("minor_revisions", "did:key:zRevA", id="a1", created=at(1)),
        review("minor_revisions", "did:key:zRevA", id="a2", created=at(2)),
    ]
    assert compute_status(twice) == "under_review"  # still a single reviewer
    chained = [
        review("minor_revisions", "did:key:zRevA", id="a1", created=at(1)),
        review("minor_revisions", "did:key:zRevA", id="a2", prev="a1", created=at(2)),
    ]
    assert compute_status(chained) == "under_review"


def test_without_prev_a_reviewers_newest_review_is_current():
    records = [
        review("reject", "did:key:zRevA", id="a1", created=at(1)),
        review("minor_revisions", "did:key:zRevA", id="a2", created=at(2)),
        review("minor_revisions", "did:key:zRevB"),
    ]
    assert compute_status(records) == "reviewed"


def test_another_reviewers_prev_cannot_hide_a_review():
    rejection = review("reject", "did:key:zRevA", id="a1")
    forged_update = review("minor_revisions", "did:key:zRevB", id="b1", prev="a1")
    assert compute_status([rejection, forged_update]) == "contested"


def test_an_old_review_that_was_replaced_cannot_contest():
    old = review("reject", "did:key:zRevA", id="a1", created=at(1))
    new = review("accept", "did:key:zRevA", id="a2", prev="a1", created=at(2))
    result = explain_status([old, new, review("accept", "did:key:zRevB", id="b1")])
    assert result.status == "reviewed"
    assert result.evidence == ("a2", "b1")


def test_a_sealed_commit_is_activity_but_never_a_vote():
    assert compute_status([commit("did:key:zRevA"), review("minor_revisions", "did:key:zRevB")]) == "under_review"


def test_review_responses_and_ratings_do_not_count_as_reviews():
    records = [
        rec("review.response", {"review": "a1", "recommendation": "reject"}),
        rec("review.rating", {"review": "a1", "rating": 1}),
        rec("discussion.post", {"target": V1, "recommendation": "reject"}),
    ]
    assert compute_status(records) == "preprint"


# --------------------------------------------------------------------------- #
# Moderation holds
# --------------------------------------------------------------------------- #


def test_a_later_list_decision_lifts_a_hold():
    records = [moderation("hold", created=at(1)), moderation("list", created=at(2))]
    assert compute_status(records) == "preprint"


def test_a_hold_after_a_list_decision_contests_again():
    records = [moderation("list", created=at(1)), moderation("hold", created=at(2))]
    assert compute_status(records) == "contested"


@pytest.mark.parametrize("action", ["list", "reject", "delist", "tombstone", "LIST", " Delist "])
def test_decisions_that_set_state_end_a_hold(action):
    records = [moderation("hold", created=at(1)), moderation(action, created=at(2))]
    assert compute_status(records) == "preprint"


def test_reclassify_neither_starts_nor_ends_a_hold():
    assert compute_status([moderation("reclassify")]) == "preprint"
    records = [moderation("hold", created=at(1)), moderation("reclassify", created=at(2))]
    assert compute_status(records) == "contested"


def test_holds_are_tracked_per_target():
    records = [
        moderation("hold", V1, created=at(1)),
        moderation("list", V2, created=at(2)),  # a different version: does not lift V1
    ]
    assert compute_status(records) == "contested"
    records.append(moderation("list", V1, created=at(3)))
    assert compute_status(records) == "preprint"


def test_a_rejected_or_delisted_decision_alone_changes_no_status():
    for action in ("reject", "delist", "tombstone", "list"):
        assert compute_status([moderation(action)]) == "preprint"
    assert compute_status([moderation("delist"), *two_reviews()]) == "reviewed"


def test_unknown_moderation_actions_are_ignored():
    assert compute_status([moderation("escalate"), rec("moderation.decision", {})]) == "preprint"


def test_decision_times_are_compared_as_instants_not_strings():
    # 10:00+10:00 is 00:00Z, earlier than 01:00Z although it sorts later as text.
    lifted_earlier = [
        moderation("list", created="2026-11-14T10:00:00+10:00"),
        moderation("hold", created="2026-11-14T01:00:00Z"),
    ]
    assert compute_status(lifted_earlier) == "contested"


def test_equal_times_are_broken_by_record_id():
    hold = moderation("hold", id="m-a", created=at(5))
    lift = moderation("list", id="m-b", created=at(5))
    assert compute_status([hold, lift]) == "preprint"
    assert compute_status([lift, hold]) == "preprint"


# --------------------------------------------------------------------------- #
# Notices
# --------------------------------------------------------------------------- #


def test_a_withdrawal_is_a_notice_but_not_a_status():
    assert compute_status([notice("withdrawal")]) == "preprint"
    assert compute_status([notice("withdrawal"), *two_reviews()]) == "reviewed"


def test_a_retraction_or_correction_may_name_a_version():
    assert compute_status([notice("retraction", V1)]) == "retracted"
    assert compute_status([notice("correction", V2)]) == "corrected"


def test_appeals_and_flags_do_not_change_status_by_themselves():
    records = [
        rec("flag", {"target": V1, "reason": "x"}),
        rec("appeal", {"target": "bafyreidecision", "grounds": "x"}),
        rec("appeal.decision", {"target": "bafyreiappeal", "outcome": "upheld"}),
    ]
    assert compute_status(records) == "preprint"


# --------------------------------------------------------------------------- #
# ai.review never matters
# --------------------------------------------------------------------------- #

HOSTILE_AI_REVIEWS = [
    ai_review(),
    ai_review(recommendation="reject", action="hold", verdict="retract"),
    ai_review(recommendation="minor_revisions", status="reviewed", paperStatus="reviewed"),
    ai_review(action="hold", target=PAPER, outcome="retraction", findings=["fabricated"]),
]

BASE_SCENARIOS = {
    "empty": [],
    "commit": [commit()],
    "reviewed": two_reviews(),
    "contested": [moderation("hold")],
    "corrected": [notice("correction")],
    "retracted": [notice("retraction")],
}


def test_ai_review_is_not_a_record_type_the_status_reads():
    assert "ai.review" not in STATUS_RECORD_TYPES
    assert STATUS_RECORD_TYPES == {
        "review.commit",
        "review.formal",
        "moderation.decision",
        "retraction",
        "correction",
    }


def test_ai_review_alone_leaves_a_preprint():
    for ai in HOSTILE_AI_REVIEWS:
        assert compute_status([ai]) == "preprint"
    assert compute_status(HOSTILE_AI_REVIEWS) == "preprint"


@pytest.mark.parametrize("name", sorted(BASE_SCENARIOS))
def test_ai_review_records_never_change_the_status(name):
    base = BASE_SCENARIOS[name]
    expected = explain_status(base)
    assert explain_status([*base, *HOSTILE_AI_REVIEWS]) == expected
    assert explain_status([*HOSTILE_AI_REVIEWS, *base]) == expected


def test_a_hostile_ai_review_cannot_become_evidence():
    ai = ai_review(recommendation="reject")
    result = explain_status([ai, review("accept", "did:key:zRevA"), review("accept", "did:key:zRevB")])
    assert ai["id"] not in result.evidence
    assert result.status == "reviewed"


# --------------------------------------------------------------------------- #
# Determinism
# --------------------------------------------------------------------------- #


def mixed_records():
    return [
        rec("paper.genesis", {"seed": "x"}, id=PAPER),
        moderation("list", created=at(1), id="m1"),
        moderation("hold", created=at(2), id="m2"),
        moderation("list", created=at(3), id="m3"),
        commit("did:key:zRevA", id="c1"),
        review("minor_revisions", "did:key:zRevA", id="a1", created=at(10)),
        review("major_revisions", "did:key:zRevB", id="b1", created=at(11)),
        review("minor_revisions", "did:key:zRevB", id="b2", prev="b1", created=at(20)),
        notice("withdrawal", id="w1"),
        ai_review(recommendation="reject"),
    ]


def test_order_of_records_never_changes_the_result():
    records = mixed_records()
    expected = explain_status(records)
    assert expected.status == "reviewed"
    rng = random.Random(83)
    for _ in range(200):
        shuffled = records[:]
        rng.shuffle(shuffled)
        assert explain_status(shuffled) == expected


def test_every_order_of_a_small_dispute_agrees():
    records = [
        moderation("hold", id="m1", created=at(1)),
        moderation("list", id="m2", created=at(2)),
        moderation("hold", id="m3", created=at(3)),
        review("reject", "did:key:zRevA", id="a1", created=at(1)),
        review("accept", "did:key:zRevA", id="a2", created=at(2)),
    ]
    outcomes = {explain_status(p) for p in itertools.permutations(records)}
    assert outcomes == {StatusResult("contested", "moderation_hold", ("m3",))}


def test_ties_between_records_without_ids_do_not_depend_on_input_order():
    a = rec("moderation.decision", {"target": V1, "action": "hold"}, created=at(1))
    b = rec("moderation.decision", {"target": V1, "action": "list"}, created=at(1))
    for r in (a, b):
        del r["id"]
    assert compute_status([a, b]) == compute_status([b, a])


def test_repeated_calls_agree_and_input_is_not_modified():
    records = mixed_records()
    snapshot = copy.deepcopy(records)
    first = explain_status(records)
    assert [explain_status(records) for _ in range(5)] == [first] * 5
    assert records == snapshot


def test_a_generator_of_records_is_accepted():
    assert compute_status(r for r in two_reviews()) == "reviewed"


def test_the_result_is_always_one_of_the_six_statuses():
    rng = random.Random(1)
    pool = [
        *BASE_SCENARIOS["reviewed"],
        commit(),
        review("reject", "did:key:zRevC"),
        review(None, "did:key:zRevD"),
        moderation("hold"),
        moderation("list"),
        notice("correction"),
        notice("retraction"),
        notice("withdrawal"),
        *HOSTILE_AI_REVIEWS,
    ]
    for _ in range(300):
        sample = rng.sample(pool, rng.randint(0, len(pool)))
        assert compute_status(sample) in STATUSES


# --------------------------------------------------------------------------- #
# explain_status
# --------------------------------------------------------------------------- #


def test_explain_status_names_the_rule_and_the_records_that_decided():
    r1 = notice("retraction", id="x1")
    r2 = notice("retraction", id="x0")
    assert explain_status([r1, r2, *two_reviews()]) == StatusResult("retracted", "retraction", ("x0", "x1"))
    assert explain_status([]) == StatusResult("preprint", "default", ())
    assert explain_status([commit(id="c9")]) == StatusResult("under_review", "review_activity", ("c9",))
    hold = moderation("hold", id="m7")
    assert explain_status([hold]) == StatusResult("contested", "moderation_hold", ("m7",))
    rej = review("reject", id="r7")
    assert explain_status([rej]) == StatusResult("contested", "review_rejection", ("r7",))
    corr = notice("correction", id="k1")
    assert explain_status([corr]) == StatusResult("corrected", "correction", ("k1",))
    revs = two_reviews()
    assert explain_status(revs) == StatusResult(
        "reviewed", "reviews_supportive", tuple(sorted(r["id"] for r in revs))
    )


def test_compute_status_agrees_with_explain_status():
    for records in BASE_SCENARIOS.values():
        assert compute_status(records) == explain_status(records).status


def test_every_rule_id_is_produced_by_some_scenario():
    produced = {explain_status(records).rule for records in BASE_SCENARIOS.values()}
    produced.add(explain_status([review("reject")]).rule)
    produced.add(explain_status([commit()]).rule)
    assert produced == set(RULES)


# --------------------------------------------------------------------------- #
# Input handling
# --------------------------------------------------------------------------- #


def test_malformed_but_mapping_records_never_raise():
    odd = [
        {},
        {"type": None},
        {"type": 5, "body": 5},
        {"type": "review.formal"},
        {"type": "review.formal", "body": "not a mapping", "author": 7, "id": 9, "created": 12},
        {"type": "moderation.decision", "body": {"action": 3, "target": ["x"]}},
        {"type": "retraction", "created": "not a time"},
    ]
    assert compute_status(odd) == "retracted"
    assert compute_status(odd[:-1]) == "under_review"


def test_naive_and_unparseable_timestamps_are_handled():
    records = [
        moderation("hold", created="2026-11-14T05:00:00"),  # naive: read as UTC
        moderation("list", created="2026-11-14T05:00:01Z"),
    ]
    assert compute_status(records) == "preprint"
    records = [moderation("list", created="garbage"), moderation("hold", created=at(1))]
    assert compute_status(records) == "contested"  # unreadable sorts before real times


class _Envelope(BaseModel):
    """Stand-in for the ledger's RecordEnvelope: a model, not a Mapping."""

    v: int = 1
    type: str
    author: str
    created: str
    prev: str | None = None
    body: dict
    proofs: list = []
    id: str


def test_records_may_be_models_with_model_dump():
    records = [_Envelope(**r) for r in two_reviews()]
    assert compute_status(records) == "reviewed"
    assert compute_status([_Envelope(**notice("retraction"))]) == "retracted"


@pytest.mark.parametrize("bad", [None, 5, "records", b"records", {"type": "retraction"}, [None], [5], ["retraction"]])
def test_invalid_records_argument_raises(bad):
    with pytest.raises(InvalidRecordError):
        compute_status(bad)


def test_invalid_records_error_is_a_value_error():
    assert issubclass(InvalidRecordError, ValueError)
    with pytest.raises(ValueError):
        explain_status("not records")


def test_invalid_items_raise_even_when_the_type_would_be_ignored():
    with pytest.raises(InvalidRecordError):
        compute_status([ai_review(), 42])


# --------------------------------------------------------------------------- #
# Plugin registration
# --------------------------------------------------------------------------- #


def test_module_is_discovered_by_the_module_loader_scan():
    import app.modules as modules

    names = {info.name for info in pkgutil.iter_modules(modules.__path__)}
    assert "status" in names


def test_module_exposes_no_router_so_nothing_is_mounted():
    # Feature 83 is a library function; the loader mounts only a ``router``.
    assert getattr(status_module, "router", None) is None


def test_public_api_is_exported_from_the_package():
    for name in status_module.__all__:
        assert hasattr(status_module, name), name
