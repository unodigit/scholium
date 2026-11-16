"""Store and read the categories one account follows and the searches it saved.

Feature 179: ``PUT /v1/me/follows/{category}`` saves ``(caller did, category)``
to the ``follows`` table, and ``GET /v1/papers?tab=following`` lists the listed
papers filed under any category the caller follows.  :func:`follow_category`
and :func:`followed_categories` are the two operations behind those routes;
:func:`unfollow_category` backs the ``DELETE`` counterpart a follow toggle
needs.

Feature 180: ``POST /v1/me/saved-searches`` saves a search to re-run later.
:func:`save_search` writes one ``saved_searches`` row -- a fresh id per save,
the caller's did, and the query's canonical form from
:func:`normalise_query`.  The canonical form carries exactly the search
endpoint's (feature 86) filters -- ``q``, ``category``, ``status``,
``has_code`` and the ``from``/``to`` date range -- so whatever re-runs a saved
search (the reader's client, the daily digest of feature 181) can feed the
stored object straight back to ``GET /v1/search``.

Following is idempotent: the table's ``(did, category)`` primary key makes a
repeat ``PUT`` -- including one that races another -- the same row, not a
conflict.  Saving a search is additive: each ``POST`` is its own row.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app import db

from .models import Follow, SavedSearch, ensure_tables

__all__ = [
    "InvalidCategory",
    "InvalidSearchQuery",
    "MAX_CATEGORY_LENGTH",
    "MAX_QUERY_CHARS",
    "follow_category",
    "followed_categories",
    "is_following",
    "normalise_category",
    "normalise_query",
    "save_search",
    "saved_searches",
    "unfollow_category",
]

#: The longest category this plugin stores, matching the catalog's filter.
MAX_CATEGORY_LENGTH = 64

#: The longest a saved ``q`` may be, matching the search endpoint (feature 86).
MAX_QUERY_CHARS = 2000

#: The filters a saved search may carry: exactly the search endpoint's
#: (feature 86) narrowing parameters, minus its ``limit`` pagination.
_QUERY_FILTERS = frozenset({"q", "category", "status", "has_code", "from", "to"})

#: Spellings the search endpoint also answers, folded onto one canonical key.
_QUERY_ALIASES = {"date_from": "from", "date_to": "to"}


class InvalidCategory(ValueError):
    """The category is not a non-empty category name."""


def normalise_category(category: object) -> str:
    """Return ``category`` stripped, or raise :class:`InvalidCategory`.

    Categories are compared exactly as filed on a paper (``cs.AI``); case is
    not changed.  Only surrounding whitespace is removed, so a hand-typed
    category with a stray space follows the same papers as the clean spelling.
    """
    if not isinstance(category, str):
        raise InvalidCategory("A category must be a string.")
    cleaned = category.strip()
    if not cleaned:
        raise InvalidCategory("A category must not be empty.")
    if len(cleaned) > MAX_CATEGORY_LENGTH:
        raise InvalidCategory(
            f"A category may be at most {MAX_CATEGORY_LENGTH} characters long."
        )
    return cleaned


def follow_category(did: str, category: str) -> bool:
    """Save that ``did`` follows ``category``.

    Returns ``True`` when the row was created and ``False`` when it already
    existed, so a caller can tell a new follow from a repeated one without
    another query.
    """
    cleaned = normalise_category(category)
    ensure_tables()
    with db.SessionLocal() as session:
        if session.get(Follow, (did, cleaned)) is not None:
            return False
        session.add(Follow(did=did, category=cleaned))
        try:
            session.commit()
        except IntegrityError:
            # Another request (or a second worker) wrote the same pair first;
            # the fact is recorded either way.
            session.rollback()
            return False
    return True


def unfollow_category(did: str, category: str) -> bool:
    """Remove ``did``'s follow of ``category``; return whether a row was removed."""
    cleaned = normalise_category(category)
    ensure_tables()
    with db.SessionLocal() as session:
        result = session.execute(
            delete(Follow).where(Follow.did == did, Follow.category == cleaned)
        )
        session.commit()
        return bool(result.rowcount)


def is_following(did: str, category: str) -> bool:
    """Whether ``did`` follows exactly ``category``."""
    cleaned = normalise_category(category)
    ensure_tables()
    with db.SessionLocal() as session:
        return session.get(Follow, (did, cleaned)) is not None


def followed_categories(did: str) -> list[str]:
    """Every category ``did`` follows, in a stable (alphabetical) order."""
    ensure_tables()
    with db.SessionLocal() as session:
        rows = session.execute(
            select(Follow.category)
            .where(Follow.did == did)
            .order_by(Follow.category)
        )
        return [row[0] for row in rows]


# --------------------------------------------------------------------------- #
# Saved searches (feature 180)
# --------------------------------------------------------------------------- #


class InvalidSearchQuery(ValueError):
    """The query is not a search this node could re-run."""


def _normalise_string_list(field: str, value: object) -> list[str]:
    """Return ``value`` as the list of non-blank strings ``field`` names."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise InvalidSearchQuery(f"{field} must be a string or a list of strings.")
    # Mirror the search endpoint: blank entries narrow nothing and are dropped.
    return [item.strip() for item in value if item.strip()]


def normalise_query(query: object) -> dict:
    """Return the canonical form of a saved search's ``query`` object.

    A query is the search endpoint's (feature 86) filters as one JSON object.
    Canonical form: only the filter keys ``q``, ``category``, ``status``,
    ``has_code``, ``from`` and ``to`` (``date_from``/``date_to`` fold onto
    ``from``/``to``); ``q`` stripped; ``category``/``status`` always lists of
    stripped, non-blank strings; dates as ``YYYY-MM-DD``; a filter set to
    ``null`` absent.  Raises :class:`InvalidSearchQuery` for anything else,
    including a query that carries no filter at all -- a saved search must
    still narrow the catalog when it is re-run.
    """
    if not isinstance(query, dict):
        raise InvalidSearchQuery("query must be a JSON object of search filters.")
    canonical: dict = {}
    for key, value in query.items():
        field = _QUERY_ALIASES.get(key, key)
        if field not in _QUERY_FILTERS:
            raise InvalidSearchQuery(f"{key!r} is not a search filter.")
        if value is None:
            continue
        if field == "q":
            if not isinstance(value, str):
                raise InvalidSearchQuery("q must be a string.")
            cleaned = value.strip()
            if not cleaned:
                raise InvalidSearchQuery("q must not be blank.")
            if len(cleaned) > MAX_QUERY_CHARS:
                raise InvalidSearchQuery(
                    f"q may be at most {MAX_QUERY_CHARS} characters long."
                )
            canonical["q"] = cleaned
        elif field in ("category", "status"):
            cleaned = _normalise_string_list(field, value)
            if cleaned:
                canonical[field] = cleaned
        elif field == "has_code":
            if not isinstance(value, bool):
                raise InvalidSearchQuery("has_code must be true or false.")
            canonical["has_code"] = value
        else:  # from / to
            if not isinstance(value, str):
                raise InvalidSearchQuery(f"{field} must be a date, YYYY-MM-DD.")
            try:
                canonical[field] = date.fromisoformat(value.strip()).isoformat()
            except ValueError:
                raise InvalidSearchQuery(
                    f"{field} must be a date, YYYY-MM-DD."
                ) from None
    if not canonical:
        raise InvalidSearchQuery("query must carry at least one search filter.")
    return canonical


def save_search(did: str, query: object) -> SavedSearch:
    """Save ``query`` as one of ``did``'s searches; return the stored row.

    Every save is its own row with a fresh id: the reader who saves the same
    search twice keeps both copies until they delete one.
    """
    canonical = normalise_query(query)
    ensure_tables()
    search = SavedSearch(id=f"ss_{uuid.uuid4().hex}", did=did, query=canonical)
    with db.SessionLocal() as session:
        session.add(search)
        session.commit()
        session.refresh(search)
        session.expunge(search)
    return search


def saved_searches(did: str) -> list[SavedSearch]:
    """Every search ``did`` saved, in a stable (by id) order.

    The rows are detached from their session, so a caller -- the daily digest
    of feature 181 -- can read ``query`` after the call returns.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(SavedSearch)
                .where(SavedSearch.did == did)
                .order_by(SavedSearch.id)
            ).scalars()
        )
        session.expunge_all()
    return rows
