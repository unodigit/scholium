"""Which uploaded file bytes the record log names, and on whose say-so (plugin: uploads).

An upload's bytes are only *paper* once its owner's signed records name their
CID. Until then they are an anonymous file in the content store: they may be
abandoned. This module answers the two questions the orphan reaper needs by
reading the append-only record log.

Whose records count matters. Anyone, a tier-0 stranger included, can post a
standalone ``manifest`` record naming any CID, so "some manifest names it" says
nothing about the upload's owner. An upload is therefore *referenced* only when
a record **its owner signed** names it:

* a manifest of a ``paper.version`` the owner signed, or is listed on as an
  author (the version names the manifest record by CID in ``manifest``; an
  older-style version may inline the manifest instead);
* a ``discussion.post`` (``textCid``), a notice -- ``correction``,
  ``retraction`` or ``withdrawal`` -- or a ``moderation.decision``
  (``reasonCid``) the owner signed.

A manifest nobody's version names, and a record somebody else signed, make no
upload referenced. The bytes are another matter: a file that *any* record names
(any type, any signer) is never deleted, because deleting it would leave that
record pointing at nothing. So :class:`References` carries both answers:
:meth:`References.keeps_upload` for the upload row and
:meth:`References.names_file` for the bytes.

The scan is deliberately tolerant of bodies written by older releases. A body
that does not look like what it should contributes nothing rather than failing
the whole scan.

Reading is all this module does. The log is append-only, and bytes are never
deleted on the strength of this answer alone: the caller re-checks the count
of uploads still naming a CID before removing anything from the content store.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import db

logger = logging.getLogger(__name__)

MANIFEST_TYPE = "manifest"
VERSION_TYPE = "paper.version"

#: Records whose own field names a stored file: ``record type -> body fields``.
#: Only the record's signer's upload is referenced by it.
FILE_FIELDS = {
    "discussion.post": ("textCid",),
    "correction": ("reasonCid",),
    "retraction": ("reasonCid",),
    "withdrawal": ("reasonCid",),
    "moderation.decision": ("reasonCid",),
}

#: Record types that mention a CID without keeping the file: an erasure request
#: asks for the bytes to go, so it must not hold them back.
NOT_A_REFERENCE = frozenset({"erasure.request"})

#: Rows read from the log per query. Each batch is fetched whole before the next
#: is requested, so no read lock is held while the rows are examined and the
#: log's writers (which append on every accepted record) are never kept waiting.
_BATCH = 500


def _files_of(body: Any) -> Sequence[Any]:
    """The file entries a manifest-ish body lists, or an empty sequence."""
    if isinstance(body, Mapping):
        manifest = body.get("manifest")
        if isinstance(manifest, Mapping):
            body = manifest
        elif isinstance(manifest, Sequence) and not isinstance(manifest, (str, bytes, bytearray)):
            return manifest
        files = body.get("files")
    else:
        files = body
    if isinstance(files, (str, bytes, bytearray)) or not isinstance(files, Sequence):
        return ()
    return files


def cids_in(body: Any) -> set[str]:
    """Every file CID a manifest body (or an inline-manifest version body) names."""
    cids: set[str] = set()
    for entry in _files_of(body):
        if not isinstance(entry, Mapping):
            continue
        cid = entry.get("cid")
        if isinstance(cid, str) and cid:
            cids.add(cid)
    return cids


def _log_rows(session: Session) -> Iterator[tuple[str, str, str, Any]]:
    """``(record type, record cid, author did, body)`` of every record, oldest first."""
    from app.modules.ledger.models import EventLog  # lazily: see :func:`scan`

    last = 0
    while True:
        batch = session.execute(
            select(EventLog.seq, EventLog.record_type, EventLog.record_cid, EventLog.author_did, EventLog.body)
            .where(EventLog.seq > last)
            .order_by(EventLog.seq)
            .limit(_BATCH)
        ).all()
        if not batch:
            return
        last = batch[-1][0]
        for _, record_type, record_cid, author_did, body in batch:
            yield record_type, record_cid, author_did, body


def _strings_in(body: Any, wanted: Collection[str]) -> set[str]:
    """Every string anywhere in ``body`` that is one of ``wanted``."""
    found: set[str] = set()
    pending = [body]
    while pending:
        node = pending.pop()
        if isinstance(node, str):
            if node in wanted:
                found.add(node)
        elif isinstance(node, Mapping):
            pending.extend(node.values())
        elif isinstance(node, Sequence) and not isinstance(node, (bytes, bytearray)):
            pending.extend(node)
    return found


def _listed_authors(body: Any) -> set[str]:
    """The DIDs a version body lists in ``authors`` (bare DIDs and author objects)."""
    authors = body.get("authors") if isinstance(body, Mapping) else None
    if isinstance(authors, (str, bytes, bytearray)) or not isinstance(authors, Sequence):
        return set()
    listed: set[str] = set()
    for entry in authors:
        did = entry.get("did") if isinstance(entry, Mapping) else entry
        if isinstance(did, str) and did:
            listed.add(did)
    return listed


@dataclass(frozen=True)
class References:
    """What the record log says about a set of candidate file CIDs."""

    #: ``owner DID -> candidate CIDs that DID's own records name``.
    owned: Mapping[str, frozenset[str]]
    #: Candidate CIDs that some record names, whoever signed it.
    named: frozenset[str]

    def names_file(self, cid: str) -> bool:
        """Whether any record names ``cid``: its bytes must not be deleted."""
        return cid in self.named

    def keeps_upload(self, owner_did: Optional[str], cid: str) -> bool:
        """Whether an upload of ``cid`` by ``owner_did`` counts as referenced.

        True when ``owner_did``'s own records name it. A legacy upload with no
        recorded owner has no one whose records could, so it is kept while any
        record names it (such rows predate required authentication and cannot
        be created any more).
        """
        if owner_did is None:
            return cid in self.named
        return cid in self.owned.get(owner_did, frozenset())


def scan(candidates: Collection[str]) -> Optional[References]:
    """What the record log says about ``candidates``, or ``None`` when it cannot be read.

    Callers must then choose; the orphan reaper deletes nothing (it never
    removes bytes it cannot prove are unreferenced).
    """
    wanted = frozenset(candidates)
    if not wanted:
        return References(owned={}, named=frozenset())
    try:
        # The ledger package is imported lazily (see :func:`_log_rows`): it
        # imports the ingest registry, and this plugin is imported by the
        # module loader alongside it.
        named: set[str] = set()
        manifest_files: dict[str, set[str]] = {}
        versions: list[tuple[set[str], Any, set[str]]] = []
        owned: defaultdict[str, set[str]] = defaultdict(set)

        with db.SessionLocal() as session:
            for record_type, record_cid, author_did, body in _log_rows(session):
                if record_type in NOT_A_REFERENCE:
                    continue
                named |= _strings_in(body, wanted)
                if record_type == MANIFEST_TYPE:
                    files = cids_in(body) & wanted
                    if files:
                        manifest_files[record_cid] = files
                elif record_type == VERSION_TYPE:
                    reference = body.get("manifest") if isinstance(body, Mapping) else None
                    versions.append(
                        (
                            {author_did} | _listed_authors(body),
                            reference if isinstance(reference, str) else None,
                            cids_in(body) & wanted,
                        )
                    )
                elif record_type in FILE_FIELDS and isinstance(body, Mapping):
                    for field in FILE_FIELDS[record_type]:
                        cid = body.get(field)
                        if isinstance(cid, str) and cid in wanted:
                            owned[author_did].add(cid)

        # A version's manifest is read only through the version, so a manifest
        # record nobody's version names -- a stranger's, say -- adds nothing.
        for authors, reference, inline in versions:
            files = inline | manifest_files.get(reference, set()) if reference else inline
            if files:
                for author in authors:
                    owned[author] |= files
        return References(owned={did: frozenset(cids) for did, cids in owned.items()}, named=frozenset(named))
    except SQLAlchemyError:
        logger.warning("could not read the record log while checking upload references", exc_info=True)
        return None
