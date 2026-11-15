"""Accepting a ``paper.genesis`` record (plugin: submissions, feature 49).

A ``paper.genesis`` record starts a paper: it names the title, the categories
the paper is filed under and its licence, and its cid *is* the paper's id
(``papers.paper_cid``).  The ingest pipeline (``POST /v1/records``) has already
verified the envelope, the body schema, the cid and the signature by the time
:func:`handle_paper_genesis` runs.  The handler then adds the one decision the
generic pipeline cannot make -- who may start a paper, and where -- and applies
the record:

* the **author** -- the DID the signature authenticates, not whoever relays the
  record -- must hold trust tier 2 (Author) or higher; below it the record is
  refused with ``403``;
* the author must hold an **active endorsement in every category** the record
  lists (:func:`app.modules.endorsements.can_submit`, feature 42).  Tier 2 is
  what an endorsement grants, but submission rights are per category: an author
  endorsed in ``cs.AI`` may not file a paper under ``cs.AI`` *and* ``cs.LG``.
  One or more unendorsed categories is a ``403``
  (:class:`~.errors.CategoryNotEndorsed`) naming each of them;
* accepting the record **saves the paper** to the ``papers`` table: its
  categories, its licence and its ``sch:`` short id, derived from the record's
  cid (:func:`scholium_record_core.derive_short_id`) -- the very id
  ``POST /v1/records`` answers with as ``shortId``.

Licence
-------

The licence is stored as the signed record states it.  A genesis that names no
licence is stored under :data:`~.models.DEFAULT_LICENCE` (``CC-BY-4.0``, CC BY
4.0).  The record core's shipped ``paper.genesis`` schema lists ``licence`` as
required, so over ``POST /v1/records`` the schema refuses a record without one
before this handler runs; the default is what :func:`save_paper`, the handler
when called directly, and the column itself fall back to.  A licence that is
present but blank is *not* defaulted -- it is a ``422``: the signed record would
say one thing and the table another.

Refusals and side effects
-------------------------

The handler runs before the record is appended to the ledger, so refusing a
record here (``403``/``409``/``422``) leaves nothing stored.  Saving is
idempotent per cid: if the row already exists -- an earlier attempt saved it
but the ledger append then failed, or two submissions of the same record
race -- the existing row is kept and the handler reports success, so a retry
repairs the gap instead of failing on it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

from scholium_record_core import derive_short_id
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules.endorsements import can_submit
from app.modules.ingest import (
    PAPER_GENESIS_TYPE,
    InsufficientAuthorTier,
    InvalidRecord,
    author_tier,
)
from app.security import Tier

from .errors import CategoryNotEndorsed, ShortIdCollision
from .limits import enforce_genesis_quota
from .models import DEFAULT_LICENCE, INITIAL_STATUS, Paper, ensure_tables

__all__ = [
    "GENESIS_MIN_TIER",
    "PAPER_GENESIS_TYPE",
    "genesis_categories",
    "genesis_licence",
    "get_paper",
    "get_paper_by_short_id",
    "handle_paper_genesis",
    "require_endorsed",
    "save_paper",
    "unendorsed_categories",
]

#: Lowest trust tier allowed to start a paper (tier 2, Author).  An accepted
#: endorsement grants exactly this tier, so it is the floor for anyone who can
#: be endorsed at all; the endorsement check does the per-category work.
GENESIS_MIN_TIER = int(Tier.AUTHOR)

_MAX_ECHO = 64


# --------------------------------------------------------------------------- #
# Reading the body
# --------------------------------------------------------------------------- #


def _invalid(field: str, message: str, kind: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad ``paper.genesis`` body field, located at ``body.<field>``."""
    shown = value[: _MAX_ECHO - 3] + "..." if isinstance(value, str) and len(value) > _MAX_ECHO else value
    if not isinstance(shown, (str, int, float, bool, type(None))):
        shown = None
    full = f"The paper.genesis field {field!r} {message}."
    return InvalidRecord(
        [{"loc": ["body", field], "msg": full, "type": kind, "input": shown}],
        detail=full,
    )


def genesis_categories(body: Mapping[str, Any]) -> list[str]:
    """Return the categories a genesis body files its paper under, de-duplicated.

    The schema already requires a non-empty list of unique, well-formed names;
    this re-checks the shape so a direct caller gets a ``422`` rather than a
    ``TypeError``, and drops repeats (keeping first-seen order) so a category is
    stored -- and checked for endorsement -- once.

    Raises:
        InvalidRecord: ``422`` when ``categories`` is not a non-empty list of
            non-empty strings.
    """
    value = body.get("categories")
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
        raise _invalid(
            "categories", "must be a non-empty list of category names", "invalid_categories", None
        )
    categories: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise _invalid(
                "categories",
                "must list only non-empty category names",
                "invalid_categories",
                item,
            )
        if item not in categories:
            categories.append(item)
    return categories


def genesis_licence(body: Mapping[str, Any]) -> str:
    """Return the licence a genesis body states, or :data:`~.models.DEFAULT_LICENCE`.

    A missing (or ``null``) ``licence`` is the default.  A string is the
    licence, trimmed of surrounding whitespace.

    Raises:
        InvalidRecord: ``422`` when ``licence`` is present but is not a
            non-blank string.
    """
    value = body.get("licence")
    if value is None:
        return DEFAULT_LICENCE
    if not isinstance(value, str) or not value.strip():
        raise _invalid("licence", "must be a non-blank licence identifier", "invalid_licence", value)
    return value.strip()


def _genesis_cid(record: Mapping[str, Any]) -> str:
    """The record's cid, which is also the paper's id (``422`` when unusable)."""
    record_id = record.get("id")
    message = "The paper.genesis record must carry its cid as a non-empty string in 'id'."
    if not isinstance(record_id, str) or not record_id:
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )
    try:
        derive_short_id(record_id)
    except ValueError as exc:
        text = f"The paper.genesis record id is not a record cid: {exc}"
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": text, "type": "invalid_record_id", "input": None}],
            detail=text,
        ) from exc
    return record_id


# --------------------------------------------------------------------------- #
# Endorsements
# --------------------------------------------------------------------------- #


def unendorsed_categories(author: object, categories: Sequence[str]) -> list[tuple[int, str]]:
    """Return ``(index, category)`` for each category ``author`` may not submit in.

    A category is open to the author exactly when
    :func:`app.modules.endorsements.can_submit` says so -- an active, unexpired
    endorsement of that DID for that category.  ``index`` is the category's
    position in ``categories``.
    """
    return [
        (index, category)
        for index, category in enumerate(categories)
        if not can_submit(author, category)
    ]


def require_endorsed(author: object, categories: Sequence[str]) -> None:
    """Refuse unless ``author`` is endorsed in every one of ``categories`` (``403``).

    Raises:
        CategoryNotEndorsed: naming every category the author has no active
            endorsement in.
    """
    missing = unendorsed_categories(author, categories)
    if missing:
        raise CategoryNotEndorsed(author, categories, missing)


# --------------------------------------------------------------------------- #
# The papers table
# --------------------------------------------------------------------------- #


def save_paper(
    *,
    paper_cid: str,
    categories: Sequence[str],
    licence: Optional[str] = None,
    status: str = INITIAL_STATUS,
    claimed: bool = True,
) -> Paper:
    """Store the paper a genesis record starts and return its ``papers`` row.

    ``short_id`` is derived from ``paper_cid``.  ``licence`` defaults to
    :data:`~.models.DEFAULT_LICENCE` when ``None``; the paper starts in
    ``status`` ``"preprint"`` with no versions and unlisted.

    Idempotent per ``paper_cid``: when a row already exists it is returned
    unchanged (a genesis's cid commits to its content, so a repeat can only be
    the same paper).

    Raises:
        ValueError: ``paper_cid`` is not a record cid, or ``categories`` is
            empty.
        ShortIdCollision: another paper already holds the derived short id.
    """
    categories = list(categories)
    if not categories:
        raise ValueError("a paper needs at least one category")
    short_id = derive_short_id(paper_cid)  # ValueError for a non-record cid

    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Paper, paper_cid)
        if row is None:
            row = Paper(
                paper_cid=paper_cid,
                short_id=short_id,
                categories=categories,
                licence=licence if licence is not None else DEFAULT_LICENCE,
                status=status,
                claimed=claimed,
            )
            session.add(row)
            try:
                session.commit()
            except IntegrityError:
                # Either another writer of this very cid got in first (so its
                # row is the one to keep), or the short id is held by a
                # different paper -- the only other UNIQUE constraint.
                session.rollback()
                row = session.get(Paper, paper_cid)
                if row is None:
                    raise ShortIdCollision(short_id, paper_cid) from None
            else:
                session.refresh(row)
        return row


def get_paper(paper_cid: object) -> Optional[Paper]:
    """Return the paper whose genesis cid is ``paper_cid``, or ``None``."""
    if not isinstance(paper_cid, str) or not paper_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        return session.get(Paper, paper_cid)


def get_paper_by_short_id(short_id: object) -> Optional[Paper]:
    """Return the paper with the ``sch:`` id ``short_id``, or ``None``."""
    if not isinstance(short_id, str) or not short_id:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        return session.query(Paper).filter(Paper.short_id == short_id).one_or_none()


# --------------------------------------------------------------------------- #
# The ingest handler
# --------------------------------------------------------------------------- #


def handle_paper_genesis(record: Mapping[str, Any]) -> str:
    """Validate a ``paper.genesis`` record and save its paper; return the state.

    Called by the ingest pipeline after the envelope, body schema, cid,
    signature and duplicate checks, and before the ledger append, so a refusal
    here stores nothing.  In order:

    1. the author must be tier 2 or higher -- ``403``
       (:class:`~app.modules.ingest.errors.InsufficientAuthorTier`).  The
       registry's ``min_tier`` makes ingest enforce the same floor first; it is
       repeated here so the semantics do not depend on that enforcement;
    2. the body's ``categories`` and ``licence`` must be usable -- ``422``
       (:class:`~app.modules.ingest.errors.InvalidRecord`);
    3. the author must be endorsed in every category -- ``403``
       (:class:`~.errors.CategoryNotEndorsed`);
    4. a tier-2 author younger than 90 days may start only one paper a week --
       ``429`` (:class:`~.errors.GenesisRateLimited`), naming the next allowed
       instant.  Older and higher-tier accounts are not limited;
    5. the paper is saved to ``papers`` -- ``409``
       (:class:`~.errors.ShortIdCollision`) if its short id is taken.

    Returns ``"accepted"``.
    """
    author = record.get("author")
    tier = author_tier(author)
    if tier < GENESIS_MIN_TIER:
        raise InsufficientAuthorTier(PAPER_GENESIS_TYPE, author, GENESIS_MIN_TIER, tier)

    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the paper.genesis body must be an object"],
            detail="The paper.genesis body must be a JSON object.",
        )
    paper_cid = _genesis_cid(record)
    categories = genesis_categories(body)
    licence = genesis_licence(body)

    require_endorsed(author, categories)
    enforce_genesis_quota(author, tier, paper_cid=paper_cid)
    save_paper(paper_cid=paper_cid, categories=categories, licence=licence)
    return "accepted"
