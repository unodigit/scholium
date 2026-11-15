"""Mirror an arXiv paper as a node-signed ``external.mirror`` record (plugin: imports).

:func:`import_arxiv` is the pipeline behind ``POST /v1/imports/arxiv``:

1. **Id.**  The client's value is parsed into an :class:`~.arxiv.ArxivId`
   (:class:`~.errors.InvalidArxivId`, 422).
2. **Node key.**  The node must hold an Ed25519 key at ``NODE_KEY_PATH``
   (:class:`~.errors.NodeKeyUnavailable`, 503): the record's author *is* the
   node, so there is nothing to fall back to.
3. **Already mirrored?**  A paper has one mirror per node
   (:class:`~.errors.AlreadyImported`, 409), checked before arXiv is asked
   anything.
4. **Metadata.**  :func:`app.modules.imports.arxiv.fetch_metadata` -- the mock
   with ``ARXIV_MOCK=1``, the arXiv API otherwise.
5. **Record.**  The envelope is built, its body checked against the record
   core's ``external.mirror`` schema, completed with its cid and signed by the
   node key (:func:`scholium_record_core.sign_record`).
6. **Snapshot.**  The metadata snapshot the record's ``manifest`` names is
   written to the content store, so the cid resolves.  This happens before the
   append: a record never points at a blob that is missing (a failed append
   leaves an unreferenced, content-addressed blob, which is harmless).
7. **Ledger.**  The record is appended to the event log
   (:func:`app.modules.ledger.append`), which notifies ledger subscribers.

What the record says
--------------------

``body`` is::

    {"source": "arXiv:2401.00001",
     "metadata": {"title": ..., "abstract": ..., "authors": [...],
                  "categories": [...], "arxivId": "2401.00001", ...},
     "manifest": "<file id of the canonical-JSON metadata snapshot>",
     "claimed": false}

``claimed: false`` is what makes the import *unclaimed*: it stays that way until
an author signs a ``paper.version`` that references this record's cid
(feature 125, :mod:`app.modules.imports.claims`), which is recorded in the
papers table rather than by re-writing the (immutable) mirror.  ``manifest`` commits to exactly the metadata the node
mirrored: it is the raw-codec file id (:func:`scholium_record_core.compute_file_id`)
of the metadata object as canonical JSON (sorted keys, no whitespace, UTF-8), so
anyone holding that metadata can recompute it.  The snapshot itself is stored in
the content store (``application/json``, scan status left to the sanitizer), so
the ``manifest`` cid has a ``blobs`` row and bytes behind it.  No PDF is fetched
or stored.

Why this does not go through ``POST /v1/records``
-------------------------------------------------

``external.mirror`` is signed by the *node*, never by a client, so the type is
deliberately not registered with the ingest registry: ``POST /v1/records``
keeps refusing it as an unknown type, and nobody can forge a mirror through
the public write path.  The record is built here, signed here and appended
straight to the ledger.

Concurrency
-----------

The "already mirrored" check and the append run under one lock, so two
simultaneous imports of the same paper in this process cannot both succeed.
The lock is per process: with several workers the check is best-effort.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
    validate_body,
)
from sqlalchemy import select

from app import db
from app.modules import content, ledger
from app.modules.ledger.models import EventLog
from app.settings import settings

from .arxiv import ArxivId, fetch_metadata, parse_arxiv_id
from .errors import AlreadyImported, ArxivUnavailable, NodeKeyUnavailable

__all__ = [
    "ANCHOR_PENDING",
    "MIRROR_TYPE",
    "STATE_UNCLAIMED",
    "ImportResult",
    "build_mirror",
    "find_mirror",
    "import_arxiv",
    "snapshot_bytes",
    "snapshot_id",
]

#: The record type this plugin creates.
MIRROR_TYPE = "external.mirror"

#: State reported for a mirror nobody has claimed.
STATE_UNCLAIMED = "unclaimed"

#: Public-timestamp status; this node does not anchor its log on-chain yet.
ANCHOR_PENDING = ledger.ANCHOR_PENDING

_import_lock = threading.Lock()


@dataclass(frozen=True)
class ImportResult:
    """What one import produced."""

    #: The mirror record's cid.
    record_id: str
    #: ``arXiv:<id>``.
    source: str
    #: The node's ``did:key`` -- the record's author and signer.
    author: str
    #: The metadata that was mirrored.
    metadata: dict[str, Any]
    #: Always ``False``: a fresh mirror has no claiming author yet.
    claimed: bool = False
    state: str = STATE_UNCLAIMED
    anchor: str = ANCHOR_PENDING


def _node_key() -> SigningKey:
    key = ledger.node_signing_key()
    if key is None:
        raise NodeKeyUnavailable(settings.NODE_KEY_PATH)
    return key


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot_bytes(metadata: dict[str, Any]) -> bytes:
    """``metadata`` as canonical JSON (sorted keys, no whitespace, UTF-8)."""
    return json.dumps(metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def snapshot_id(metadata: dict[str, Any]) -> str:
    """The file id of the metadata snapshot: the mirror's ``manifest``."""
    return compute_file_id(snapshot_bytes(metadata))


def build_mirror(
    ident: ArxivId,
    metadata: dict[str, Any],
    key: SigningKey,
    *,
    created: Optional[str] = None,
) -> dict[str, Any]:
    """Return the signed ``external.mirror`` record for ``ident``.

    Raises :class:`ArxivUnavailable` when the metadata does not fit the
    ``external.mirror`` schema (arXiv is the only variable part of the body).
    """
    body = {
        "source": ident.source,
        "metadata": metadata,
        "manifest": snapshot_id(metadata),
        "claimed": False,
    }
    errors = validate_body(MIRROR_TYPE, body)
    if errors:
        raise ArxivUnavailable(f"the metadata does not fit an external.mirror ({errors[0]}).")
    envelope = {
        "v": 1,
        "type": MIRROR_TYPE,
        "author": did_key_from_signing_key(key),
        "created": created or _now(),
        "prev": None,
        "body": body,
        "proofs": [],
    }
    return sign_record(envelope, key)


def find_mirror(source: str) -> Optional[str]:
    """Return the cid of this node's ``external.mirror`` for ``source``, if any."""
    ledger.ensure_table()
    with db.SessionLocal() as session:
        rows = session.execute(
            select(EventLog.record_cid, EventLog.body).where(EventLog.record_type == MIRROR_TYPE)
        ).all()
    for record_cid, body in rows:
        if isinstance(body, dict) and body.get("source") == source:
            return record_cid
    return None


def import_arxiv(arxiv_id: object) -> ImportResult:
    """Mirror the arXiv paper ``arxiv_id`` names; return the record that was appended.

    Raises :class:`InvalidArxivId` (422), :class:`ArxivNotFound` (404),
    :class:`AlreadyImported` (409), :class:`ArxivUnavailable` (502) or
    :class:`NodeKeyUnavailable` (503).  Nothing is appended unless every step
    before the ledger succeeded.
    """
    ident = parse_arxiv_id(arxiv_id)
    key = _node_key()

    existing = find_mirror(ident.source)
    if existing is not None:
        raise AlreadyImported(ident.source, existing)

    metadata = fetch_metadata(ident)
    record = build_mirror(ident, metadata, key)
    blob = content.store_bytes(snapshot_bytes(metadata), media_type="application/json")
    if blob.cid != record["body"]["manifest"]:  # same algorithm; a mismatch is a bug
        raise RuntimeError("the stored metadata snapshot does not match the record's manifest")

    with _import_lock:
        # Re-check under the lock: another request may have finished while
        # this one was waiting on arXiv.
        existing = find_mirror(ident.source)
        if existing is not None:
            raise AlreadyImported(ident.source, existing)
        ledger.append(record)

    return ImportResult(
        record_id=record["id"],
        source=ident.source,
        author=record["author"],
        metadata=metadata,
    )
