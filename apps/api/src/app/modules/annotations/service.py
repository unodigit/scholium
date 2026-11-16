"""Annotation handling and reading (plugin: annotations).

Feature 103: ``POST /v1/annotations`` accepts a signed ``discussion.post``
record whose anchor names a version cid, a ``paragraph_id``, a ``quote`` and
an ``offset``.  The record flows through the standard ingest pipeline; this
module owns the ``discussion.post`` type handler so that type is known to
the registry on a node that has the annotations plugin installed.

Feature 104: :func:`resolve_version` and :func:`annotations_for_version`
back ``GET /v1/papers/{id}/v/{n}/annotations``.  The paper's ``{id}`` is a
``sch:xxxx-xxxx-xxxx`` short id, which is a one-way digest of the
``paper.genesis`` cid, so it is resolved by scanning the event log for the
genesis record whose short id matches.  Version ``n`` is then the
``paper.version`` record that names that genesis in ``body.paper`` and has
``body.n == n``.  Annotations are ``discussion.post`` records whose anchor
names that version cid and a paragraph id, grouped by paragraph id so a
reader can re-attach each one to its paragraph after a reload.

The ledger is imported at call time, not module load: the annotations plugin
is discovered before its siblings, and whichever package the loader reaches
first must not depend on the other being importable during app assembly.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from scholium_record_core import derive_short_id, parse_short_id

__all__ = [
    "PAPER_GENESIS_TYPE",
    "PAPER_VERSION_TYPE",
    "DISCUSSION_POST_TYPE",
    "VersionRef",
    "annotations_for_version",
    "handle_annotation",
    "resolve_latest_version",
    "resolve_version",
]

#: The record type that carries a paper's genesis cid.
PAPER_GENESIS_TYPE = "paper.genesis"

#: The record type that publishes one numbered version of a paper.
PAPER_VERSION_TYPE = "paper.version"

#: The record type used for annotations (a ``discussion.post`` with a paragraph anchor).
DISCUSSION_POST_TYPE = "discussion.post"


@dataclass(frozen=True)
class VersionRef:
    """A paper version addressed by the public API's ``{id}`` and ``{n}``."""

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: cid of the paper's ``paper.genesis`` record.
    genesis_cid: str
    #: cid of the ``paper.version`` record for version ``n``.
    version_cid: str
    #: The version number ``n``.
    n: int


def handle_annotation(record: dict[str, Any]) -> None:
    """Accept an inline annotation record.

    Validation of the envelope, body schema, cid and signature happens in the
    ingest pipeline before this handler runs; nothing extra is required here
    for the record to be appended to the event log.
    """
    return None


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #


def _body(entry: Any) -> Mapping[str, Any]:
    """The stored record body as a mapping (``{}`` when it is not one)."""
    body = getattr(entry, "body", None)
    return body if isinstance(body, Mapping) else {}


def _genesis_cid(rows: list[Any], paper: str) -> Optional[str]:
    """The cid of the ``paper.genesis`` record whose short id is ``paper``."""
    for row in rows:
        if row.record_type != PAPER_GENESIS_TYPE:
            continue
        try:
            if derive_short_id(row.record_cid) == paper:
                return row.record_cid
        except ValueError:
            # A stored cid that is not a record id cannot be a paper genesis.
            continue
    return None


def _version_cid(rows: list[Any], genesis_cid: str, n: int) -> Optional[str]:
    """The cid of the ``paper.version`` for ``(genesis_cid, n)``, if any."""
    for row in rows:
        if row.record_type != PAPER_VERSION_TYPE:
            continue
        body = _body(row)
        if body.get("paper") != genesis_cid:
            continue
        version = body.get("n")
        if isinstance(version, bool) or not isinstance(version, int):
            continue
        if version == n:
            return row.record_cid
    return None


def _latest_version(rows: list[Any], genesis_cid: str) -> Optional[tuple[int, str]]:
    """``(n, cid)`` of the highest-numbered ``paper.version`` of ``genesis_cid``, if any."""
    latest: Optional[tuple[int, str]] = None
    for row in rows:
        if row.record_type != PAPER_VERSION_TYPE:
            continue
        body = _body(row)
        if body.get("paper") != genesis_cid:
            continue
        version = body.get("n")
        if isinstance(version, bool) or not isinstance(version, int):
            continue
        if latest is None or version > latest[0]:
            latest = (version, row.record_cid)
    return latest


def _paper_rows() -> list[Any]:
    """Every ``paper.genesis`` and ``paper.version`` log row, in ledger order."""
    from sqlalchemy import select

    from app import db
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        return list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type.in_((PAPER_GENESIS_TYPE, PAPER_VERSION_TYPE)))
                .order_by(EventLog.seq)
            ).scalars()
        )


def resolve_latest_version(paper: str) -> Optional[VersionRef]:
    """Resolve a paper short id to its highest-numbered version.

    Backs the read a client makes without naming a version.  Returns ``None``
    when the log holds no such paper or the paper has no version; raises
    ``ValueError`` for a malformed short id, like :func:`resolve_version`.
    """
    canonical = parse_short_id(paper)  # ValueError for a malformed/mistyped id

    rows = _paper_rows()
    genesis_cid = _genesis_cid(rows, canonical)
    if genesis_cid is None:
        return None
    latest = _latest_version(rows, genesis_cid)
    if latest is None:
        return None

    n, version_cid = latest
    return VersionRef(paper=canonical, genesis_cid=genesis_cid, version_cid=version_cid, n=n)


def resolve_version(paper: str, n: int) -> Optional[VersionRef]:
    """Resolve ``(paper short id, version number)`` to the records that name it.

    Returns ``None`` when ``paper`` is not a valid short id or when the log
    holds no matching genesis/version record.  Raises ``ValueError`` only for
    a malformed version number (an ``int`` is required by the route).
    """
    canonical = parse_short_id(paper)  # ValueError for a malformed/mistyped id

    rows = _paper_rows()
    genesis_cid = _genesis_cid(rows, canonical)
    if genesis_cid is None:
        return None
    version_cid = _version_cid(rows, genesis_cid, n)
    if version_cid is None:
        return None

    return VersionRef(paper=canonical, genesis_cid=genesis_cid, version_cid=version_cid, n=n)


def _anchor_version(anchor: Mapping[str, Any]) -> Optional[str]:
    """The version cid an anchor names, under either schema spelling."""
    for key in ("version", "versionCid"):
        value = anchor.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _paragraph_id(anchor: Mapping[str, Any]) -> Optional[str]:
    """The paragraph id an anchor names, under either schema spelling."""
    for key in ("paragraph_id", "paragraphId"):
        value = anchor.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _annotation_entry(entry: Any, anchor: Mapping[str, Any], paragraph_id: str) -> dict[str, Any]:
    """One annotation in the wire shape served inside a paragraph's group."""
    body = _body(entry)
    return {
        "id": entry.record_cid,
        "author": entry.author_did,
        "created": _created(entry),
        "type": entry.record_type,
        "target": body.get("target"),
        "paragraph_id": paragraph_id,
        "paragraphId": paragraph_id,
        "quote": anchor.get("quote"),
        "offset": anchor.get("offset"),
        "text": body.get("text"),
        "textCid": body.get("textCid"),
        "parent": body.get("parent"),
    }


def _created(entry: Any) -> Optional[str]:
    """The signer's ``created`` timestamp, decoded from the stored envelope.

    ``event_log`` keeps the canonical bytes rather than a ``created`` column,
    so the envelope is rebuilt from them.  A row whose bytes cannot be decoded
    (which the append-only log should never contain) contributes ``None``;
    reading the annotations still works.
    """
    from app.modules.ledger.records import stored_envelope

    try:
        return stored_envelope(entry).created
    except Exception:  # pragma: no cover - corrupt bytes are not a normal path
        return None


def annotations_for_version(version_cid: str) -> dict[str, list[dict[str, Any]]]:
    """Return the version's annotations grouped by ``paragraph_id``.

    Only ``discussion.post`` records whose anchor names ``version_cid`` and a
    non-empty paragraph id are included; a plain thread post (a cid anchor) is
    not an annotation.  Groups are inserted in ledger order, so each
    paragraph's annotations come back in the order they were posted.
    """
    from sqlalchemy import select

    from app import db
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type == DISCUSSION_POST_TYPE)
                .order_by(EventLog.seq)
            ).scalars()
        )

    groups: dict[str, list[dict[str, Any]]] = {}
    for entry in rows:
        body = _body(entry)
        anchor = body.get("anchor")
        if not isinstance(anchor, Mapping):
            continue

        anchor_version = _anchor_version(anchor)
        if anchor_version is None:
            # Be lenient about an anchor that omits the version: if the post
            # targets the version and carries a paragraph anchor, it is still
            # an annotation on that version.
            if body.get("target") != version_cid:
                continue
        elif anchor_version != version_cid:
            continue

        paragraph_id = _paragraph_id(anchor)
        if paragraph_id is None:
            continue

        groups.setdefault(paragraph_id, []).append(
            _annotation_entry(entry, anchor, paragraph_id)
        )

    return groups
