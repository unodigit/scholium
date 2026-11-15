"""Accepting a ``paper.version`` record (plugin: submissions, feature 50).

A ``paper.version`` record adds one version to an existing paper.  Its body
names the paper, the version number, the metadata the listed version shows and
the manifest record whose files are that version's files::

    {"paper": "bafyrei...",          # cid of the paper.genesis record
     "n": 1,                          # 1-based position in the version chain
     "title": "...",
     "abstract": "...",
     "authors": ["did:key:z6Mk...", {"did": "did:key:z6Mk...",
                                      "creditRoles": ["Conceptualization"],
                                      "position": 2}],
     "manifest": "bafyrei...",        # cid of the manifest record
     "licence": "CC-BY-4.0",
     "changeNote": "First version."}

The ingest pipeline (``POST /v1/records``) has already verified the envelope,
the body schema, the cid and the signature by the time
:func:`handle_paper_version` runs.  The handler adds the decisions the generic
pipeline cannot make and stores the version:

* the **author** -- the DID the signature authenticates -- must hold trust
  tier 2 (Author) or higher, the same floor a ``paper.genesis`` has, because
  publishing a version is publishing;
* ``body.paper`` must name a paper this node holds a ``paper.genesis`` record
  for -- in the ``papers`` table (feature 49) or at least in the event log.
  A version never creates the paper it belongs to;
* the record must **extend the current version chain**.  The chain is linear:
  the first version's envelope ``prev`` is the paper's genesis cid and its
  ``n`` is 1; every later version's ``prev`` is the cid of the paper's latest
  version and its ``n`` is that version's ``n`` plus one.  Anything else -- a
  stale ``prev`` (two authors editing the same draft, the UI's "new version"
  form opened before another version landed) or a number that is not one past
  the version ``prev`` names -- would fork or skip the timeline, so it is
  refused with ``409`` problem details (:class:`~.errors.VersionOutOfSequence`)
  and nothing is stored.  "Latest" is the highest ``n`` in ``paper_versions``,
  whatever state it is in: a version awaiting consent is still the tip of the
  chain a new version must name;
* accepting the record **saves the version** to ``paper_versions`` -- title,
  abstract, manifest cid, licence, change note and the ``prev`` cid -- in
  state :data:`AWAITING_CONSENT`, and its listed authors to ``authorship``
  with their byline positions and CRediT roles.  Consent is NULL on every row
  until the co-author signs a ``coauthor.consent`` (the consents plugin); the
  version stays ``awaiting_consent`` until every author has accepted, which is
  that plugin's rule (feature 55), not this one's.

What this module deliberately leaves alone
------------------------------------------

``papers.latest_version_cid`` and ``paper_versions.listed_at`` stay NULL here:
they describe the paper's *listed* state, which a version reaches through
scanning and moderation (features 52 and 79), not on acceptance.  No
notification is sent either; that is the notifications plugin's work
(feature 59).  The returned state is ``awaiting_consent``, which is also what
``POST /v1/records`` reports back to the client.

Saving a *new* version does emit its first ``version.state_changed`` event
(feature 52), from :data:`AWAITING_CONSENT` with no previous state, so a
subscriber that cares about a version entering consent (feature 59) sees it
exactly once.  A repeat of a version already stored emits nothing -- see
:mod:`app.modules.submissions.events`.

Refusals and side effects
-------------------------

The handler runs before the record is appended to the ledger, so refusing a
record (``403``/``409``/``422``) leaves nothing stored.  Saving is idempotent
per version cid: if the row already exists -- an earlier attempt saved it but
the ledger append then failed, or two submissions of the same record race --
the existing row is kept and the handler reports success, so a retry repairs
the gap instead of failing on it.  The database also enforces
``UNIQUE (paper_cid, n)``: two different versions racing for the same number
cannot both be stored.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional

from scholium_record_core import derive_short_id
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules.ingest import (
    PAPER_GENESIS_TYPE,
    PAPER_VERSION_TYPE,
    InsufficientAuthorTier,
    InvalidRecord,
    author_tier,
)
from app.security import Tier

from .errors import UnknownPaper, VersionOutOfSequence
from .events import VersionStateChanged, emit_state_changed
from .genesis import get_paper
from .models import Authorship, PaperVersion, ensure_tables

__all__ = [
    "AWAITING_CONSENT",
    "VERSION_MIN_TIER",
    "VERSION_STATES",
    "VersionAuthor",
    "VersionFields",
    "authorship_for",
    "expected_chain",
    "get_version",
    "handle_paper_version",
    "latest_version",
    "require_known_paper",
    "save_version",
    "version_authors",
    "version_fields",
    "versions_for_paper",
]

#: Lowest trust tier allowed to publish a version (tier 2, Author).  The same
#: floor as ``paper.genesis``: a version is a publication.
VERSION_MIN_TIER = int(Tier.AUTHOR)

#: The state a freshly accepted version starts in.  It is also the state the
#: handler reports back through ``POST /v1/records``.
AWAITING_CONSENT = "awaiting_consent"

#: Every state a version moves through, in order, as the spec names them.  The
#: transitions between them belong to the state-transition and consents
#: plugins (features 52 and 55); this constant fixes the vocabulary the
#: ``paper_versions.state`` column uses.
VERSION_STATES = (
    "awaiting_consent",
    "scanning",
    "moderation",
    "listed",
    "held",
    "rejected",
)

#: A ``did:`` identifier, exactly as the record core's ``paper.version`` schema
#: spells the pattern.
_DID_PATTERN = re.compile(r"^did:[a-z0-9]+:.+$")

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied value clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


def _invalid(field: str, message: str, kind: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad ``paper.version`` body field, located at ``body.<field>``."""
    shown = _clip(value)
    if not isinstance(shown, (str, int, float, bool, type(None))):
        shown = None
    full = f"The paper.version field {field!r} {message}."
    return InvalidRecord(
        [{"loc": ["body", field], "msg": full, "type": kind, "input": shown}],
        detail=full,
    )


def _invalid_author(index: int, message: str, kind: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad entry in ``body.authors``, located at its index."""
    shown = _clip(value)
    if not isinstance(shown, (str, int, float, bool, type(None))):
        shown = None
    full = f"Author {index + 1} of a paper.version {message}."
    return InvalidRecord(
        [
            {
                "loc": ["body", "authors", index],
                "msg": full,
                "type": kind,
                "input": shown,
            }
        ],
        detail=full,
    )


# --------------------------------------------------------------------------- #
# Reading the body
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class VersionAuthor:
    """One author listed on a version: their DID, byline position and CRediT roles."""

    #: The author's ``did:`` identifier.
    did: str
    #: 1-based byline position: the record's own ``position``, or the entry's
    #: place in ``body.authors`` when it names none.
    position: int
    #: CRediT roles the record names, or ``None`` when it names none.
    credit_roles: Optional[tuple[str, ...]]


@dataclass(frozen=True)
class VersionFields:
    """The parts of a ``paper.version`` body this plugin stores, validated."""

    paper_cid: str
    n: int
    title: str
    abstract: str
    manifest_cid: str
    licence: str
    change_note: Optional[str]
    authors: tuple[VersionAuthor, ...]


def _required_text(body: Mapping[str, Any], field: str, *, allow_empty: bool = False) -> str:
    """Return ``body[field]`` as a non-empty (or possibly empty) string, or ``422``."""
    value = body.get(field)
    if not isinstance(value, str) or (not value and not allow_empty):
        requirement = "a string" if allow_empty else "a non-empty string"
        raise _invalid(field, f"must be {requirement}", f"invalid_{field}", value)
    return value


def _paper_cid(body: Mapping[str, Any]) -> str:
    """Return ``body.paper`` as a record cid, or ``422`` when it cannot be one."""
    value = body.get("paper")
    if not isinstance(value, str) or not value:
        raise _invalid("paper", "must be a non-empty record cid", "invalid_paper", value)
    try:
        derive_short_id(value)
    except ValueError:
        raise _invalid(
            "paper",
            "must be the cid of a paper.genesis record",
            "invalid_paper",
            value,
        ) from None
    return value


def _version_number(body: Mapping[str, Any]) -> int:
    """Return ``body.n`` as an integer of at least 1, or ``422``."""
    value = body.get("n")
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _invalid(
            "n",
            "must be an integer of at least 1",
            "invalid_version_number",
            value,
        )
    return value


def _licence(body: Mapping[str, Any]) -> str:
    """Return ``body.licence`` trimmed of surrounding whitespace, or ``422``."""
    value = body.get("licence")
    if not isinstance(value, str) or not value.strip():
        raise _invalid("licence", "must be a non-blank licence identifier", "invalid_licence", value)
    return value.strip()


def _change_note(body: Mapping[str, Any]) -> Optional[str]:
    """Return ``body.changeNote``, or ``None`` when absent or null."""
    value = body.get("changeNote")
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid("changeNote", "must be a string", "invalid_change_note", value)
    return value


def _credit_roles(item: Mapping[str, Any], index: int) -> Optional[tuple[str, ...]]:
    """Return an author entry's CRediT roles as a tuple, or ``None`` when it names none."""
    value = item.get("creditRoles") if "creditRoles" in item else item.get("credit")
    if value is None:
        return None
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise _invalid_author(
            index, "must list its credit roles", "invalid_credit_roles", value
        )
    roles: list[str] = []
    for role in value:
        if not isinstance(role, str) or not role:
            raise _invalid_author(
                index,
                "must list only non-empty credit role names",
                "invalid_credit_roles",
                role,
            )
        roles.append(role)
    return tuple(roles)


def _author_position(item: Mapping[str, Any], index: int) -> int:
    """Return an author entry's byline position, defaulting to its list position."""
    value = item.get("position")
    if value is None:
        return index + 1
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _invalid_author(
            index, "must have a position of at least 1", "invalid_author_position", value
        )
    return value


def version_authors(body: Mapping[str, Any]) -> list[VersionAuthor]:
    """Return the authors a version body lists, in byline position order.

    An entry is either a ``did:`` string or an object with ``did``, optional
    ``creditRoles`` (or ``credit``) and optional ``position``.  Entries keep
    the order the record lists them in unless they name a ``position`` of
    their own; the result is sorted by position, so a reader always sees the
    byline the record meant rather than the order a JSON array happened to be
    written in.

    Raises:
        InvalidRecord: ``422`` when ``authors`` is not a non-empty list, an
            entry is neither a ``did:`` string nor an object carrying one, a
            DID is repeated, or a role/position is unusable.
    """
    value = body.get("authors")
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
        raise _invalid(
            "authors",
            "must be a non-empty list of authors",
            "invalid_authors",
            value,
        )

    authors: list[VersionAuthor] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if isinstance(item, str):
            did: Any = item
            roles: Optional[tuple[str, ...]] = None
            position = index + 1
        elif isinstance(item, Mapping):
            did = item.get("did")
            roles = _credit_roles(item, index)
            position = _author_position(item, index)
        else:
            raise _invalid_author(
                index, "must be a did: string or an object naming one", "invalid_author", item
            )

        if not isinstance(did, str) or not _DID_PATTERN.match(did):
            raise _invalid_author(
                index, "must be a did: identifier", "invalid_author_did", did
            )
        if did in seen:
            raise _invalid_author(
                index, f"repeats the author {_clip(did)!r}", "duplicate_author", did
            )
        seen.add(did)
        authors.append(VersionAuthor(did=did, position=position, credit_roles=roles))

    return sorted(authors, key=lambda author: author.position)


def version_fields(body: Mapping[str, Any]) -> VersionFields:
    """Validate a ``paper.version`` body and return the fields this plugin stores.

    The ingest pipeline's schema check normally runs first; this re-checks the
    shape so a direct caller gets ``422`` problem details rather than a
    ``TypeError`` or a half-written row.

    Raises:
        InvalidRecord: ``422`` when the body is not an object or a field this
            plugin stores is unusable.
    """
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the paper.version body must be an object"],
            detail="The paper.version body must be a JSON object.",
        )
    return VersionFields(
        paper_cid=_paper_cid(body),
        n=_version_number(body),
        title=_required_text(body, "title"),
        abstract=_required_text(body, "abstract", allow_empty=True),
        manifest_cid=_required_text(body, "manifest"),
        licence=_licence(body),
        change_note=_change_note(body),
        authors=tuple(version_authors(body)),
    )


# --------------------------------------------------------------------------- #
# The version chain
# --------------------------------------------------------------------------- #


def latest_version(paper_cid: object) -> Optional[PaperVersion]:
    """Return the paper's highest-numbered version, or ``None`` when it has none.

    "Latest" is by ``n``, not by acceptance time: the chain is defined by
    version numbers, and ``UNIQUE (paper_cid, n)`` keeps that unambiguous.
    """
    if not isinstance(paper_cid, str) or not paper_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        return (
            session.query(PaperVersion)
            .filter(PaperVersion.paper_cid == paper_cid)
            .order_by(PaperVersion.n.desc())
            .first()
        )


def versions_for_paper(paper_cid: object) -> list[PaperVersion]:
    """Return every stored version of ``paper_cid``, oldest first."""
    if not isinstance(paper_cid, str) or not paper_cid:
        return []
    ensure_tables()
    with db.SessionLocal() as session:
        return (
            session.query(PaperVersion)
            .filter(PaperVersion.paper_cid == paper_cid)
            .order_by(PaperVersion.n)
            .all()
        )


def get_version(version_cid: object) -> Optional[PaperVersion]:
    """Return the version whose record cid is ``version_cid``, or ``None``."""
    if not isinstance(version_cid, str) or not version_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        return session.get(PaperVersion, version_cid)


def authorship_for(version_cid: object) -> list[Authorship]:
    """Return a version's authorship rows in byline order."""
    if not isinstance(version_cid, str) or not version_cid:
        return []
    ensure_tables()
    with db.SessionLocal() as session:
        return (
            session.query(Authorship)
            .filter(Authorship.version_cid == version_cid)
            .order_by(Authorship.position, Authorship.author_did)
            .all()
        )


def expected_chain(paper_cid: str) -> tuple[str, int]:
    """Return the ``(prev, n)`` the next version of ``paper_cid`` must carry.

    For a paper with no versions that is the genesis cid and 1; otherwise it
    is the latest version's cid and its ``n`` plus one.
    """
    latest = latest_version(paper_cid)
    if latest is None:
        return paper_cid, 1
    return latest.version_cid, int(latest.n) + 1


def require_known_paper(paper_cid: str) -> None:
    """Refuse unless this node holds the paper's ``paper.genesis``: ``422``.

    A paper is known when the ``papers`` table has its row (the genesis
    handler saved it, feature 49) or, at minimum, when the event log holds
    the genesis record under that cid -- so a node that stores records
    without deriving rows can still accept versions, but a version can never
    introduce a paper.

    Raises:
        UnknownPaper: ``422`` naming ``body.paper``.
    """
    if get_paper(paper_cid) is not None:
        return
    try:
        from app.modules import ledger
    except ImportError:  # pragma: no cover - ledger is a shipped plugin
        raise UnknownPaper(paper_cid) from None
    entry = ledger.entry_by_cid(paper_cid)
    if entry is not None and getattr(entry, "record_type", None) == PAPER_GENESIS_TYPE:
        return
    raise UnknownPaper(paper_cid)


# --------------------------------------------------------------------------- #
# The tables
# --------------------------------------------------------------------------- #


def save_version(
    *,
    version_cid: str,
    paper_cid: str,
    n: int,
    title: str,
    abstract: str,
    manifest_cid: str,
    licence: str,
    prev_cid: Optional[str],
    change_note: Optional[str] = None,
    authors: Sequence[VersionAuthor] = (),
    state: str = AWAITING_CONSENT,
) -> PaperVersion:
    """Store one version and its authorship rows; return the ``paper_versions`` row.

    The version and its authors are written in one transaction, so a reader
    never sees a version whose byline is missing.

    Idempotent per ``version_cid``: when the row already exists it is returned
    unchanged (a version's cid commits to its content, so a repeat can only be
    the same version).  The authors are only written with a new row for the
    same reason.

    A newly written row emits one ``version.state_changed`` event with
    ``previous_state=None`` (feature 52); a repeat does not, so the event says
    "this version exists in this state" exactly once.

    Raises:
        IntegrityError: when another version already holds ``(paper_cid, n)``.
            The handler turns that race into ``409`` problem details; a direct
            caller sees the database error rather than a silently forked chain.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise ValueError("a non-empty version_cid is required")

    ensure_tables()
    created = False
    with db.SessionLocal() as session:
        existing = session.get(PaperVersion, version_cid)
        if existing is not None:
            session.expunge(existing)
            return existing

        row = PaperVersion(
            version_cid=version_cid,
            paper_cid=paper_cid,
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid=manifest_cid,
            licence=licence,
            prev_cid=prev_cid,
            state=state,
            change_note=change_note,
        )
        session.add(row)
        for author in authors:
            session.add(
                Authorship(
                    version_cid=version_cid,
                    author_did=author.did,
                    position=author.position,
                    credit_roles=list(author.credit_roles)
                    if author.credit_roles is not None
                    else None,
                )
            )
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            existing = session.get(PaperVersion, version_cid)
            if existing is not None:
                session.expunge(existing)
                return existing
            raise
        created = True
        session.refresh(row)
        saved_paper_cid = row.paper_cid
        saved_n = int(row.n)
        saved_state = row.state
        session.expunge(row)

    if created:
        # Published only after the commit: a subscriber never sees a state the
        # database does not have, and a race that stored the row first still
        # emits exactly once (the loser returned above without reaching here).
        emit_state_changed(
            VersionStateChanged(
                version_cid=version_cid,
                paper_cid=saved_paper_cid,
                n=saved_n,
                state=saved_state,
                previous_state=None,
            )
        )
    return row


# --------------------------------------------------------------------------- #
# The ingest handler
# --------------------------------------------------------------------------- #


def _version_cid(record: Mapping[str, Any]) -> str:
    """The record's cid, which is also the version's id (``422`` when unusable)."""
    record_id = record.get("id")
    message = "The paper.version record must carry its cid as a non-empty string in 'id'."
    if not isinstance(record_id, str) or not record_id:
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )
    try:
        derive_short_id(record_id)
    except ValueError as exc:
        text = f"The paper.version record id is not a record cid: {exc}"
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": text, "type": "invalid_record_id", "input": None}],
            detail=text,
        ) from exc
    return record_id


def handle_paper_version(record: Mapping[str, Any]) -> str:
    """Validate a ``paper.version`` record, save the version, and return its state.

    Called by the ingest pipeline after the envelope, body schema, cid,
    signature and duplicate checks, and before the ledger append, so a refusal
    here stores nothing.  In order:

    1. the author must be tier 2 or higher -- ``403``
       (:class:`~app.modules.ingest.errors.InsufficientAuthorTier`);
    2. the body's stored fields must be usable -- ``422``
       (:class:`~app.modules.ingest.errors.InvalidRecord`);
    3. ``body.paper`` must be a paper this node holds -- ``422``
       (:class:`~.errors.UnknownPaper`);
    4. the envelope ``prev`` and body ``n`` must extend the current version
       chain -- ``409`` (:class:`~.errors.VersionOutOfSequence`);
    5. the version and its authorship rows are saved in
       :data:`AWAITING_CONSENT`, and that state is returned.

    A version that loses a race to extend the chain is refused with the same
    ``409`` rather than a database error.
    """
    author = record.get("author")
    tier = author_tier(author)
    if tier < VERSION_MIN_TIER:
        raise InsufficientAuthorTier(PAPER_VERSION_TYPE, author, VERSION_MIN_TIER, tier)

    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the paper.version body must be an object"],
            detail="The paper.version body must be a JSON object.",
        )
    fields = version_fields(body)
    version_cid = _version_cid(record)

    if get_version(version_cid) is not None:
        # Already applied.  The record's cid commits to its content, so this
        # can only be the same version: a retry after the ledger append that
        # followed the first attempt failed.  Report success instead of
        # failing the chain check the first attempt itself now satisfies.
        return AWAITING_CONSENT

    require_known_paper(fields.paper_cid)

    expected_prev, expected_n = expected_chain(fields.paper_cid)
    submitted_prev = record.get("prev")
    if submitted_prev != expected_prev or fields.n != expected_n:
        raise VersionOutOfSequence(
            fields.paper_cid,
            expected_prev=expected_prev,
            expected_n=expected_n,
            submitted_prev=submitted_prev,
            submitted_n=fields.n,
        )

    try:
        save_version(
            version_cid=version_cid,
            paper_cid=fields.paper_cid,
            n=fields.n,
            title=fields.title,
            abstract=fields.abstract,
            manifest_cid=fields.manifest_cid,
            licence=fields.licence,
            prev_cid=expected_prev,
            change_note=fields.change_note,
            authors=fields.authors,
        )
    except IntegrityError:
        # Another writer extended the same paper's chain between our check
        # and our insert; report it as the chain conflict it is.
        expected_prev, expected_n = expected_chain(fields.paper_cid)
        raise VersionOutOfSequence(
            fields.paper_cid,
            expected_prev=expected_prev,
            expected_n=expected_n,
            submitted_prev=submitted_prev,
            submitted_n=fields.n,
        ) from None
    return AWAITING_CONSENT
