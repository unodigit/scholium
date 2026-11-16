"""Accepting withdrawal, correction and retraction records (plugin: submissions, feature 53).

Three record types tell readers that a paper is no longer what it was::

    {"target": "bafyrei...",         # cid of the paper's genesis or of a version
     "paper":  "bafyrei...",         # optional: the paper's genesis cid
     "reason": "The dataset was mislabelled.",
     "reasonCid": "bafkrei...",      # or, instead of ``reason``: a stored file
     "replacement": "bafyrei..."}    # correction/retraction only; optional

* ``withdrawal`` -- the authors take the paper back;
* ``correction`` -- the paper stays, with a notice of what was wrong;
* ``retraction`` -- the paper's claims no longer stand.

The ingest pipeline (``POST /v1/records``) has already verified the envelope,
the body schema, the cid and the signature by the time a handler here runs.  The
handlers add the decisions the generic pipeline cannot make and save the notice
to the ``notices`` table:

* **who may sign.**  The author -- the DID the signature authenticates, not
  whoever relays the record -- must be an author of the paper or hold trust
  tier 4 (Moderator).  Anyone else is refused with ``403``
  (:class:`~.errors.NoticeNotAuthorized`).  "An author of the paper" is the
  definition the independent verifier (:func:`scholium_record_core.verify_paper`)
  applies when it decides whether a notice is *authorized*: whoever signed the
  paper's genesis, whoever signed one of its versions, or anyone listed on one
  of its versions.  A node that accepted a notice the verifier then reports as
  unauthorized would be telling readers something a replay contradicts;
* **what it is about.**  ``body.target`` must be the cid of a paper's
  ``paper.genesis`` or of one of its versions, found in ``papers`` or
  ``paper_versions`` -- or, at minimum, in the event log, the way
  :func:`~.versions.require_known_paper` accepts a version.  Anything else is a
  ``422`` (:class:`~.errors.UnknownNoticeTarget`).  When the record also names
  ``body.paper`` it must be the paper the target belongs to;
* **why.**  ``reason`` is the text readers are shown.  A record may instead
  carry ``reasonCid``, naming a file in the content store; the handler reads
  that file (UTF-8 text, at most :data:`MAX_REASON_BYTES`) so ``notices.reason``
  -- NOT NULL -- always holds something a reader can read.  A file the node
  does not hold, one moderation tombstoned, or one that is not usable text is a
  ``422``.  When both are present a non-blank ``reason`` wins.

Every version shows the notice
------------------------------

A notice that names version 2 still belongs to the *paper*: the row's
``paper_cid`` is the paper's genesis cid whichever record the notice targeted,
so :func:`notices_for_paper` returns it for version 1, version 2 and every
version after, which is what the catalog serves under each of them.

What a row holds
----------------

``record_cid`` is the notice record's cid, ``kind`` its type and ``reason`` the
text above.  ``created_at`` is the instant the *record* is dated (``created``,
converted to UTC), not the instant this node received it, so the table is a
pure projection of the signed records and rebuilding it from the ledger yields
the same rows.  A ``created`` that is not an ISO 8601 instant is a ``422``: the
envelope check only requires a string.

What this module deliberately leaves alone
------------------------------------------

``papers.status`` is not touched.  Computing it from notices, moderation and
reviews is the ``status`` plugin's work (``compute_status``), and a withdrawal
is not a retraction -- the six statuses have no *withdrawn*.  ``replacement``
is not stored either: the table has no column for it, and the signed record the
ledger serves under ``record_cid`` carries it.

Refusals and side effects
-------------------------

The handlers run before the record is appended to the ledger, so a refusal
(``403``/``422``) stores nothing.  Saving is idempotent per cid: if the row
already exists -- an earlier attempt saved it but the ledger append then failed
-- it is kept and the handler reports success, so a retry repairs the gap.

Registered with ``min_tier=0``: who may sign is not a tier floor (a co-author
may be tier 1) but "author of this paper, or tier 4", which only the handler can
decide, as the ``coauthor.consent`` handler decides who may consent.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import content
from app.modules.content import store as content_store
from app.modules.ingest import InvalidRecord, author_tier
from app.security import Tier

from .errors import NoticeNotAuthorized, UnknownNoticeTarget
from .genesis import get_paper
from .models import Authorship, Notice, ensure_tables
from .versions import get_version, versions_for_paper

__all__ = [
    "CORRECTION_TYPE",
    "MAX_REASON_BYTES",
    "NOTICE_MIN_TIER",
    "NOTICE_OVERRIDE_TIER",
    "NOTICE_TYPES",
    "RETRACTION_TYPE",
    "WITHDRAWAL_TYPE",
    "NoticeFields",
    "NoticeTarget",
    "get_notice",
    "handle_correction",
    "handle_retraction",
    "handle_withdrawal",
    "notice_fields",
    "notices_for_paper",
    "all_paper_authors",
    "paper_authors",
    "read_reason_file",
    "require_authorized",
    "resolve_target",
    "save_notice",
]

#: The record types this module owns, and the ``notices.kind`` each is stored as.
WITHDRAWAL_TYPE = "withdrawal"
CORRECTION_TYPE = "correction"
RETRACTION_TYPE = "retraction"
NOTICE_TYPES = (WITHDRAWAL_TYPE, CORRECTION_TYPE, RETRACTION_TYPE)

#: Lowest trust tier the registry lets through.  Who may sign is decided by the
#: handler (paper author or tier 4), not by a floor -- see the module docstring.
NOTICE_MIN_TIER = 0

#: The tier that may sign a notice for any paper (tier 4, Moderator).
NOTICE_OVERRIDE_TIER = int(Tier.MODERATOR)

#: The largest ``reasonCid`` file that is read into ``notices.reason``.  A
#: reason is a paragraph, not a document; the cap keeps a crafted record from
#: making the node load an arbitrary file into a text column.
MAX_REASON_BYTES = 64 * 1024

#: What ``POST /v1/records`` reports for an accepted notice.
_ACCEPTED = "accepted"

_PAPER_GENESIS = "paper.genesis"
_PAPER_VERSION = "paper.version"

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied string clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


def _invalid(kind: str, loc: list[Any], message: str, error_type: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad field of a notice record, located at ``loc``."""
    shown = _clip(value)
    if not isinstance(shown, (str, int, float, bool, type(None))):
        shown = None
    full = f"The {kind} {message}."
    return InvalidRecord(
        [{"loc": loc, "msg": full, "type": error_type, "input": shown}],
        detail=full,
    )


# --------------------------------------------------------------------------- #
# Reading the record
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class NoticeFields:
    """The parts of a notice record this plugin stores, shape-checked.

    ``reason`` is the text the record carries; it is ``None`` when the record
    names only a ``reasonCid``, which :func:`read_reason_file` resolves once the
    signer is known to be allowed to publish the notice.
    """

    kind: str
    target: str
    paper_cid: Optional[str]
    reason: Optional[str]
    reason_cid: Optional[str]
    created_at: datetime


def _text_field(kind: str, body: Mapping[str, Any], field: str, *, required: bool) -> Optional[str]:
    """Return ``body[field]`` as a non-empty string; ``None`` when optional and absent."""
    value = body.get(field)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value:
        raise _invalid(
            kind,
            ["body", field],
            f"field {field!r} must be a non-empty string",
            f"invalid_{field}",
            value,
        )
    return value


def _created_at(kind: str, record: Mapping[str, Any]) -> datetime:
    """Return the record's ``created`` as a naive UTC datetime, or ``422``.

    A timestamp without an offset is read as UTC.  The envelope check only
    requires ``created`` to be a string, so a value that is not an ISO 8601
    instant reaches this point and is refused here.
    """
    value = record.get("created")
    try:
        moment = datetime.fromisoformat(value.strip()) if isinstance(value, str) else None
    except ValueError:
        moment = None
    if moment is None:
        raise _invalid(
            kind,
            ["created"],
            "field 'created' must be an ISO 8601 instant",
            "invalid_created",
            value,
        )
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).replace(tzinfo=None)


def notice_fields(kind: str, record: Mapping[str, Any]) -> NoticeFields:
    """Shape-check a notice record and return the fields this plugin stores.

    The ingest pipeline's schema check normally runs first; this re-checks the
    shape so a direct caller gets ``422`` problem details rather than a
    ``TypeError`` or a half-written row.  Nothing is read from the database or
    the content store here.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, ``target`` is
            missing, neither a usable ``reason`` nor a ``reasonCid`` is given,
            or ``created`` is not an ISO 8601 instant.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            [f"the {kind} body must be an object"],
            detail=f"The {kind} body must be a JSON object.",
        )

    target = _text_field(kind, body, "target", required=True)
    assert target is not None
    paper_cid = _text_field(kind, body, "paper", required=False)

    reason_value = body.get("reason")
    if reason_value is not None and not isinstance(reason_value, str):
        raise _invalid(
            kind, ["body", "reason"], "field 'reason' must be a string", "invalid_reason", reason_value
        )
    reason = reason_value.strip() if isinstance(reason_value, str) else ""
    reason_cid = _text_field(kind, body, "reasonCid", required=False)
    if not reason and reason_cid is None:
        raise _invalid(
            kind,
            ["body", "reason"],
            "needs a reason: a non-blank 'reason' or a 'reasonCid'",
            "missing_reason",
            reason_value,
        )

    return NoticeFields(
        kind=kind,
        target=target,
        paper_cid=paper_cid,
        reason=reason or None,
        reason_cid=reason_cid,
        created_at=_created_at(kind, record),
    )


def _record_cid(kind: str, record: Mapping[str, Any]) -> str:
    """The record's cid, which is also the notice's id (``422`` when unusable)."""
    record_id = record.get("id")
    if not isinstance(record_id, str) or not record_id:
        message = f"The {kind} record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )
    return record_id


# --------------------------------------------------------------------------- #
# The target
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class NoticeTarget:
    """The paper a notice is about, and the version it named, if it named one."""

    #: cid of the paper's ``paper.genesis`` record.
    paper_cid: str
    #: cid of the version the notice named, or ``None`` when it named the paper.
    version_cid: Optional[str]


def resolve_target(kind: str, target: object) -> NoticeTarget:
    """Find the paper ``target`` belongs to, or refuse with ``422``.

    ``target`` is a paper (its genesis cid) or one of its versions.  The tables
    are consulted first (``papers``, then ``paper_versions``); when neither has
    it the event log is, so a node that stores records without deriving rows
    still accepts notices for papers it holds.  A cid the log holds for any
    other record type is not a paper.

    Raises:
        UnknownNoticeTarget: ``422`` naming ``body.target``.
    """
    if isinstance(target, str) and target:
        if get_paper(target) is not None:
            return NoticeTarget(paper_cid=target, version_cid=None)
        version = get_version(target)
        if version is not None:
            return NoticeTarget(paper_cid=str(version.paper_cid), version_cid=target)

        from app.modules import ledger

        entry = ledger.entry_by_cid(target)
        if entry is not None:
            if entry.record_type == _PAPER_GENESIS:
                return NoticeTarget(paper_cid=target, version_cid=None)
            if entry.record_type == _PAPER_VERSION:
                paper = entry.body.get("paper") if isinstance(entry.body, Mapping) else None
                if isinstance(paper, str) and paper:
                    return NoticeTarget(paper_cid=paper, version_cid=target)
    raise UnknownNoticeTarget(kind, target)


def _check_named_paper(kind: str, fields: NoticeFields, resolved: NoticeTarget) -> None:
    """``body.paper``, when given, must be the paper the target belongs to (``422``)."""
    if fields.paper_cid is not None and fields.paper_cid != resolved.paper_cid:
        raise _invalid(
            kind,
            ["body", "paper"],
            "field 'paper' is not the paper its target belongs to",
            "paper_target_mismatch",
            fields.paper_cid,
        )


# --------------------------------------------------------------------------- #
# Who may sign
# --------------------------------------------------------------------------- #


def all_paper_authors(paper_cid: str) -> frozenset[str]:
    """All DIDs on the byline of ``paper_cid`` (regardless of consent).

    The signer of the paper's genesis, the signer of each of its versions, and
    every DID listed on any version.  Used where byline membership is what
    matters regardless of consent (e.g. conflict-of-interest checks).
    """
    from app.modules import ledger

    authors: set[str] = set()
    genesis = ledger.entry_by_cid(paper_cid)
    if genesis is not None and genesis.record_type == _PAPER_GENESIS:
        authors.add(str(genesis.author_did))

    version_cids = [str(version.version_cid) for version in versions_for_paper(paper_cid)]
    for version_cid in version_cids:
        entry = ledger.entry_by_cid(version_cid)
        if entry is not None:
            authors.add(str(entry.author_did))

    if version_cids:
        ensure_tables()
        with db.SessionLocal() as session:
            rows = (
                session.query(Authorship.author_did)
                .filter(Authorship.version_cid.in_(version_cids))
                .all()
            )
        authors.update(str(did) for (did,) in rows)
    return frozenset(authors)


def paper_authors(paper_cid: str) -> frozenset[str]:
    """DIDs that may sign a notice for ``paper_cid`` beyond tier-4 members.

    The paper's genesis signer and every version's signer may, as before.  A
    DID that is merely *listed* on a version may do so only once it has
    accepted its ``coauthor.consent`` for that version: a co-author who never
    consented, or who declined, cannot speak for the paper.  Consents are read
    through the consents plugin so a decision recorded in the ledger (a replay
    or a fixture) is honoured even when the derived ``authorship`` table is
    stale.
    """
    from app.modules import ledger

    authors: set[str] = set()
    genesis = ledger.entry_by_cid(paper_cid)
    if genesis is not None and genesis.record_type == _PAPER_GENESIS:
        authors.add(str(genesis.author_did))

    version_cids = [str(version.version_cid) for version in versions_for_paper(paper_cid)]
    for version_cid in version_cids:
        entry = ledger.entry_by_cid(version_cid)
        if entry is not None:
            authors.add(str(entry.author_did))

    if version_cids:
        ensure_tables()
        accepted_listed: set[str] = set()
        try:
            from app.modules import consents as consents_module
        except Exception:  # pragma: no cover - consents always ships with the app
            consents_module = None

        if consents_module is not None:
            for version_cid in version_cids:
                try:
                    for entry in consents_module.consents_for_version(version_cid):
                        if getattr(entry, "status", None) == "signed":
                            did = getattr(entry, "did", None)
                            if isinstance(did, str) and did:
                                accepted_listed.add(did)
                except Exception:
                    pass

        # Trust an explicit ``accept`` recorded on the authorship row too, so a
        # stale or unavailable consents projection cannot drop a real author.
        with db.SessionLocal() as session:
            rows = (
                session.query(Authorship.author_did, Authorship.consent_decision)
                .filter(Authorship.version_cid.in_(version_cids))
                .all()
            )
        for did, decision in rows:
            if decision == "accept":
                accepted_listed.add(str(did))

        authors.update(accepted_listed)

    return frozenset(authors)


def require_authorized(kind: str, author: object, paper_cid: str) -> None:
    """Refuse unless ``author`` may sign a ``kind`` notice for ``paper_cid`` (``403``).

    A tier-4 member may; so may anyone :func:`paper_authors` lists.
    The tier is read first, because it needs one lookup and no walk of the
    paper's records.

    Raises:
        NoticeNotAuthorized: ``403``.
    """
    if author_tier(author) >= NOTICE_OVERRIDE_TIER:
        return
    if isinstance(author, str) and author in paper_authors(paper_cid):
        return
    raise NoticeNotAuthorized(kind, author, paper_cid, NOTICE_OVERRIDE_TIER)


# --------------------------------------------------------------------------- #
# The reason
# --------------------------------------------------------------------------- #


def read_reason_file(kind: str, cid: str) -> str:
    """Read the reason a record keeps in the content store, or refuse with ``422``.

    Raises:
        InvalidRecord: ``422`` located at ``body.reasonCid`` when the node does
            not hold the file, moderation tombstoned it, it is larger than
            :data:`MAX_REASON_BYTES`, or it is not non-blank UTF-8 text.
    """

    def refuse(message: str, error_type: str) -> InvalidRecord:
        return _invalid(kind, ["body", "reasonCid"], message, error_type, cid)

    blob = content.get_blob(cid)
    if blob is None:
        raise refuse(
            f"names a reasonCid {_clip(cid)!r} that is not in the content store",
            "reason_not_stored",
        )
    if content.is_tombstoned(cid):
        raise refuse(
            f"names a reasonCid {_clip(cid)!r} that has been removed",
            "reason_tombstoned",
        )
    if int(blob.size) > MAX_REASON_BYTES:
        raise refuse(
            f"names a reasonCid file larger than {MAX_REASON_BYTES} bytes",
            "reason_too_large",
        )
    try:
        with content_store.open_blob(cid) as handle:
            data = handle.read(MAX_REASON_BYTES + 1)
    except (FileNotFoundError, ValueError):
        raise refuse(
            f"names a reasonCid {_clip(cid)!r} whose bytes are not in the content store",
            "reason_not_stored",
        ) from None
    if len(data) > MAX_REASON_BYTES:
        raise refuse(
            f"names a reasonCid file larger than {MAX_REASON_BYTES} bytes",
            "reason_too_large",
        )
    try:
        text = data.decode("utf-8").strip()
    except UnicodeDecodeError:
        text = ""
    if not text:
        raise refuse(
            "names a reasonCid file that is not non-blank UTF-8 text",
            "reason_unreadable",
        )
    return text


# --------------------------------------------------------------------------- #
# The notices table
# --------------------------------------------------------------------------- #


def save_notice(
    *,
    record_cid: str,
    paper_cid: str,
    kind: str,
    reason: str,
    created_at: datetime,
) -> Notice:
    """Store one notice and return its ``notices`` row.

    Idempotent per ``record_cid``: when the row already exists it is returned
    unchanged (a record's cid commits to its content, so a repeat can only be
    the same notice).

    Raises:
        ValueError: ``record_cid``, ``paper_cid`` or ``reason`` is empty, or
            ``kind`` is not one of :data:`NOTICE_TYPES`.
    """
    if not isinstance(record_cid, str) or not record_cid:
        raise ValueError("a non-empty record_cid is required")
    if not isinstance(paper_cid, str) or not paper_cid:
        raise ValueError("a non-empty paper_cid is required")
    if kind not in NOTICE_TYPES:
        raise ValueError(f"a notice is one of {', '.join(NOTICE_TYPES)}, not {kind!r}")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("a notice needs a non-blank reason")

    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Notice, record_cid)
        if row is None:
            row = Notice(
                record_cid=record_cid,
                paper_cid=paper_cid,
                kind=kind,
                reason=reason,
                created_at=created_at,
            )
            session.add(row)
            try:
                session.commit()
            except IntegrityError:
                # Another writer of this very cid got in first; its row is the
                # one to keep (the cid is the only UNIQUE constraint).
                session.rollback()
                row = session.get(Notice, record_cid)
                if row is None:
                    raise
            else:
                session.refresh(row)
        session.expunge(row)
        return row


def get_notice(record_cid: object) -> Optional[Notice]:
    """Return the notice saved for the record ``record_cid``, or ``None``."""
    if not isinstance(record_cid, str) or not record_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Notice, record_cid)
        if row is not None:
            session.expunge(row)
        return row


def notices_for_paper(paper_cid: object) -> list[Notice]:
    """Return every notice on ``paper_cid``, oldest first.

    This is what every version of the paper shows: a notice belongs to the
    paper, whichever version it named.  Ties on ``created_at`` break by
    ``record_cid`` so the order is stable.
    """
    if not isinstance(paper_cid, str) or not paper_cid:
        return []
    ensure_tables()
    with db.SessionLocal() as session:
        rows = (
            session.query(Notice)
            .filter(Notice.paper_cid == paper_cid)
            .order_by(Notice.created_at, Notice.record_cid)
            .all()
        )
        session.expunge_all()
        return rows


# --------------------------------------------------------------------------- #
# The ingest handlers
# --------------------------------------------------------------------------- #


def _handle_notice(kind: str, record: Mapping[str, Any]) -> str:
    """Validate a notice record, save it, and return the state ``POST /v1/records`` reports.

    Called by the ingest pipeline after the envelope, body schema, cid,
    signature and duplicate checks, and before the ledger append, so a refusal
    here stores nothing.  In order:

    1. the record's cid and body must be usable -- ``422``
       (:class:`~app.modules.ingest.errors.InvalidRecord`);
    2. ``body.target`` must be a paper or version this node holds, and
       ``body.paper`` (when given) the paper it belongs to -- ``422``
       (:class:`~.errors.UnknownNoticeTarget`, ``InvalidRecord``);
    3. the author must be an author of that paper or tier 4 -- ``403``
       (:class:`~.errors.NoticeNotAuthorized`);
    4. a ``reasonCid`` is read from the content store -- ``422``;
    5. the notice is saved to ``notices`` under the paper's cid.

    The author is checked before the content store is read, so a signer with no
    standing cannot make the node open files.
    """
    record_cid = _record_cid(kind, record)
    fields = notice_fields(kind, record)

    if get_notice(record_cid) is not None:
        # Already applied.  The record's cid commits to its content, so this can
        # only be the same notice: a retry after the ledger append that followed
        # the first attempt failed.
        return _ACCEPTED

    resolved = resolve_target(kind, fields.target)
    _check_named_paper(kind, fields, resolved)
    require_authorized(kind, record.get("author"), resolved.paper_cid)

    reason = fields.reason
    if reason is None:
        assert fields.reason_cid is not None
        reason = read_reason_file(kind, fields.reason_cid)

    save_notice(
        record_cid=record_cid,
        paper_cid=resolved.paper_cid,
        kind=kind,
        reason=reason,
        created_at=fields.created_at,
    )
    return _ACCEPTED


def handle_withdrawal(record: Mapping[str, Any]) -> str:
    """Ingest handler for ``withdrawal`` records; see :func:`_handle_notice`."""
    return _handle_notice(WITHDRAWAL_TYPE, record)


def handle_correction(record: Mapping[str, Any]) -> str:
    """Ingest handler for ``correction`` records; see :func:`_handle_notice`."""
    return _handle_notice(CORRECTION_TYPE, record)


def handle_retraction(record: Mapping[str, Any]) -> str:
    """Ingest handler for ``retraction`` records; see :func:`_handle_notice`."""
    return _handle_notice(RETRACTION_TYPE, record)
