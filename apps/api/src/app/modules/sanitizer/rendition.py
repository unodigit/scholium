"""Node-signed ``rendition`` records (plugin: sanitizer).

Feature 64: once every file of a version has passed scanning, this node signs
a ``rendition`` record naming the sanitized files and the versions of the
tools that cleared them, and appends it to the event log::

    from app.modules import sanitizer

    result = sanitizer.scan_version(version_cid)
    result.rendition_cid                       # the record's cid

    entry = sanitizer.rendition_for(version_cid)
    entry.body["files"]                        # path, cid, size, scanStatus ...
    entry.body["tools"]                        # [{"name": "pypdf", "version": ...}]

The sanitizer inspects files and never rewrites them, so a file's sanitized
rendition has the same cid as the file the author listed: the record says
*these exact bytes passed scanning under these tools*.  Body (checked against
``schemas/rendition.json`` before anything is signed)::

    {"source": <version cid>, "paper": <paper cid>,
     "files": [{"path", "cid", "size", "mediaType", "role", "scanStatus"}],
     "tools": [{"name", "version"}]}

The record is authored and signed by the node's Ed25519 key (the same key
that signs the sync head), so only a node can speak for what *it* scanned.  A
node with no usable key raises :class:`RenditionKeyUnavailable`; the key file
is never created here.

:func:`create_rendition` is idempotent per node and version: a second call --
a retried job, a repeated scan -- returns the record already in the log
rather than appending a duplicate to an append-only ledger.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from scholium_record_core import (
    did_key_from_signing_key,
    sign_record,
    validate_body,
)
from sqlalchemy import or_, select

from app import db
from app.modules import ledger
from app.modules.ledger import EventLog

from .errors import InvalidRendition, RenditionKeyUnavailable

__all__ = [
    "RENDITION_TYPE",
    "RenditionResult",
    "build_rendition_body",
    "create_rendition",
    "rendition_for",
]

#: The record type this module writes.
RENDITION_TYPE = "rendition"

#: Body members that may name the version a rendition was made from (the
#: schema accepts any of them; this node writes ``source``).
_SOURCE_KEYS = ("source", "sourceVersion", "version")

# Finding an existing rendition and appending a new one is one step: without
# the lock two jobs for the same version could both find nothing and each
# append, and the log cannot take a duplicate back.
_create_lock = threading.Lock()


@dataclass(frozen=True)
class RenditionResult:
    """A version's rendition record and whether this call wrote it.

    ``record`` is the signed envelope (with ``id`` and ``sig``) when this call
    created it, and ``None`` when the node already had one: the ledger keeps
    the record's content but not its signature.
    """

    record_cid: str
    version_cid: str
    body: dict[str, Any]
    created: bool
    record: Optional[dict[str, Any]] = None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_rendition_body(
    version_cid: str,
    files: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]],
    *,
    paper_cid: Optional[str] = None,
) -> dict[str, Any]:
    """The ``rendition`` body for ``version_cid``, validated against its schema.

    Raises:
        InvalidRendition: ``version_cid`` is empty or the body does not fit
            the schema (no files, a file without a ``path`` or ``cid``, no
            tools ...); the message names the first problem.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise InvalidRendition("a rendition needs the cid of the version it was made from")
    body: dict[str, Any] = {
        "source": version_cid,
        "files": [dict(file) for file in files],
        "tools": [dict(tool) for tool in tools],
    }
    if paper_cid:
        body["paper"] = paper_cid
    errors = validate_body(RENDITION_TYPE, body)
    if errors:
        raise InvalidRendition(f"the rendition for {version_cid!r} is invalid: {errors[0]}")
    return body


def rendition_for(version_cid: str, *, author: Optional[str] = None) -> Optional[EventLog]:
    """The newest ``rendition`` entry in the log for ``version_cid``, if any.

    ``author`` restricts the search to renditions signed by that DID (this
    node's, for instance); by default a rendition from any node counts.
    """
    if not isinstance(version_cid, str) or not version_cid:
        return None
    ledger.ensure_table()
    statement = (
        select(EventLog)
        .where(EventLog.record_type == RENDITION_TYPE)
        .where(or_(*(EventLog.body[key].as_string() == version_cid for key in _SOURCE_KEYS)))
    )
    if author is not None:
        statement = statement.where(EventLog.author_did == author)
    statement = statement.order_by(EventLog.seq.desc()).limit(1)
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        entry = session.execute(statement).scalar_one_or_none()
        if entry is not None:
            session.expunge(entry)
        return entry


def create_rendition(
    version_cid: str,
    files: Sequence[Mapping[str, Any]],
    tools: Sequence[Mapping[str, Any]],
    *,
    paper_cid: Optional[str] = None,
) -> RenditionResult:
    """Sign and append the rendition of ``version_cid``, once per node.

    ``files`` are the version's sanitized files (``path`` and ``cid`` at
    least; ``size``, ``mediaType``, ``role`` and ``scanStatus`` are carried
    through) and ``tools`` the ``{"name", "version"}`` entries that cleared
    them.  When this node's key has already signed a rendition for the
    version, that one is returned (``created`` false) and nothing is written.

    Raises:
        RenditionKeyUnavailable: the node has no usable signing key.
        InvalidRendition: the body does not fit the ``rendition`` schema.
    """
    body = build_rendition_body(version_cid, files, tools, paper_cid=paper_cid)

    key = ledger.node_signing_key()
    if key is None:
        raise RenditionKeyUnavailable(
            "this node has no usable Ed25519 key (NODE_KEY_PATH), so it cannot sign a rendition"
        )
    author = did_key_from_signing_key(key)

    with _create_lock:
        existing = rendition_for(version_cid, author=author)
        if existing is not None:
            return RenditionResult(
                record_cid=existing.record_cid,
                version_cid=version_cid,
                body=dict(existing.body),
                created=False,
            )
        record = sign_record(
            {
                "v": 1,
                "type": RENDITION_TYPE,
                "author": author,
                "created": _now(),
                "prev": None,
                "body": body,
                "proofs": [],
            },
            key,
        )
        ledger.append(record)
    return RenditionResult(
        record_cid=record["id"],
        version_cid=version_cid,
        body=body,
        created=True,
        record=record,
    )
