"""Tests for ``GET /v1/papers/{id}/coi-check`` (plugin: reviews, feature 106).

Papers are put in place through the submissions plugin's own ``save_paper`` /
``save_version`` / ``transition_version`` -- the calls its record handlers
make -- and affiliations through the profiles plugin's ``save_profile``.  The
route is then read with a signed-in client.

Isolation note: the test database is shared by every test in a worker, so each
test writes under its own unique DIDs, and under affiliation strings no other
test uses.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.main import app
from app.modules import profiles
from app.modules.profiles import ProfileData, erase_profile, save_profile
from app.modules.reviews import coi
from app.modules.reviews.coi import (
    COI_WINDOW_YEARS,
    check_conflicts,
    coauthored_since,
    normalise_institution,
)
from app.modules.submissions import (
    Authorship,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)
from app.security import UNAUTHENTICATED_TYPE, issue_access_token

client = TestClient(app)

_TO_LISTED = ("scanning", "moderation", "listed")


def _uid() -> str:
    return uuid.uuid4().hex


def _did() -> str:
    return f"did:example:coi-{_uid()}"


def _auth(did: str, tier: int = 3) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _years_ago(years: float) -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=365.25 * years)


class Seeded:
    """One saved paper with one version, and the ids that name it."""

    def __init__(self, paper_cid: str, version_cid: str) -> None:
        self.paper_cid = paper_cid
        self.version_cid = version_cid
        self.short_id = derive_short_id(paper_cid)


def _paper(
    authors: list[str],
    *,
    listed_at: Optional[datetime] = None,
    state: Optional[str] = None,
) -> Seeded:
    """Save a paper with one version listing ``authors`` in byline order.

    ``listed_at`` walks the version to ``listed`` at that instant; ``state``
    puts it straight into another state.  With neither, the version stays
    ``awaiting_consent`` with no date at all.
    """
    key = SigningKey.generate()
    signer = did_key_from_signing_key(key)
    tag = _uid()

    def sign(record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": signer,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            key,
        )

    genesis = sign("paper.genesis", {"seed": tag, "title": f"COI paper {tag}"})
    save_paper(paper_cid=genesis["id"], categories=("cs.CR",), licence="CC-BY-4.0")
    version = sign("paper.version", {"paper": genesis["id"], "n": 1}, prev=genesis["id"])
    save_version(
        version_cid=version["id"],
        paper_cid=genesis["id"],
        n=1,
        title=f"COI paper {tag}",
        abstract="A paper whose byline matters.",
        manifest_cid="bafkreimanifest",
        licence="CC-BY-4.0",
        prev_cid=genesis["id"],
        authors=tuple(VersionAuthor(did, position, None) for position, did in enumerate(authors, 1)),
    )
    if listed_at is not None:
        for step in _TO_LISTED:
            transition_version(version["id"], step, at=listed_at)
    elif state is not None:
        transition_version(version["id"], state)
    return Seeded(genesis["id"], version["id"])


def _decline(seeded: Seeded, did: str) -> None:
    with db.SessionLocal() as session:
        row = session.get(Authorship, (seeded.version_cid, did))
        row.consent_decision = "decline"
        session.commit()


def _affiliate(did: str, affiliation: str) -> None:
    save_profile(did, ProfileData(name="Test Person", affiliation=affiliation, email=f"{_uid()}@example.org"))


def _get(paper_id: str, did: Optional[str], tier: int = 3):
    headers = _auth(did, tier) if did is not None else {}
    return client.get(f"/v1/papers/{paper_id}/coi-check", headers=headers)


def _checks(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {check["id"]: check for check in response.json()["checks"]}


# --- the contract ---------------------------------------------------------------


def test_requires_authentication():
    seeded = _paper([_did()])

    response = _get(seeded.short_id, None)

    assert response.status_code == 401
    assert response.json()["type"] == UNAUTHENTICATED_TYPE


def test_unknown_paper_is_a_404_problem():
    response = _get("sch:aaaa-bbbb-cccc", _did())

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 404


def test_a_clear_reviewer_passes_all_three_checks_in_form_order():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _affiliate(author, f"Author Institute {_uid()}")
    _affiliate(reviewer, f"Reviewer Institute {_uid()}")

    response = _get(seeded.short_id, reviewer)

    assert response.status_code == 200
    body = response.json()
    assert [c["id"] for c in body["checks"]] == [
        "not_author",
        "no_recent_coauthorship",
        "different_institution",
    ]
    assert all(c["status"] == "pass" and c["passed"] is True for c in body["checks"])
    assert body["clear"] is True
    assert body["paper"] == seeded.short_id
    assert body["reviewer"] == reviewer
    assert body["window_years"] == COI_WINDOW_YEARS == 3
    assert body["checked_at"].endswith("Z")
    # Answers depend on the caller and on live profiles: nothing may cache them.
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("spelling", ["short_id", "paper_cid", "version_cid"])
def test_the_paper_resolves_by_short_id_genesis_cid_or_version_cid(spelling):
    seeded = _paper([_did()])

    response = _get(getattr(seeded, spelling), _did())

    assert response.status_code == 200
    assert response.json()["paper"] == seeded.short_id


def test_the_response_names_no_author_and_echoes_no_affiliation():
    author, reviewer = _did(), _did()
    shared = f"Shared University {_uid()}"
    seeded = _paper([author])
    _affiliate(author, shared)
    _affiliate(reviewer, shared)

    response = _get(seeded.short_id, reviewer)

    assert _checks(response)["different_institution"]["status"] == "fail"
    assert author not in response.text
    assert shared not in response.text
    assert normalise_institution(shared) not in response.text


# --- not an author --------------------------------------------------------------


def test_a_listed_author_fails_not_an_author():
    me, other = _did(), _did()
    seeded = _paper([other, me])

    response = _get(seeded.short_id, me)

    checks = _checks(response)
    assert checks["not_author"]["status"] == "fail"
    assert checks["not_author"]["passed"] is False
    assert response.json()["clear"] is False


def test_an_author_who_declined_authorship_is_still_named_on_the_paper():
    me = _did()
    seeded = _paper([_did(), me])
    _decline(seeded, me)

    assert _checks(_get(seeded.short_id, me))["not_author"]["status"] == "fail"


def test_a_moderator_gets_the_same_answer_as_anyone_else():
    me = _did()
    seeded = _paper([me])

    response = _get(seeded.short_id, me, tier=4)

    assert _checks(response)["not_author"]["status"] == "fail"


# --- no co-authorship in 3 years ------------------------------------------------


def test_a_co_authorship_listed_a_year_ago_fails():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _paper([reviewer, author], listed_at=_years_ago(1))

    check = _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]

    assert check["status"] == "fail"
    assert check["passed"] is False


def test_a_co_authorship_listed_four_years_ago_is_outside_the_window():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _paper([reviewer, author], listed_at=_years_ago(4))

    check = _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]

    assert check["status"] == "pass"


def test_the_window_edge_is_three_calendar_years_and_inclusive():
    author, reviewer = _did(), _did()
    listed = datetime(2023, 6, 15, 12, 0, 0)
    _paper([reviewer, author], listed_at=listed)

    assert coauthored_since(reviewer, [author], since=listed) is True
    assert coauthored_since(reviewer, [author], since=listed + timedelta(seconds=1)) is False


def test_only_a_shared_byline_with_an_author_of_this_paper_counts():
    author, reviewer, stranger = _did(), _did(), _did()
    seeded = _paper([author])
    # The reviewer's recent work is with someone who is not on this paper.
    _paper([reviewer, stranger], listed_at=_years_ago(0.5))
    # And an author's recent work is with someone who is not the reviewer.
    _paper([author, stranger], listed_at=_years_ago(0.5))

    assert _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]["status"] == "pass"


def test_a_co_author_who_declined_authorship_does_not_make_a_co_authorship():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    other = _paper([reviewer, author], listed_at=_years_ago(1))
    _decline(other, reviewer)

    assert _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]["status"] == "pass"


def test_a_rejected_version_is_not_a_co_authored_work():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _paper([reviewer, author], state="rejected")

    assert _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]["status"] == "pass"


def test_a_co_authorship_with_no_date_at_all_counts_as_recent():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _paper([reviewer, author])  # awaiting_consent: never listed, no ledger entry

    assert _checks(_get(seeded.short_id, reviewer))["no_recent_coauthorship"]["status"] == "fail"


def test_an_unlisted_version_is_dated_by_when_the_node_received_it(monkeypatch):
    author, reviewer = _did(), _did()
    other = _paper([reviewer, author])
    received = {"at": _years_ago(5)}
    monkeypatch.setattr(
        coi.ledger,
        "entry_by_cid",
        lambda cid: SimpleNamespace(received_at=received["at"]) if cid == other.version_cid else None,
    )
    since = _years_ago(3)

    assert coauthored_since(reviewer, [author], since) is False
    received["at"] = _years_ago(1)
    assert coauthored_since(reviewer, [author], since) is True


def test_the_reviewer_is_not_their_own_co_author():
    me = _did()
    _paper([me], listed_at=_years_ago(0.5))

    assert coauthored_since(me, [me], _years_ago(3)) is False


def test_the_three_year_window_handles_29_february():
    leap_day = datetime(2028, 2, 29, 9, 30)

    assert coi._years_before(leap_day, 3) == datetime(2025, 2, 28, 9, 30)
    assert coi._years_before(datetime(2026, 11, 15), 3) == datetime(2023, 11, 15)


def test_check_conflicts_accepts_a_fixed_clock():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _paper([reviewer, author], listed_at=datetime(2024, 1, 10))
    paper = SimpleNamespace(paper_cid=seeded.paper_cid, short_id=seeded.short_id)

    inside = check_conflicts(paper, reviewer, now=datetime(2026, 12, 1))
    outside = check_conflicts(paper, reviewer, now=datetime(2027, 6, 1))

    assert inside.checks[1].status == "fail"
    assert outside.checks[1].status == "pass"
    assert inside.checked_at == datetime(2026, 12, 1)


# --- different institution ------------------------------------------------------


@pytest.mark.parametrize(
    "authors_spelling",
    ["{name}", "  {name}  ", "{name}.", "{upper}"],
)
def test_the_same_institution_fails_however_it_is_spelled(authors_spelling):
    author, reviewer = _did(), _did()
    name = f"Northfield University {_uid()}"
    seeded = _paper([author])
    _affiliate(reviewer, name)
    _affiliate(author, authors_spelling.format(name=name, upper=name.upper()))

    check = _checks(_get(seeded.short_id, reviewer))["different_institution"]

    assert check["status"] == "fail"
    assert check["passed"] is False


def test_matching_any_one_of_several_authors_fails():
    first, second, reviewer = _did(), _did(), _did()
    name = f"Southgate College {_uid()}"
    seeded = _paper([first, second])
    _affiliate(first, f"Elsewhere {_uid()}")
    _affiliate(second, name)
    _affiliate(reviewer, name)

    assert _checks(_get(seeded.short_id, reviewer))["different_institution"]["status"] == "fail"


def test_a_reviewer_with_no_saved_affiliation_is_unknown_not_a_pass():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _affiliate(author, f"Author Institute {_uid()}")

    response = _get(seeded.short_id, reviewer)

    check = _checks(response)["different_institution"]
    assert check["status"] == "unknown"
    assert check["passed"] is False
    assert response.json()["clear"] is False


def test_a_reviewer_with_a_blank_affiliation_is_unknown():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _affiliate(reviewer, "   ")

    assert _checks(_get(seeded.short_id, reviewer))["different_institution"]["status"] == "unknown"


def test_an_erased_reviewer_profile_is_unknown():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _affiliate(reviewer, f"Reviewer Institute {_uid()}")
    erase_profile(reviewer)

    assert _checks(_get(seeded.short_id, reviewer))["different_institution"]["status"] == "unknown"


def test_an_author_with_no_readable_affiliation_cannot_be_shown_to_share_it():
    author, reviewer = _did(), _did()
    seeded = _paper([author])
    _affiliate(reviewer, f"Reviewer Institute {_uid()}")

    assert _checks(_get(seeded.short_id, reviewer))["different_institution"]["status"] == "pass"


def test_an_unreadable_profile_degrades_to_unknown_instead_of_failing_the_request(monkeypatch):
    author, reviewer = _did(), _did()
    seeded = _paper([author])

    def broken(did: str):
        raise RuntimeError("corrupt blob")

    monkeypatch.setattr(profiles, "read_profile", broken)

    response = _get(seeded.short_id, reviewer)

    assert _checks(response)["different_institution"]["status"] == "unknown"


def test_normalise_institution_folds_case_punctuation_and_spacing():
    assert normalise_institution("  M.I.T.,  Cambridge ") == normalise_institution("m i t cambridge")
    assert normalise_institution("Université de Montréal") == normalise_institution("UNIVERSITÉ DE MONTRÉAL.")
    assert normalise_institution(None) == ""
    assert normalise_institution("Foo University") != normalise_institution("Bar University")
