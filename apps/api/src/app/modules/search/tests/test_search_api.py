"""Tests for ``GET /v1/search`` (feature 86).

Covers: the endpoint is mounted; a word from a listed title finds it; ranked
relevance (title over abstract, repeated terms first); facet counts by
category and status; the ``category``, ``status``, ``has_code`` and date-range
filters; that unlisted versions are absent; and validation.

The scene is built through the submissions plugin's own ``save_paper`` /
``save_version`` / ``transition_version`` -- the calls the handlers make -- and
the manifest is a signed record in the ledger, so ``has_code`` is decided the
way it is in production, never by writing the index or a facet by hand.

Isolation: tests in a worker share one database, so every test uses unique
random words and asserts on its own versions, never on table totals.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import compute_record_id, did_key_from_signing_key, sign_record

from app.main import app
from app.modules import ledger
from app.modules.search import search_versions, tokenize
from app.modules.submissions import (
    HELD,
    LISTED,
    MODERATION,
    SCANNING,
    VersionAuthor,
    authorship_for,
    save_paper,
    save_version,
    transition_version,
)

SEARCH_URL = "/v1/search"


# --------------------------------------------------------------------------- #
# Building the scene
# --------------------------------------------------------------------------- #


def new_cid() -> str:
    """A real, unique dag-cbor record id, as a paper or version cid is."""
    return compute_record_id(
        {
            "v": 1,
            "type": "test.search.api",
            "author": "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb",
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def unique_word() -> str:
    """A plain token no other test's text contains."""
    return "q" + uuid.uuid4().hex


def code_manifest() -> str:
    """Append a signed manifest listing a ``code`` file; return its cid."""
    key = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "manifest",
            "author": did_key_from_signing_key(key),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {
                "files": [
                    {
                        "path": "code.tar.gz",
                        "cid": "bafkreicode" + uuid.uuid4().hex[:32],
                        "size": 10,
                        "mediaType": "application/gzip",
                        "role": "code",
                    }
                ]
            },
            "proofs": [],
        },
        key,
    )
    ledger.append(record)
    return record["id"]


class Listing:
    """One paper with one version, listed unless ``state`` says otherwise."""

    def __init__(
        self,
        title: str,
        *,
        abstract: str = "A short abstract.",
        categories: tuple[str, ...] = ("cs.CR",),
        status: str = "preprint",
        has_code: bool = False,
        listed_at: Optional[datetime] = None,
        authors: Sequence[VersionAuthor] = (),
    ) -> None:
        self.paper_cid = new_cid()
        self.version_cid = new_cid()
        self.short_id = None
        save_paper(paper_cid=self.paper_cid, categories=categories, status=status)
        save_version(
            version_cid=self.version_cid,
            paper_cid=self.paper_cid,
            n=1,
            title=title,
            abstract=abstract,
            manifest_cid=code_manifest() if has_code else new_cid(),
            licence="CC-BY-4.0",
            prev_cid=self.paper_cid,
            authors=authors,
        )
        transition_version(self.version_cid, SCANNING)
        transition_version(self.version_cid, MODERATION)
        transition_version(self.version_cid, LISTED, at=listed_at)

    def hold(self) -> "Listing":
        transition_version(self.version_cid, HELD)
        return self


def listed(title: str, **kwargs: Any) -> Listing:
    return Listing(title, **kwargs)


def ok(client: TestClient, q: str, **params: str) -> dict:
    response = client.get(SEARCH_URL, params={"q": q, **params})
    assert response.status_code == 200, response.text
    return response.json()


def cids(body: dict) -> list[str]:
    return [hit["version_cid"] for hit in body["results"]]


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# --------------------------------------------------------------------------- #
# The basics
# --------------------------------------------------------------------------- #


def test_blank_query_is_refused(client):
    assert client.get(SEARCH_URL, params={"q": "  "}).status_code == 422


def test_missing_query_is_refused(client):
    assert client.get(SEARCH_URL).status_code == 422


def test_tokenize_keeps_words_and_drops_fts_syntax():
    assert tokenize('  "pulsar" AND (timing)*  ') == ["pulsar", "AND", "timing"]
    assert tokenize("") == []
    assert tokenize('NEAR(a b) "x:y"') == ["NEAR", "a", "b", "x", "y"]


def test_a_word_of_a_listed_title_returns_it(client):
    word = unique_word()
    target = listed(f"Notes on {word}")

    body = ok(client, word)

    assert target.version_cid in cids(body)
    hit = next(h for h in body["results"] if h["version_cid"] == target.version_cid)
    assert hit["paper_cid"] == target.paper_cid
    assert hit["title"] == f"Notes on {word}"
    assert hit["categories"] == ["cs.CR"]
    assert hit["status"] == "preprint"
    assert hit["has_code"] is False


def author_did() -> str:
    """A DID no other test's version names."""
    return "did:key:z6Mk" + uuid.uuid4().hex


def test_a_hit_carries_its_authors_in_byline_order(client):
    # Regression: result rows showed "cs.LG - v1 - date" and no names because
    # the API sent no authors at all, while the feed's rows name theirs.
    word = unique_word()
    first, second = author_did(), author_did()
    target = listed(
        f"Notes on {word}",
        authors=(
            # Stored out of byline order: ``position`` decides, not insertion.
            VersionAuthor(did=second, position=2, credit_roles=None),
            VersionAuthor(did=first, position=1, credit_roles=("Conceptualization",)),
        ),
    )

    hit = next(h for h in ok(client, word)["results"] if h["version_cid"] == target.version_cid)

    assert hit["authors"] == [
        {"did": first, "author": first, "position": 1, "creditRoles": ["Conceptualization"]},
        {"did": second, "author": second, "position": 2, "creditRoles": None},
    ]


def test_a_hit_matches_the_catalog_authors_for_the_same_version(client):
    word = unique_word()
    did = author_did()
    target = listed(
        f"Study of {word}",
        authors=(VersionAuthor(did=did, position=1, credit_roles=()),),
    )
    hit = next(h for h in ok(client, word)["results"] if h["version_cid"] == target.version_cid)

    assert [a["did"] for a in hit["authors"]] == [r.author_did for r in authorship_for(target.version_cid)]
    assert hit["authors"][0]["creditRoles"] == []


def test_a_hit_with_no_authorship_rows_has_an_empty_author_list(client):
    word = unique_word()
    target = listed(f"Anonymous {word}")

    hit = next(h for h in ok(client, word)["results"] if h["version_cid"] == target.version_cid)

    assert hit["authors"] == []


def test_search_versions_hits_carry_their_authors():
    word = unique_word()
    did = author_did()
    target = listed(
        f"Direct {word}",
        authors=(VersionAuthor(did=did, position=1, credit_roles=None),),
    )

    (hit,) = search_versions(word).hits

    assert hit.version_cid == target.version_cid
    assert [row.author_did for row in hit.authors] == [did]


def test_an_unlisted_version_is_not_returned(client):
    word = unique_word()
    paper = listed(f"Held study {word}").hold()

    assert ok(client, word)["results"] == []
    assert search_versions(word).hits == []


def test_facet_counts_cover_every_match(client):
    word = unique_word()
    listed(f"{word} one", categories=("cs.CR",), status="reviewed")
    listed(f"{word} two", categories=("cs.CR",), status="preprint")
    listed(f"{word} three", categories=("cs.LG",), status="preprint")
    listed(f"{word} four", categories=("cs.CR",), status="preprint")

    body = ok(client, word)

    assert body["total"] == 4
    assert len(body["results"]) == 4
    assert body["facets"]["category"] == {"cs.CR": 3, "cs.LG": 1}
    assert body["facets"]["status"] == {"preprint": 3, "reviewed": 1}


def test_a_selected_category_leaves_the_other_categories_in_the_counts(client):
    # D2: a facet's counts are over the matches that pass every filter except
    # that facet's own, so selecting one category still shows what widening the
    # OR would add.  The other filters (here, status) still apply.
    word = unique_word()
    ai = listed(f"{word} ai", categories=("cs.AI",), status="under_review")
    lg = listed(f"{word} lg", categories=("cs.LG",), status="under_review")
    ma = listed(f"{word} ma", categories=("cs.MA",), status="preprint")

    # No selection in the facet: its counts are unchanged.
    assert ok(client, word)["facets"]["category"] == {"cs.AI": 1, "cs.LG": 1, "cs.MA": 1}

    body = ok(client, word, category="cs.LG")

    assert cids(body) == [lg.version_cid]
    assert body["total"] == 1
    assert body["facets"]["category"] == {"cs.AI": 1, "cs.LG": 1, "cs.MA": 1}
    # The status facet still applies the selected category.
    assert body["facets"]["status"] == {"under_review": 1}
    assert ai.version_cid not in cids(body)
    assert ma.version_cid not in cids(body)


def test_a_selected_status_leaves_the_other_statuses_in_the_counts(client):
    word = unique_word()
    under_review = listed(f"{word} review", categories=("cs.AI",), status="under_review")
    preprint = listed(f"{word} preprint", categories=("cs.LG",), status="preprint")

    body = ok(client, word, status="preprint")

    assert cids(body) == [preprint.version_cid]
    assert body["facets"]["status"] == {"under_review": 1, "preprint": 1}
    # The category facet still applies the selected status.
    assert body["facets"]["category"] == {"cs.LG": 1}
    assert under_review.version_cid not in cids(body)


def test_both_facets_selected_each_ignores_only_its_own_filter(client):
    word = unique_word()
    lg_review = listed(f"{word} lg review", categories=("cs.LG",), status="under_review")
    lg_preprint = listed(f"{word} lg preprint", categories=("cs.LG",), status="preprint")
    ai_review = listed(f"{word} ai review", categories=("cs.AI",), status="under_review")

    body = ok(client, word, category="cs.LG", status="under_review")

    assert cids(body) == [lg_review.version_cid]
    # Category counts ignore the category but keep the status.
    assert body["facets"]["category"] == {"cs.AI": 1, "cs.LG": 1}
    # Status counts ignore the status but keep the category.
    assert body["facets"]["status"] == {"under_review": 1, "preprint": 1}
    assert ai_review.version_cid not in cids(body)
    assert lg_preprint.version_cid not in cids(body)


def test_facet_counts_still_apply_the_other_filters(client):
    word = unique_word()
    listed(f"{word} ai code", categories=("cs.AI",), has_code=True)
    lg_code = listed(f"{word} lg code", categories=("cs.LG",), has_code=True)
    listed(f"{word} lg plain", categories=("cs.LG",))

    body = ok(client, word, category="cs.LG", has_code="true")

    assert cids(body) == [lg_code.version_cid]
    # Widening the category OR never brings back a version that fails has_code.
    assert body["facets"]["category"] == {"cs.AI": 1, "cs.LG": 1}


def test_facet_counts_count_each_paper_once(client):
    word = unique_word()
    target = listed(f"{word} v1", categories=("cs.LG",))
    version_cid = new_cid()
    save_version(
        version_cid=version_cid,
        paper_cid=target.paper_cid,
        n=2,
        title=f"{word} v2",
        abstract="A short abstract.",
        manifest_cid=new_cid(),
        licence="CC-BY-4.0",
        prev_cid=target.version_cid,
    )
    transition_version(version_cid, SCANNING)
    transition_version(version_cid, MODERATION)
    transition_version(version_cid, LISTED)

    body = ok(client, word)
    widened = ok(client, word, category="cs.LG")

    # One hit per paper, in the results and in both facet counts.
    assert body["total"] == 1
    assert body["facets"]["category"] == {"cs.LG": 1}
    assert body["facets"]["status"] == {"preprint": 1}
    assert widened["facets"]["category"] == {"cs.LG": 1}
    assert widened["facets"]["status"] == {"preprint": 1}


def test_results_are_ranked_by_relevance(client):
    word = unique_word()
    filler = " ".join(f"background{i}" for i in range(60))
    weak = listed(f"Unrelated {uuid.uuid4().hex}", abstract=f"{filler} {word} {filler}")
    medium = listed(f"Notes on {word}")
    strong = listed(f"{word} {word} {word}", abstract=f"{word} {word} {word}")

    order = cids(ok(client, word))

    assert order.index(strong.version_cid) == 0
    assert order.index(strong.version_cid) < order.index(medium.version_cid)
    assert order.index(medium.version_cid) < order.index(weak.version_cid)


# --------------------------------------------------------------------------- #
# Filters
# --------------------------------------------------------------------------- #


def test_category_filter(client):
    word = unique_word()
    security = listed(f"{word} security", categories=("cs.CR",))
    learning = listed(f"{word} learning", categories=("cs.LG",))
    both = listed(f"{word} both", categories=("cs.CR", "cs.LG"))

    body = ok(client, word, category="cs.CR")

    assert set(cids(body)) == {security.version_cid, both.version_cid}
    assert set(body["facets"]["category"]) == {"cs.CR", "cs.LG"}
    assert learning.version_cid not in cids(body)
    assert security.version_cid in cids(ok(client, word))


def test_status_filter(client):
    word = unique_word()
    reviewed = listed(f"{word} reviewed", status="reviewed")
    preprint = listed(f"{word} preprint", status="preprint")

    body = ok(client, word, status="reviewed")

    assert cids(body) == [reviewed.version_cid]
    assert preprint.version_cid not in cids(body)
    assert preprint.version_cid in cids(ok(client, word))


def test_has_code_filter(client):
    word = unique_word()
    with_code = listed(f"{word} with code", has_code=True)
    without_code = listed(f"{word} without code")

    body = ok(client, word, has_code="true")

    assert cids(body) == [with_code.version_cid]
    assert without_code.version_cid in cids(ok(client, word))
    only_without = ok(client, word, has_code="false")
    assert cids(only_without) == [without_code.version_cid]


def test_date_range_filter(client):
    word = unique_word()
    early = listed(f"{word} early", listed_at=datetime(2024, 1, 10, 12, tzinfo=timezone.utc))
    late = listed(f"{word} late", listed_at=datetime(2024, 6, 10, 12, tzinfo=timezone.utc))

    within = ok(client, word, **{"from": "2024-05-01", "to": "2024-12-31"})

    assert cids(within) == [late.version_cid]
    assert early.version_cid in cids(ok(client, word))
    # The same bounds under their alternative spelling.
    aliased = ok(client, word, **{"date_from": "2024-05-01", "date_to": "2024-12-31"})
    assert cids(aliased) == [late.version_cid]
