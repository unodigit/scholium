"""``GET /v1/export/paper/{id}.car``: one paper as a CARv1 archive (feature 91).

A reader who wants the paper, and nothing else, downloads::

    GET /v1/export/paper/sch:xxxx-xxxx-xxxx.car

and receives a CARv1 archive (``application/vnd.ipld.car``) that can be read
with any IPLD tooling or with ``scholium verify`` (feature 95).  ``{id}``
accepts every spelling ``GET /v1/papers/{id}`` accepts -- a paper ``sch:``
id, a version id, or a version cid -- plus the paper's genesis cid and the
OAI identifier :mod:`app.modules.export.records` mints.  Exporting is public,
like reading a record.

What the archive holds
----------------------

Three kinds of block, one per content id:

* **records** -- the paper's signed records.  Each block is the canonical
  DAG-CBOR bytes the record id commits to (what the ledger keeps in
  ``event_log.raw``), filed under the record id.  ``sig`` is not part of those
  bytes, so it travels in the record's log-entry block instead (below): a
  reader joins the two and checks the author's signature over the canonical
  record.  This is the "canonical record" layout
  :mod:`scholium_cli.archive` reads.
* **files** -- the bytes of every file the paper's records name, filed under
  their raw-codec ``file id`` (:mod:`scholium_record_core.file_id`).  Only
  bytes the content store actually holds are written; a manifest that names
  a file this node no longer has simply leaves it out, and tombstoned bytes
  are never exported (moderation removed them).
* **log entries** -- one DAG-CBOR block per included record holding the
  ``event_log`` row (``seq``, ``record_cid``, ``record_type``, ``author_did``,
  ``body``, ``raw``, ``prev_hash``, ``entry_hash``, ``received_at``,
  ``origin_node``, and the author's ``sig``).  They are what
  ``scholium rebuild`` needs to recheck the hash chain; ``scholium verify``
  reads the ``sig`` from them and checks it over the canonical record.

Which records are "for the paper"
---------------------------------

The paper's genesis record is the root, and the archive carries every record
reachable from it through the signed records' own references:

* a record whose body names an included record -- a version naming its
  paper and manifest, a consent naming its version, a review naming its
  version, a notice or moderation decision naming the paper, a version or a
  file, a reply naming its parent post, and so on;
* a record named by an included record's body or ``prev`` link -- the
  manifests and earlier versions a verified chain needs.

The walk is a fixed point, so records are found however their references
are spelled (the schemas use record ids throughout).  Records of another
paper never name this paper's ids and are left out.

Only ``papers``/``event_log`` rows are read for the record walk; files come
from the content store.  An unknown paper, or one whose genesis record this
node does not hold, answers ``404`` RFC 9457 problem details -- the same
answer reading an unknown paper gives.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

import dag_cbor
from multiformats import CID
from scholium_record_core import (
    FILE_ID_PREFIX,
    GENESIS_TYPE,
    compute_record_cid,
    derive_short_id,
    parse_file_cid,
    parse_short_id,
    parse_version_id,
)

from app.modules import content, ledger
from app.modules.catalog.service import resolve
from app.modules.ledger.sync_range import serialise_entry

from .car import Block, block_cid, encode_car
from .records import local_identifier

__all__ = [
    "PaperArchive",
    "collect_paper",
    "collect_paper_records",
    "paper_cid_for",
]

#: Body fields that may name a file rather than a record.  A moderation
#: decision or flag "targets" a paper, a version or a file in it; including
#: those records keeps a takedown in the archive that explains it.
_FILE_TARGET_FIELDS = ("target", "cids", "content")


@dataclass(frozen=True)
class PaperArchive:
    """Everything one ``.car`` response carries, ready to encode."""

    paper_cid: str
    short_id: str
    """The paper's ``sch:`` id, used for the download filename."""
    log_entries: tuple[Block, ...]
    """One block per included record: the ``event_log`` row, DAG-CBOR encoded."""
    records: tuple[Block, ...]
    """Canonical record bytes, one block per record, filed under its record id."""
    files: tuple[Block, ...]
    """Raw file bytes, one block per file id."""
    roots: tuple[CID, ...]
    """The CAR entry point: the paper's genesis record block."""

    @property
    def blocks(self) -> tuple[Block, ...]:
        """Every block in archive order: the log, then records, then files."""
        return self.log_entries + self.records + self.files

    def to_car(self) -> bytes:
        """Encode this archive as CARv1 bytes."""
        return encode_car(self.roots, self.blocks)


# --------------------------------------------------------------------------- #
# Resolving the id
# --------------------------------------------------------------------------- #


def _trim(identifier: object) -> Optional[str]:
    """``identifier`` as text with this node's OAI prefix removed, or ``None``."""
    if not isinstance(identifier, str):
        return None
    text = local_identifier(identifier.strip())
    return text or None


def _from_log(text: str) -> Optional[tuple[str, str]]:
    """Resolve an id against the event log alone (no derived rows).

    Used when the catalog cannot resolve a paper because no derived
    ``papers``/``paper_versions`` row says it is listed: the signed genesis
    record in the log still names the paper.  Returns ``(paper_cid,
    short_id)`` or ``None``.
    """
    entry = ledger.entry_by_cid(text)
    if entry is not None:
        if entry.record_type == GENESIS_TYPE:
            return entry.record_cid, _short_id(entry.record_cid)
        if entry.record_type == "paper.version":
            body = entry.body if isinstance(entry.body, Mapping) else {}
            paper_cid = body.get("paper")
            if isinstance(paper_cid, str) and paper_cid:
                return paper_cid, _short_id(paper_cid)

    # A version id (``sch:xxxx-xxxx-xxxx/vN``) names its paper's short id.
    try:
        version_id = parse_version_id(text)
    except ValueError:
        version_id = None
    short_id = version_id.short_id if version_id is not None else text

    try:
        parse_short_id(short_id)
    except ValueError:
        return None

    for candidate in ledger.entries():
        if candidate.record_type != GENESIS_TYPE:
            continue
        if _short_id(candidate.record_cid) == short_id:
            return candidate.record_cid, short_id
    return None


def _short_id(paper_cid: str) -> str:
    """The ``sch:`` id of ``paper_cid`` when it is a record id, else ``""``."""
    try:
        return derive_short_id(paper_cid)
    except ValueError:
        return ""


def paper_cid_for(identifier: object) -> Optional[tuple[str, str]]:
    """Resolve ``identifier`` to ``(paper_cid, short_id)``, or ``None``.

    The catalog's own resolver answers first, so a paper the node serves
    through ``GET /v1/papers/{id}`` exports with exactly that meaning.  The
    event log is the fallback, because the signed genesis record is public
    even before an index row exists.
    """
    text = _trim(identifier)
    if text is None:
        return None

    try:
        view = resolve(text)
    except ValueError:  # a malformed id is simply not a paper
        view = None
    if view is not None:
        return view.paper.paper_cid, view.paper.short_id

    return _from_log(text)


def collect_paper_records(identifier: object) -> Optional[list[Any]]:
    '''The event-log entries for the paper identifier names, or None.'''
    resolved = paper_cid_for(identifier)
    if resolved is None:
        return None
    paper_cid, _short_id = resolved

    collected = _included_entries(paper_cid)
    if collected is None:
        return None
    included, _file_ids = collected

    ordered = sorted(included.values(), key=lambda entry: int(entry.seq))
    return [serialise_entry(entry) for entry in ordered]


# --------------------------------------------------------------------------- #
# Walking the records
# --------------------------------------------------------------------------- #


def _decoded(entry: ledger.EventLog) -> dict[str, Any]:
    """The record ``entry`` holds, decoded from its canonical bytes."""
    try:
        value = dag_cbor.decode(bytes(entry.raw))
    except (ValueError, TypeError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


def _strings(value: Any) -> set[str]:
    """Every string in a decoded body, at any depth (CID references included)."""
    found: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, str):
            found.add(node)
        elif isinstance(node, Mapping):
            for item in node.values():
                walk(item)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(value)
    return found


def _target_strings(body: Any) -> set[str]:
    """The strings in a body's file-target fields."""
    if not isinstance(body, Mapping):
        return set()
    found: set[str] = set()
    for field in _FILE_TARGET_FIELDS:
        if field in body:
            found |= _strings(body[field])
    return found


def _is_file_id(value: str) -> bool:
    """Whether ``value`` is a canonical file id, whether or not bytes exist.

    Membership is about the reference, not about this node's storage: a
    manifest naming a file whose bytes are gone still ties a moderation
    decision that targets that file to the paper.
    """
    if not value.startswith(FILE_ID_PREFIX):
        return False
    try:
        parse_file_cid(value)
    except ValueError:
        return False
    return True


def _stored_file(value: str) -> bool:
    """Whether ``value`` names bytes this node holds (a canonical file id)."""
    if not _is_file_id(value):
        return False
    try:
        return content.exists(value)
    except content.ContentError:
        # No CONTENT_DIR configured: records still export, files just cannot.
        return False


def _included_entries(
    paper_cid: str,
) -> Optional[tuple[dict[str, ledger.EventLog], set[str]]]:
    """The records for ``paper_cid`` and the file ids they name."""
    rows = ledger.entries()
    by_cid = {row.record_cid: row for row in rows}
    genesis = by_cid.get(paper_cid)
    if genesis is None:
        return None

    # Decode every record once: the walk only compares id sets.
    references: dict[str, set[str]] = {}
    targets: dict[str, set[str]] = {}
    for record_cid, entry in by_cid.items():
        decoded = _decoded(entry)
        body = decoded.get("body")
        found = _strings(body)
        prev = decoded.get("prev")
        if isinstance(prev, str):
            found.add(prev)
        references[record_cid] = found
        targets[record_cid] = _target_strings(body)

    included: dict[str, ledger.EventLog] = {paper_cid: genesis}
    file_ids: set[str] = set()

    # Fixed point: including a record can name a new record or file, and a
    # record naming anything included becomes part of the paper in turn.
    while True:
        changed = False
        included_ids = set(included)
        # Records the included ones name: a version names its manifest, a
        # reply names its parent, an appeal names the decision it contests.
        named = set(included_ids)
        for entry in included.values():
            named |= references[entry.record_cid]

        for entry in list(included.values()):
            for reference in references[entry.record_cid]:
                if reference not in file_ids and _is_file_id(reference):
                    file_ids.add(reference)
                    changed = True

        for record_cid, entry in by_cid.items():
            if record_cid in included:
                continue
            if (
                record_cid in named
                or references[record_cid] & included_ids
                or targets[record_cid] & file_ids
            ):
                included[record_cid] = entry
                changed = True

        if not changed:
            break

    return included, file_ids


# --------------------------------------------------------------------------- #
# Building the blocks
# --------------------------------------------------------------------------- #


def _record_block(entry: ledger.EventLog) -> Optional[Block]:
    """The canonical record block of ``entry``, or ``None`` when unreadable."""
    try:
        cid = CID.decode(entry.record_cid)
    except (ValueError, TypeError, KeyError):
        # A non-canonical spelling still names bytes: file the block under
        # the hash of those bytes rather than dropping the record.
        content_map = _decoded(entry)
        try:
            cid = compute_record_cid(content_map)
        except (ValueError, KeyError, TypeError):
            return None
    return Block(cid=cid, data=bytes(entry.raw))


def _received_at(moment: datetime) -> str:
    """An ``event_log`` timestamp as the archive's ISO 8601 ``Z`` string."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log_entry_block(entry: ledger.EventLog) -> Block:
    """One ``event_log`` row as a DAG-CBOR block (what ``scholium rebuild`` reads).

    ``sig`` rides along when the row kept one.  The chain does not hash it, but
    a canonical record block carries no signature of its own, so this is how an
    offline verifier learns the signature the author gave the record.
    """
    payload = {
        "seq": int(entry.seq),
        "record_cid": entry.record_cid,
        "record_type": entry.record_type,
        "author_did": entry.author_did,
        "body": entry.body,
        "raw": bytes(entry.raw),
        "prev_hash": bytes(entry.prev_hash),
        "entry_hash": bytes(entry.entry_hash),
        "received_at": _received_at(entry.received_at),
        "origin_node": entry.origin_node,
    }
    sig = entry.get("sig")
    if isinstance(sig, str) and sig:
        payload["sig"] = sig
    data = dag_cbor.encode(payload)
    return Block(cid=block_cid(data), data=data)


def _file_block(file_cid: str) -> Optional[Block]:
    """The raw block of one stored file, or ``None`` when not exportable."""
    if content.is_tombstoned(file_cid):
        return None  # moderation removed the bytes from the public archive
    try:
        cid = parse_file_cid(file_cid)
        with content.open_blob(file_cid) as stream:
            data = stream.read()
    except (ValueError, OSError, content.ContentError):
        return None
    return Block(cid=cid, data=data)


# --------------------------------------------------------------------------- #
# The whole archive
# --------------------------------------------------------------------------- #


def collect_paper(identifier: object) -> Optional[PaperArchive]:
    """Build the archive of the paper ``identifier`` names, or ``None``.

    ``None`` means the id does not name a paper this node can export: it is
    malformed, unknown, or its genesis record is not in the event log.
    """
    resolved = paper_cid_for(identifier)
    if resolved is None:
        return None
    paper_cid, short_id = resolved

    collected = _included_entries(paper_cid)
    if collected is None:
        return None
    included, file_ids = collected

    ordered = sorted(included.values(), key=lambda entry: int(entry.seq))
    records: list[Block] = []
    log_entries: list[Block] = []
    for entry in ordered:
        record = _record_block(entry)
        if record is not None:
            records.append(record)
        log_entries.append(_log_entry_block(entry))

    files = [
        block
        for block in (
            _file_block(file_cid)
            for file_cid in sorted(file_ids)
            if _stored_file(file_cid)
        )
        if block is not None
    ]

    genesis = _record_block(included[paper_cid])
    root = genesis.cid if genesis is not None else None
    return PaperArchive(
        paper_cid=paper_cid,
        short_id=short_id or _short_id(paper_cid),
        log_entries=tuple(log_entries),
        records=tuple(records),
        files=tuple(files),
        roots=(root,) if root is not None else (),
    )
