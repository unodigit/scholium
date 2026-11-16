"""Regression tests: the reveal gate counts people, and it gates review updates.

Two defects, both about REV-4 (no report enters the log before two independent
reviewers have committed on the version):

1. The gate counted ``review`` rows, not people.  The one-person-one-review
   guarantee lives in ``review_escrows.uniqueness_token`` and was written
   *after* the commit reached the log, so two concurrent commits by one member
   -- under two pseudonymous review keys -- both landed in the log and the
   ``review`` table, and that one person opened the gate alone.  The gate now
   counts distinct escrowed reviewers, and the escrow row is reserved (an
   INSERT under the UNIQUE constraint) *before* the append, so a duplicate
   never reaches the log.
2. An update of a revealed review (``prev`` names an earlier ``review.formal``)
   returned ``revealed`` without looking at the gate of the version it
   targets, so a report was published for a version that had fewer than two
   independent commits.

Every test makes its own keys, DIDs and paper, so nothing is shared through the
worker's database.
"""

from __future__ import annotations

import importlib
import threading
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Mapping

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import did_key_from_signing_key

from app import db
from app.main import app
from app.modules import ledger, reviews
from app.modules.reviews import (
    apply_review_reveal,
    commitment_digest,
    get_review,
    require_reveal_gate_open,
    reveal_gate_open,
    uniqueness_token,
)
from app.modules.reviews.errors import (
    REVEAL_GATE_CLOSED,
    REVIEW_ALREADY_COMMITTED,
    RevealGateClosed,
)
from app.modules.reviews.models import Review, ReviewEscrow

from .test_review_reveal import (
    COMMIT_TYPE,
    COMMIT_URL,
    REVEAL_URL,
    RECORDS_URL,
    Paper,
    Reviewer,
    _problem_type,
    _sign,
)
from .test_review_update import (
    commit_on,
    publish_version,
    revealed_review,
    update_record,
)

# ``app.modules.reviews.router`` is the APIRouter (the package re-exports it
# under the module's own name), so fetch the module that holds the endpoints.
reviews_router = importlib.import_module("app.modules.reviews.router")

client = TestClient(app)
# A failure inside the endpoint is an unhandled exception, which this client
# would re-raise instead of exposing as the ``500`` the API answers.
raw_client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def subscribed():
    """Put the package's ledger subscriptions back (other suites clear them)."""
    reviews._install_ledger_subscriber()


def _seal(reviewer: Reviewer, paper: Paper, body: Mapping[str, Any]) -> dict:
    """``reviewer``'s signed ``review.commit`` sealing ``body``; nothing is posted."""
    key = reviewer.review_key(paper)
    return _sign(
        key,
        COMMIT_TYPE,
        {
            "target": body["target"],
            "commitment": commitment_digest(body),
            "reviewKey": did_key_from_signing_key(key),
            "nullifier": reviewer.nullifier(paper),
        },
    )


def _same_member_under_a_second_key(member: Reviewer) -> Reviewer:
    """The same authenticated member with another review key and nullifier.

    A review key and nullifier are the client's choice, so one person can
    present a second, unrelated-looking reviewer: only the access token (and the
    escrow keyed by it) says they are the same.
    """
    twin = Reviewer()
    twin.seed, twin.did, twin.headers = member.seed, member.did, member.headers
    return twin


def _escrows_for(did: str, paper: Paper) -> list[str]:
    """The review cids escrowed under this person's uniqueness token for ``paper``."""
    token = uniqueness_token(did, paper.paper_cid)
    with db.SessionLocal() as session:
        return [
            row.review_cid
            for row in session.query(ReviewEscrow).filter(ReviewEscrow.uniqueness_token == token)
        ]


def _race_commits(monkeypatch, paper: Paper, attempts: list[tuple[Reviewer, dict]]):
    """POST one commit per ``(reviewer, body)`` attempt, all at the same moment.

    Every request is held at the point where the caller's identity has been
    sealed -- after the pre-flight uniqueness check, before anything is
    reserved or appended -- until all have arrived, so none can see another's
    work.  That is the window a real set of simultaneous requests falls into;
    the barrier only makes it certain instead of likely.

    Returns ``(reviewer, body, commit record, response)`` per attempt, in order.
    """
    commits = [_seal(who, paper, body) for who, body in attempts]

    barrier = threading.Barrier(len(attempts), timeout=10)
    seal = reviews_router.seal_identity

    def seal_then_meet(did: str) -> bytes:
        sealed = seal(did)
        try:
            barrier.wait()
        except threading.BrokenBarrierError:  # pragma: no cover - the peer never came
            pass
        return sealed

    monkeypatch.setattr(reviews_router, "seal_identity", seal_then_meet)

    def post(who: Reviewer, commit: dict):
        return client.post(COMMIT_URL, json=commit, headers=who.headers)

    with ThreadPoolExecutor(max_workers=len(attempts)) as pool:
        futures = [
            pool.submit(post, who, commit) for (who, _), commit in zip(attempts, commits)
        ]
        responses = [future.result(timeout=60) for future in futures]
    monkeypatch.undo()

    return [
        (who, body, commit, response)
        for (who, body), commit, response in zip(attempts, commits, responses)
    ]


def _race_two_commits(monkeypatch, paper: Paper, member: Reviewer, twin: Reviewer):
    """``member`` and ``twin`` (two review keys, one person) commit at the same moment."""
    attempts = [(who, who.rubric(paper)) for who in (member, twin)]
    return _race_commits(monkeypatch, paper, attempts)


# --------------------------------------------------------------------------- #
# 1. One person is one reviewer
# --------------------------------------------------------------------------- #


def test_concurrent_duplicate_commits_by_one_person_leave_exactly_one_log_entry(monkeypatch):
    paper, member = Paper(), Reviewer()
    twin = _same_member_under_a_second_key(member)

    raced = _race_two_commits(monkeypatch, paper, member, twin)

    statuses = sorted(response.status_code for *_, response in raced)
    assert statuses == [201, 409], [response.text for *_, response in raced]
    [refused] = [response for *_, response in raced if response.status_code == 409]
    assert refused.json()["type"] == REVIEW_ALREADY_COMMITTED

    in_log = [commit["id"] for _, _, commit, _ in raced if ledger.entry_by_cid(commit["id"])]
    saved = [commit["id"] for _, _, commit, _ in raced if get_review(commit["id"])]
    [winner_commit] = [commit for _, _, commit, r in raced if r.status_code == 201]
    # The loser never reached the log or the review table: it was refused at
    # the reservation, before the append.
    assert in_log == [winner_commit["id"]]
    assert saved == [winner_commit["id"]]
    assert _escrows_for(member.did, paper) == [winner_commit["id"]]


def test_concurrent_commits_under_one_review_key_leave_exactly_one_log_entry(monkeypatch):
    """The same reviewer, key and nullifier twice: the slot is the person's, not the key's."""
    paper, member = Paper(), Reviewer()
    attempts = [
        (member, member.rubric(paper, report="The first sealed report.")),
        (member, member.rubric(paper, report="A different sealed report.")),
    ]

    raced = _race_commits(monkeypatch, paper, attempts)

    statuses = sorted(response.status_code for *_, response in raced)
    assert statuses == [201, 409], [response.text for *_, response in raced]
    [winner] = [commit for _, _, commit, response in raced if response.status_code == 201]
    in_log = [commit["id"] for _, _, commit, _ in raced if ledger.entry_by_cid(commit["id"])]
    saved = [commit["id"] for _, _, commit, _ in raced if get_review(commit["id"])]
    assert in_log == saved == [winner["id"]]
    assert _escrows_for(member.did, paper) == [winner["id"]]
    assert reveal_gate_open(paper.version_cid) is False


def test_one_person_under_two_review_keys_cannot_open_the_gate_alone(monkeypatch):
    paper, member = Paper(), Reviewer()
    twin = _same_member_under_a_second_key(member)
    raced = _race_two_commits(monkeypatch, paper, member, twin)
    [(winner, body, _, _)] = [item for item in raced if item[3].status_code == 201]
    reveal = winner.reveal_record(paper, body)

    # One person is one reviewer, however many keys they sealed with.
    assert reveal_gate_open(paper.version_cid) is False
    response = client.post(REVEAL_URL, json=reveal, headers=winner.headers)

    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVEAL_GATE_CLOSED
    assert response.json()["committed"] == 1
    # The report never entered the log, so no read route can serve it.
    assert ledger.entry_by_cid(reveal["id"]) is None
    assert client.get(f"{RECORDS_URL}/{reveal['id']}").status_code == 404


def test_commits_that_were_never_escrowed_do_not_open_the_gate():
    """Distinct review keys are not distinct people; only an escrow says who."""
    paper = Paper()
    for _ in range(2):
        outsider = Reviewer()
        # Appended straight to the log, as another plugin's fixtures might: the
        # subscriber saves the row, but nothing seals an identity for it.
        ledger.append(_seal(outsider, paper, outsider.rubric(paper)))

    assert reveal_gate_open(paper.version_cid) is False
    with pytest.raises(RevealGateClosed) as closed:
        require_reveal_gate_open(paper.version_cid)
    assert closed.value.committed == 0


def test_two_different_people_open_the_gate():
    paper = Paper()
    for _ in range(2):
        member = Reviewer()
        body = member.rubric(paper)
        response = client.post(COMMIT_URL, json=_seal(member, paper, body), headers=member.headers)
        assert response.status_code == 201, response.text

    assert reveal_gate_open(paper.version_cid) is True
    require_reveal_gate_open(paper.version_cid)


def test_a_refused_commit_does_not_keep_the_slot_it_reserved():
    """The reservation is removed when the commit does not reach the log."""
    paper, first, second = Paper(), Reviewer(), Reviewer()
    assert (
        client.post(
            COMMIT_URL, json=_seal(first, paper, first.rubric(paper)), headers=first.headers
        ).status_code
        == 201
    )
    # ``second`` replays ``first``'s nullifier: the handler refuses the record
    # after the reservation was made, so nothing is appended.
    replay_body = second.rubric(paper)
    replay_body["nullifier"] = first.nullifier(paper)
    replay = _sign(
        second.review_key(paper),
        COMMIT_TYPE,
        {
            "target": paper.version_cid,
            "commitment": commitment_digest(replay_body),
            "reviewKey": did_key_from_signing_key(second.review_key(paper)),
            "nullifier": first.nullifier(paper),
        },
    )

    response = client.post(COMMIT_URL, json=replay, headers=second.headers)

    assert response.status_code == 409, response.text
    assert ledger.entry_by_cid(replay["id"]) is None
    assert _escrows_for(second.did, paper) == []
    # So ``second`` may still review the paper honestly.
    honest = _seal(second, paper, second.rubric(paper))
    assert client.post(COMMIT_URL, json=honest, headers=second.headers).status_code == 201


def test_a_commit_the_log_could_not_append_does_not_keep_the_slot_it_reserved(monkeypatch):
    paper, member = Paper(), Reviewer()
    record = _seal(member, paper, member.rubric(paper))

    def unavailable(*args: Any, **kwargs: Any):
        raise RuntimeError("the event log is unavailable")

    with monkeypatch.context() as patched:
        patched.setattr(ledger, "append", unavailable)
        response = raw_client.post(COMMIT_URL, json=record, headers=member.headers)
    assert response.status_code == 500, response.text

    assert ledger.entry_by_cid(record["id"]) is None
    assert _escrows_for(member.did, paper) == []
    retry = _seal(member, paper, member.rubric(paper))
    assert client.post(COMMIT_URL, json=retry, headers=member.headers).status_code == 201


# --------------------------------------------------------------------------- #
# 2. Updates (REV-5) and the 21-day fallback (REV-4)
# --------------------------------------------------------------------------- #


def _revealed_on_v1_with_an_ungated_v2():
    """A revealed v1 review, and a v2 nobody has committed on."""
    reviewer, paper = Reviewer(), Paper()
    commit, first = revealed_review(reviewer, paper)
    v2 = publish_version(paper, 2, open_gate=False)
    return reviewer, paper, commit, first, v2


def test_an_update_against_a_newer_version_needs_no_fresh_commits_on_it():
    """REV-5: a reviewer revises a revealed review against v2 without waiting for v2 reviewers.

    The revised review was revealed only after its own version's gate opened, so
    its report is already public; the update reveals nothing a new reviewer of
    v2 could not already read.
    """
    reviewer, paper, commit, first, v2 = _revealed_on_v1_with_an_ungated_v2()
    assert reveal_gate_open(v2) is False
    update = update_record(reviewer, paper, v2, first["id"], report="The revised report.")

    response = client.post(REVEAL_URL, json=update, headers=reviewer.headers)

    assert response.status_code == 201, response.text
    assert response.json()["review"] == commit["id"]
    assert response.json()["prev"] == first["id"]


def test_applying_an_update_does_not_need_the_new_versions_gate():
    reviewer, paper, _, first, v2 = _revealed_on_v1_with_an_ungated_v2()
    update = update_record(reviewer, paper, v2, first["id"])

    assert apply_review_reveal(update, signer_did=reviewer.did) is not None


def _lone_commit():
    """One reviewer commits on a fresh paper; nobody else does (the gate stays shut)."""
    reviewer, paper = Reviewer(), Paper()
    body = reviewer.rubric(paper)
    response = client.post(COMMIT_URL, json=_seal(reviewer, paper, body), headers=reviewer.headers)
    assert response.status_code == 201, response.text
    return reviewer, paper, body


def test_a_lone_reviewer_cannot_reveal_before_21_days():
    reviewer, paper, body = _lone_commit()

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 409, response.text
    assert _problem_type(response) == REVEAL_GATE_CLOSED


def test_the_gate_opens_21_days_after_the_first_commit():
    """PRD REV-4: reports are hidden until two are committed *or 21 days pass*."""
    reviewer, paper, body = _lone_commit()
    with db.SessionLocal() as session:
        for row in session.query(Review).filter(Review.version_cid == paper.version_cid):
            row.committed_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=22)
        session.commit()
    assert reveal_gate_open(paper.version_cid) is True

    response = reviewer.post_reveal(paper, body)

    assert response.status_code == 201, response.text
