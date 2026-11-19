"""Tests for saving a search (plugin: follows, feature 180).

Covers ``POST /v1/me/saved-searches``: it requires the caller's access token,
answers ``201`` with the saved search, and writes one ``saved_searches`` row
per save.  ``GET /v1/me/saved-searches`` reads the caller's saves back as
``{"items": [...]}``, per account, and ``DELETE /v1/me/saved-searches/{id}``
removes the caller's own save (``204``, idempotent; another reader's id is
``404`` and is left alone), after which the daily digest no longer matches it.
The stored ``query`` is the canonical form
of the filters the search endpoint (feature 86) accepts -- ``q``, ``category``,
``status``, ``has_code`` and the ``from``/``to`` date range -- so a saved
search can be re-run later (by the reader or the digest job) exactly as entered.

Every test uses a fresh DID and a query unique to it, so the shared database
and parallel workers never interfere.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app import db
from app.modules.follows import digest
from app.modules.follows.models import SavedSearch
from app.security import issue_access_token

SAVED_URL = "/v1/me/saved-searches"

#: The longest a saved ``q`` may be, matching the search endpoint (feature 86).
MAX_QUERY_CHARS = 2000


def _did() -> str:
    return "did:key:z6Mk" + uuid.uuid4().hex


def _auth(did: str, tier: int = 1) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _term() -> str:
    """A search term unique to one test, so shared rows never collide."""
    return f"pulsar timing {uuid.uuid4().hex[:12]}"


def save(client, did: str, query: object):
    return client.post(SAVED_URL, json={"query": query}, headers=_auth(did))


# --------------------------------------------------------------------------- #
# POST /v1/me/saved-searches -- authentication
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
def test_saving_a_search_requires_a_usable_token(client, headers):
    response = client.post(SAVED_URL, json={"query": {"q": _term()}}, headers=headers)

    assert response.status_code == 401, response.text


def test_a_body_is_required(client):
    response = client.post(SAVED_URL, headers=_auth(_did()))

    assert response.status_code == 422, response.text


# --------------------------------------------------------------------------- #
# POST /v1/me/saved-searches -- 201 and the saved_searches row
# --------------------------------------------------------------------------- #


def test_save_answers_201_and_saves_the_row(client):
    did, term = _did(), _term()
    query = {
        "q": term,
        "category": ["cs.CR", "cs.LG"],
        "status": ["reviewed"],
        "has_code": True,
        "from": "2026-03-02",
        "to": "2026-04-01",
    }

    response = save(client, did, query)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["did"] == did
    assert isinstance(body["id"], str) and body["id"]
    assert body["query"] == query
    with db.SessionLocal() as session:
        row = session.get(SavedSearch, body["id"])
        assert row is not None
        assert row.did == did
        assert row.query == query


def test_the_same_query_may_be_saved_twice(client):
    did, term = _did(), _term()

    first = save(client, did, {"q": term})
    second = save(client, did, {"q": term})

    assert (first.status_code, second.status_code) == (201, 201)
    ids = {first.json()["id"], second.json()["id"]}
    assert len(ids) == 2
    with db.SessionLocal() as session:
        rows = session.query(SavedSearch).filter(SavedSearch.did == did).all()
        assert {row.id for row in rows} == ids
        assert all(row.query == {"q": term} for row in rows)


def test_saved_searches_are_per_account(client):
    alice, bob, term = _did(), _did(), _term()
    save(client, alice, {"q": term})

    response = save(client, bob, {"q": term})

    assert response.status_code == 201, response.text
    with db.SessionLocal() as session:
        for did, expected in ((alice, 1), (bob, 1)):
            rows = session.query(SavedSearch).filter(SavedSearch.did == did).all()
            assert len(rows) == expected
            assert rows[0].query == {"q": term}


# --------------------------------------------------------------------------- #
# The stored query is the search's canonical form
# --------------------------------------------------------------------------- #


def test_a_scalar_filter_is_saved_as_a_list(client):
    term = _term()

    response = save(client, _did(), {"q": term, "category": "cs.CR", "status": "reviewed"})

    assert response.status_code == 201, response.text
    assert response.json()["query"] == {
        "q": term,
        "category": ["cs.CR"],
        "status": ["reviewed"],
    }


def test_blank_and_null_filters_are_dropped(client):
    term = _term()

    response = save(
        client,
        _did(),
        {"q": f"  {term}  ", "category": ["  ", ""], "status": None, "to": None},
    )

    assert response.status_code == 201, response.text
    assert response.json()["query"] == {"q": term}


def test_the_date_aliases_are_saved_canonically(client):
    term = _term()

    response = save(
        client, _did(), {"q": term, "date_from": "2026-03-02", "date_to": "2026-04-01"}
    )

    assert response.status_code == 201, response.text
    assert response.json()["query"] == {"q": term, "from": "2026-03-02", "to": "2026-04-01"}


# --------------------------------------------------------------------------- #
# A query that cannot be re-run is 422 problem details
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("body", "why"),
    [
        ({}, "no query key"),
        ({"query": None}, "query is null"),
        ({"query": []}, "query is not an object"),
        ({"query": {}}, "the query carries no filter"),
        ({"query": {"category": []}}, "every filter is blank"),
        ({"query": {"q": "   "}}, "q is blank"),
        ({"query": {"q": 5}}, "q is not a string"),
        ({"query": {"q": "x" * (MAX_QUERY_CHARS + 1)}}, "q is too long"),
        ({"query": {"q": "terms", "sort": "newest"}}, "an unknown key"),
        ({"query": {"q": "terms", "has_code": "yes"}}, "has_code is not a boolean"),
        ({"query": {"q": "terms", "category": 5}}, "category is not a list of strings"),
        ({"query": {"q": "terms", "from": "not-a-date"}}, "from is not a date"),
    ],
)
def test_a_query_that_cannot_be_re_run_is_422(client, body, why):
    response = client.post(SAVED_URL, json=body, headers=_auth(_did()))

    assert response.status_code == 422, response.text


# --------------------------------------------------------------------------- #
# GET /v1/me/saved-searches
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
def test_listing_saved_searches_requires_a_usable_token(client, headers):
    response = client.get(SAVED_URL, headers=headers)

    assert response.status_code == 401, response.text


def test_listing_returns_the_callers_saved_searches(client):
    did, other = _did(), _did()
    first = save(client, did, {"q": _term()}).json()
    second = save(client, did, {"q": _term()}).json()
    save(client, other, {"q": _term()})

    response = client.get(SAVED_URL, headers=_auth(did))

    assert response.status_code == 200, response.text
    assert response.json() == {"items": sorted([first, second], key=lambda row: row["id"])}


def test_listing_with_no_saves_is_empty(client):
    response = client.get(SAVED_URL, headers=_auth(_did()))

    assert response.status_code == 200, response.text
    assert response.json() == {"items": []}


# --------------------------------------------------------------------------- #
# DELETE /v1/me/saved-searches/{id}
# --------------------------------------------------------------------------- #


def delete(client, did: str, search_id: str):
    return client.delete(f"{SAVED_URL}/{search_id}", headers=_auth(did))


def _row_exists(search_id: str) -> bool:
    with db.SessionLocal() as session:
        return session.get(SavedSearch, search_id) is not None


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
def test_deleting_a_saved_search_requires_a_usable_token(client, headers):
    did = _did()
    saved = save(client, did, {"q": _term()}).json()

    response = client.delete(f"{SAVED_URL}/{saved['id']}", headers=headers)

    assert response.status_code == 401, response.text
    assert _row_exists(saved["id"])


def test_deleting_own_saved_search_is_204_and_removes_the_row(client):
    did = _did()
    saved = save(client, did, {"q": _term()}).json()

    response = delete(client, did, saved["id"])

    assert response.status_code == 204, response.text
    assert response.content == b""
    assert not _row_exists(saved["id"])


def test_a_deleted_search_is_gone_from_the_list(client):
    did = _did()
    keep = save(client, did, {"q": _term()}).json()
    drop = save(client, did, {"q": _term()}).json()

    delete(client, did, drop["id"])

    response = client.get(SAVED_URL, headers=_auth(did))
    assert response.status_code == 200, response.text
    assert response.json() == {"items": [keep]}


def test_deleting_one_copy_of_a_twice_saved_query_keeps_the_other(client):
    did, term = _did(), _term()
    first = save(client, did, {"q": term}).json()
    second = save(client, did, {"q": term}).json()

    response = delete(client, did, first["id"])

    assert response.status_code == 204, response.text
    assert not _row_exists(first["id"])
    assert _row_exists(second["id"])


def test_deleting_twice_is_idempotent(client):
    did = _did()
    saved = save(client, did, {"q": _term()}).json()

    first = delete(client, did, saved["id"])
    second = delete(client, did, saved["id"])

    assert (first.status_code, second.status_code) == (204, 204)
    assert not _row_exists(saved["id"])


def test_deleting_an_id_that_never_existed_is_204(client):
    response = delete(client, _did(), f"ss_{uuid.uuid4().hex}")

    assert response.status_code == 204, response.text


def test_deleting_another_readers_saved_search_is_404_and_keeps_it(client):
    alice, bob = _did(), _did()
    saved = save(client, alice, {"q": _term()}).json()

    response = delete(client, bob, saved["id"])

    assert response.status_code == 404, response.text
    assert _row_exists(saved["id"])
    listed = client.get(SAVED_URL, headers=_auth(alice)).json()
    assert listed == {"items": [saved]}


def test_a_foreign_delete_does_not_depend_on_the_trust_tier(client):
    alice, bob = _did(), _did()
    saved = save(client, alice, {"q": _term()}).json()

    response = client.delete(
        f"{SAVED_URL}/{saved['id']}", headers=_auth(bob, tier=3)
    )

    assert response.status_code == 404, response.text
    assert _row_exists(saved["id"])


# --------------------------------------------------------------------------- #
# The daily digest stops matching a deleted search
# --------------------------------------------------------------------------- #


def _new_entry(category: str, listed_at: datetime):
    """A catalog entry as the digest reads it: only what a no-``q`` search touches."""
    tag = uuid.uuid4().hex
    return SimpleNamespace(
        paper=SimpleNamespace(
            paper_cid=f"bafy{tag}",
            short_id=tag[:12],
            categories=[category],
            status="preprint",
        ),
        version=SimpleNamespace(title=f"Digest paper {tag}", manifest_cid="bafkreimanifest"),
        listed_at=listed_at,
    )


def test_the_digest_no_longer_matches_a_deleted_search(client):
    did = _did()
    category = f"cs.T{uuid.uuid4().hex[:12]}"
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=1)
    entry = _new_entry(category, until - timedelta(hours=2))
    saved = save(client, did, {"category": [category]}).json()

    before = digest.compose_digest(did, since=since, until=until, entries=[entry])
    assert [item.paper_cid for item in before.items] == [entry.paper.paper_cid]
    assert did in digest.digest_recipients()

    response = delete(client, did, saved["id"])

    assert response.status_code == 204, response.text
    after = digest.compose_digest(did, since=since, until=until, entries=[entry])
    assert after.items == ()
    assert did not in digest.digest_recipients()
