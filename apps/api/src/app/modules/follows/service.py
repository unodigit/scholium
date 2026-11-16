"""Store and read the categories one account follows (plugin: follows).

Feature 179: ``PUT /v1/me/follows/{category}`` saves ``(caller did, category)``
to the ``follows`` table, and ``GET /v1/papers?tab=following`` lists the listed
papers filed under any category the caller follows.  :func:`follow_category`
and :func:`followed_categories` are the two operations behind those routes;
:func:`unfollow_category` backs the ``DELETE`` counterpart a follow toggle
needs.

Following is idempotent: the table's ``(did, category)`` primary key makes a
repeat ``PUT`` -- including one that races another -- the same row, not a
conflict.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app import db

from .models import Follow, ensure_tables

__all__ = [
    "InvalidCategory",
    "MAX_CATEGORY_LENGTH",
    "follow_category",
    "followed_categories",
    "is_following",
    "normalise_category",
    "unfollow_category",
]

#: The longest category this plugin stores, matching the catalog's filter.
MAX_CATEGORY_LENGTH = 64


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
