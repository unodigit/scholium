"""``GET /v1/export/user/{did}.car``: every record authored by a DID (feature 92).

A reader who wants everything one author has signed downloads::

    GET /v1/export/user/did:key:z6Mk....car

and receives a CARv1 archive (``application/vnd.ipld.car``) of every record in
this node's event log whose ``author_did`` is that DID, together with the
``event_log`` row of each (the hash-chain links) and the bytes of every file
those records name.  Exporting is public, like reading a record.

As on every export path, a file block is written only when the caller may read
the file under the rule ``GET /v1/content/{cid}`` applies
(:func:`app.modules.content.may_read`): the bytes of a paper still awaiting
consent, in moderation or held are exported only to its versions' authors and
to moderators.  The records and log entries are exported either way.

The blocks are written by :mod:`app.modules.export.car`; the canonical record
bytes and log-entry layout are the same as :mod:`app.modules.export.paper`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from multiformats import CID

from app.modules import ledger
from app.security import Principal

from .car import Block, encode_car
import dag_cbor
from .paper import _strings, _target_strings
from .paper import (
    _file_block,
    _is_file_id,
    _log_entry_block,
    _record_block,
    _stored_file,
)

__all__ = [
    "UserArchive",
    "USER_NOT_FOUND_TYPE",
    "collect_user",
    "collect_user_records",
    "collect_user_car",
]


#: Problem-details type URN for a DID that authored no record on this node.
USER_NOT_FOUND_TYPE = "urn:scholium:problem:user-not-found"


@dataclass(frozen=True)
class UserArchive:
    """Everything one ``.car`` response for a user carries, ready to encode."""

    did: str
    log_entries: tuple[Block, ...]
    """One block per included record: the ``event_log`` row, DAG-CBOR encoded."""
    records: tuple[Block, ...]
    """Canonical record bytes, one block per record, filed under its record id."""
    files: tuple[Block, ...]
    """Raw file bytes, one block per file id."""
    roots: tuple[CID, ...]
    """The CAR entry point: the genesis records this DID authored (or the first)."""

    @property
    def user_did(self) -> str:
        """Alias for :attr:`did`."""
        return self.did

    @property
    def blocks(self) -> tuple[Block, ...]:
        """Every block in archive order: the log, then records, then files."""
        return self.log_entries + self.records + self.files

    def to_car(self) -> bytes:
        """Encode this archive as CARv1 bytes."""
        return encode_car(self.roots, self.blocks)


def collect_user(did: object, principal: Optional[Principal] = None) -> Optional[UserArchive]:
    """Build the archive of every record authored by ``did``, or ``None``.

    ``None`` means the DID authored no record this node holds.  ``principal``
    is the caller (``None`` when anonymous); a file block is written only when
    that caller may read the file under the content route's rule, so an
    unlisted paper's bytes are exported only to its authors and to moderators.
    """
    if not isinstance(did, str) or not did:
        return None

    entries = [entry for entry in ledger.entries() if entry.author_did == did]
    if not entries:
        return None

    ordered = sorted(entries, key=lambda entry: int(entry.seq))

    records: list[Block] = []
    log_entries: list[Block] = []
    file_ids: set[str] = set()

    for entry in ordered:
        record = _record_block(entry)
        if record is not None:
            records.append(record)
        log_entries.append(_log_entry_block(entry))

        # File ids named by this record (including file-target fields).
        try:
            decoded = dag_cbor.decode(bytes(entry.raw))
        except Exception:  # pragma: no cover - defensive
            decoded = {}
        if not isinstance(decoded, dict):
            decoded = {}
        body = decoded.get("body")
        for reference in _strings(body):
            if _is_file_id(reference):
                file_ids.add(reference)
        for reference in _target_strings(body):
            if _is_file_id(reference):
                file_ids.add(reference)

    files = [
        block
        for block in (
            _file_block(file_cid, principal)
            for file_cid in sorted(file_ids)
            if _stored_file(file_cid)
        )
        if block is not None
    ]

    # Roots: genesis records authored by this DID, else the first authored record.
    genesis_roots: list[CID] = []
    for entry in ordered:
        if entry.record_type == "paper.genesis":
            try:
                genesis_roots.append(CID.decode(entry.record_cid))
            except (ValueError, TypeError, KeyError):
                pass
    if genesis_roots:
        roots = tuple(genesis_roots)
    else:
        try:
            roots = (CID.decode(ordered[0].record_cid),)
        except (ValueError, TypeError, KeyError):
            roots = ()

    return UserArchive(
        did=did,
        log_entries=tuple(log_entries),
        records=tuple(records),
        files=tuple(files),
        roots=roots,
    )


# Aliases for callers that spell the collector differently.
collect_user_records = collect_user
collect_user_car = collect_user
