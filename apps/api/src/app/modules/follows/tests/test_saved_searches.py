"""Tests for saving a search (plugin: follows, feature 180).

Covers ``POST /v1/me/saved-searches``: it requires the caller's access token,
answers ``201`` with the saved search, and writes one ``saved_searches`` row
per save.  The stored ``query`` is the canonical form of the filters the
search endpoint (feature 86) accepts -- ``q``, ``category``, ``status``,
``has_code`` and the ``from``/``to`` date range -- so a saved search can be
re-run later (by the reader or the digest job) exactly as entered.

Every test uses a fresh DID and a query unique to it, so the shared database
and parallel workers never interfere.
"""

from __future__ import annotations

import uuid

import pytest

from app import db
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
