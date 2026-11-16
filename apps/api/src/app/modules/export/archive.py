"""``GET /v1/export/archive.car``: the node's complete public archive (feature 93).

A third party that wants the whole node -- to keep it, to audit it, or to
rebuild the node's views from it (``scholium rebuild``, feature 98) --
downloads one CARv1 archive (``application/vnd.ipld.car``) instead of walking
the log and the content store.  Exporting is public, like reading the log.

What the archive holds
----------------------

* **the signed log head** -- the document ``GET /v1/sync/head`` serves
  (``seq``, ``entry_hash``, ``node_did``, ``signature``), as one DAG-CBOR
  block and the archive's only CAR root.  The node signed it over the last
  entry the archive carries, so a reader checks the head's signature against
  ``node_did`` with the same :func:`~app.modules.ledger.head_message` rule it
  uses for the HTTP endpoint, and the head commits the node to this history:
  a node that later serves a different history for the same ``seq`` has
  equivocated (docs/tech_architect.md, "Transparency log").
* **log entries** -- one block per ``event_log`` row, ``seq`` 1 through the
  head's ``seq`` with no gaps, in the layout of :mod:`app.modules.export.paper`.
  They are what ``scholium rebuild`` rechecks the hash chain over.
* **records** -- the canonical record bytes of every entry, filed under the
  record id.  As in the per-paper archive, a record's ``sig`` is not part of
  those bytes; it rides in the record's log-entry block, so a reader can check
  the author's signature over the canonical record.
* **files** -- the bytes of every file any record names, filed under its
  raw-codec file id.  A file is left out, and nothing else changes, when

  - the caller may not read it under the rule ``GET /v1/content/{cid}``
    applies (:func:`app.modules.content.may_read`): the paper is unlisted and
    the caller is neither one of its versions' authors nor a moderator.  An
    anonymous download therefore carries no pre-listing bytes, and an author
    or moderator download may;
  - moderation **tombstoned** it (:mod:`app.modules.moderation.tombstones`):
    the records that name it, and the decision that took it down, stay -- the
    log and every signature never covered the bytes;
  - the sanitizer **rejected** it (``scan_status: failed``): the content
    route's rule is that such bytes must never be served, and an export is
    serving them;
  - this node does not hold the bytes.

  Only bytes a signed record names are exported, so an upload no record
  refers to yet (it is not public) is not part of the archive.

One consistent snapshot
-----------------------

The head is read and signed first, and entries are read only up to its
``seq``.  The log is append-only, so records accepted while the archive is
being written are simply not in it, and the head always matches the last log
entry in the archive.  An empty log exports the genesis head (``seq`` 0) and
nothing else.

The archive is written to a temporary file page by page rather than built in
memory (a node's archive holds every file it has); see
:mod:`app.modules.export.archive_car`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import BinaryIO, Iterator, Optional

import dag_cbor
from multiformats import CID

from app.modules import content, ledger
from app.security import Principal

from .car import Block, block_cid, write_car
from .paper import (
    _decoded,
    _file_block,
    _is_file_id,
    _log_entry_block,
    _record_block,
    _stored_file,
    _strings,
)

__all__ = [
    "PAGE_SIZE",
    "FullArchive",
    "collect_archive",
]

#: Log entries read from the database per query while writing the archive.
PAGE_SIZE = 500


@dataclass(frozen=True)
class FullArchive:
    """The signed head a ``.car`` response is pinned to, and how to write it."""

    head: ledger.SyncHead
    """The node-signed head of the log; the archive ends at ``head.seq``."""
    head_block: Block
    """``head`` as a DAG-CBOR block (the same fields ``/v1/sync/head`` serves)."""
    principal: Optional[Principal] = None
    """The caller, or ``None`` when anonymous; widens which files are exportable."""

    @property
    def roots(self) -> tuple[CID, ...]:
        """The CAR entry point: the signed head."""
        return (self.head_block.cid,)

    def blocks(self) -> Iterator[Block]:
        """Every block in archive order, produced one at a time.

        The head, then each log entry with its record in ``seq`` order, then
        the files in file-id order.  One block per content id: a record, a log
        entry and a file never share bytes, and each id is written once.
        """
        yield self.head_block

        file_ids: set[str] = set()
        for entry in _entries_through(int(self.head.seq)):
            yield _log_entry_block(entry)
            record = _record_block(entry)
            if record is not None:
                yield record
            file_ids |= _named_files(entry)

        for file_cid in sorted(file_ids):
            block = _public_file_block(file_cid, self.principal)
            if block is not None:
                yield block

    def write_to(self, out: BinaryIO) -> int:
        """Write the CARv1 archive to ``out``; return its size in bytes."""
        return write_car(out, self.roots, self.blocks())


def collect_archive(key, principal: Optional[Principal] = None) -> FullArchive:
    """Sign the log's current head with ``key`` and pin an archive to it.

    ``key`` is the node's :class:`nacl.signing.SigningKey`
    (:func:`app.modules.ledger.node_signing_key`).  Nothing but the head is
    read here; the entries and files are read as the archive is written.
    ``principal`` is the caller (``None`` when anonymous) and only widens
    which file blocks are exportable, under the content route's rule.
    """
    head = ledger.signed_head(key, ledger.latest())
    data = dag_cbor.encode(head.model_dump())
    return FullArchive(
        head=head,
        head_block=Block(cid=block_cid(data), data=data),
        principal=principal,
    )


# --------------------------------------------------------------------------- #
# Log entries and records
# --------------------------------------------------------------------------- #


def _entries_through(seq: int) -> Iterator[ledger.EventLog]:
    """Log entries ``1..seq`` in order, read ``PAGE_SIZE`` at a time."""
    cursor = 0
    while cursor < seq:
        page = ledger.entries(after=cursor, through=seq, limit=PAGE_SIZE)
        if not page:
            return
        yield from page
        cursor = int(page[-1].seq)


# --------------------------------------------------------------------------- #
# Files
# --------------------------------------------------------------------------- #


def _named_files(entry: ledger.EventLog) -> set[str]:
    """The file ids a record names anywhere in its body."""
    return {
        text
        for text in _strings(_decoded(entry).get("body"))
        if _is_file_id(text)
    }


def _scan_failed(file_cid: str) -> bool:
    """Whether the sanitizer rejected ``file_cid`` (its bytes are never served)."""
    blob = content.get_blob(file_cid)
    return blob is not None and blob.scan_status == content.SCAN_FAILED


def _public_file_block(
    file_cid: str, principal: Optional[Principal] = None
) -> Optional[Block]:
    """The block of ``file_cid`` when its bytes may be exported, else ``None``."""
    if not _stored_file(file_cid) or _scan_failed(file_cid):
        return None
    block = _file_block(file_cid, principal)  # also skips tombstoned/unreadable cids
    # Tombstoning saves the denylist row *before* it deletes the bytes.  So a
    # takedown that began after the check above but before the read finished
    # has its row by now, and asking again drops the bytes; one that begins
    # later leaves an archive that is simply a snapshot from before it.
    if block is None or content.is_tombstoned(file_cid):
        return None
    return block
