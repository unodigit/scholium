"""``scholium rebuild <archive.car> --db <path>``: rebuild the views from an archive.

The other half of Gate 1 (docs/tech_architect.md §1.7): a third party that
holds a node's exported ``archive.car`` can rebuild the node's derived views
-- the paper, version and status tables materialised from the log -- without
trusting the node at all.  Nothing here touches the network or the node's
code; every input is either read from the archive or recomputed from it.

What the command does, in order:

1. **Every block is hash-checked** against its CID (the same check
   :mod:`scholium_cli.verify` makes): a block whose bytes do not hash to the
   CID it is filed under is never used as evidence.
2. **The log chain is verified.**  The archive carries one block per
   appended record holding the ``event_log`` row (``seq``, ``record_cid``,
   ``raw``, ``prev_hash``, ``entry_hash``, ...); the chain rule is::

       entry_hash = sha256(prev_hash || utf8(record_cid) || raw)
       prev_hash  = the entry_hash of the entry before (genesis: 32 zero bytes)

   A rebuild replays a whole log, so the entries must start at seq 1 and run
   consecutively -- a removed, reordered or rewritten entry breaks the chain
   at the first seq that no longer reproduces.
3. **Every record is authenticated**: its ``id`` equals the hash of its own
   content and its signature verifies against its author's did:key.  Each
   record must also be named by a log entry, and that entry's ``raw`` must
   be exactly the record's canonical bytes -- so the chain commits to the
   very records in the archive, and the archive to the chain.
4. **Every paper is verified** with
   :func:`scholium_record_core.verify_paper`: history, consents, manifests,
   supersession.  An archive holding a paper that does not verify is not
   rebuilt.
5. **The views are rebuilt** into a fresh SQLite database at ``--db``: a
   ``paper`` row and a ``paper_status`` row per paper (the status rules of
   :mod:`scholium_cli.status`), a ``paper_version`` row per signed version.
   The database is written only after everything verified; a failed rebuild
   leaves no file behind.

Then the paper count is printed.  Nothing in the database depends on the
clock, the locale or the block order: rebuilding the same archive twice
yields identical rows.

Exit codes:

``0``
    Rebuilt: the chain, every record and every paper verified, and the
    views were written.  (A retracted or corrected paper still rebuilds --
    the notice shows in its status, but its history is intact.)
``1``
    Not rebuilt: the log chain, a block, a record, the log's account of a
    record or a paper's own history failed verification.
``2``
    The command could not run: the archive cannot be read, the ``--db``
    path already exists or cannot be created.  Nothing was verified.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sqlite3
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from scholium_record_core import (
    GENESIS_TYPE,
    VERSION_TYPE,
    compute_record_id,
    derive_short_id,
    record_bytes,
    validate_manifest_body,
    verify_envelope,
    verify_paper,
)

from .archive import load_archive
from .car import CarError, read_car
from .status import STATUS_RECORD_TYPES, StatusResult, status_of

__all__ = [
    "EXIT_NOT_REBUILT",
    "EXIT_REBUILT",
    "EXIT_USAGE",
    "LogEntry",
    "RebuildResult",
    "add_arguments",
    "rebuild_car_bytes",
    "render",
    "run",
]

EXIT_REBUILT = 0
EXIT_NOT_REBUILT = 1
EXIT_USAGE = 2

#: ``prev_hash`` of the first entry of a log.
GENESIS_PREV_HASH = b"\x00" * 32

#: The database schema: the node's derived views (tech_architect §7.2),
#: named as the spec's ``database_schema`` spells them.
SCHEMA = """
CREATE TABLE paper (
    paper_cid           TEXT PRIMARY KEY,
    short_id            TEXT NOT NULL UNIQUE,
    title               TEXT NOT NULL,
    categories          TEXT NOT NULL,
    licence             TEXT NOT NULL,
    status              TEXT NOT NULL,
    latest_version_cid  TEXT,
    version_count       INTEGER NOT NULL,
    created             TEXT NOT NULL
);
CREATE TABLE paper_version (
    version_cid  TEXT PRIMARY KEY,
    paper_cid    TEXT NOT NULL REFERENCES paper (paper_cid),
    n            INTEGER NOT NULL,
    title        TEXT NOT NULL,
    abstract     TEXT NOT NULL,
    manifest_cid TEXT NOT NULL,
    prev_cid     TEXT,
    authors      TEXT NOT NULL,
    licence      TEXT NOT NULL,
    change_note  TEXT,
    created      TEXT NOT NULL,
    UNIQUE (paper_cid, n)
);
CREATE TABLE paper_status (
    paper_cid TEXT PRIMARY KEY REFERENCES paper (paper_cid),
    short_id  TEXT NOT NULL,
    status    TEXT NOT NULL,
    rule      TEXT NOT NULL,
    evidence  TEXT NOT NULL
);
"""


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the ``rebuild`` options to ``parser``."""
    parser.add_argument(
        "file", metavar="ARCHIVE.car", help="a CARv1 archive exported from a node"
    )
    parser.add_argument(
        "--db",
        metavar="PATH",
        required=True,
        help="the fresh database to build the views in (it must not exist yet)",
    )


# --- the log chain ----------------------------------------------------------


@dataclass(frozen=True)
class LogEntry:
    """One event-log entry, its chain fields normalised to bytes."""

    seq: int
    record_cid: str
    raw: bytes
    prev_hash: bytes
    entry_hash: bytes


def _as_bytes(value: Any, name: str, *, hex_form: bool) -> bytes | None:
    """Binary field as bytes; ``None`` when the value is neither form.

    A node writes DAG-CBOR bytes, but the same columns are served as hex
    (hashes) and standard base64 (``raw``) over the wire, so both are read.
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, str):
        try:
            return bytes.fromhex(value) if hex_form else base64.b64decode(
                value.encode("ascii"), validate=True
            )
        except ValueError:
            return None
    return None


def _parse_entry(mapping: Mapping[str, Any]) -> LogEntry | str:
    """Normalise one decoded log-entry block, or say why it cannot be."""
    where = "a log entry block is not well formed"
    seq = mapping.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        return f"{where}: seq must be a positive integer"
    record_cid = mapping.get("record_cid")
    if not isinstance(record_cid, str) or not record_cid:
        return f"{where}: record_cid must be a string"
    raw = _as_bytes(mapping.get("raw"), "raw", hex_form=False)
    if raw is None:
        return f"{where} (seq {seq}): raw must be bytes or standard base64"
    prev_hash = _as_bytes(mapping.get("prev_hash"), "prev_hash", hex_form=True)
    if prev_hash is None:
        return f"{where} (seq {seq}): prev_hash must be bytes or hexadecimal"
    entry_hash = _as_bytes(mapping.get("entry_hash"), "entry_hash", hex_form=True)
    if entry_hash is None:
        return f"{where} (seq {seq}): entry_hash must be bytes or hexadecimal"
    return LogEntry(seq, record_cid, raw, prev_hash, entry_hash)


def compute_entry_hash(prev_hash: bytes, record_cid: str, raw: bytes) -> bytes:
    """The log chain rule: ``sha256(prev_hash || utf8(record_cid) || raw)``."""
    return hashlib.sha256(prev_hash + record_cid.encode("utf-8") + raw).digest()


def _chain_problems(entries: Sequence[LogEntry]) -> list[str]:
    """The first way the entries stop being the log a node committed to."""
    expected_seq = 1
    expected_prev = GENESIS_PREV_HASH
    for entry in sorted(entries, key=lambda e: e.seq):
        if entry.seq != expected_seq:
            return [
                f"the log chain is broken: expected seq {expected_seq}, "
                f"found {entry.seq}"
            ]
        if entry.prev_hash != expected_prev:
            return [
                f"the log chain is broken at seq {entry.seq}: its prev_hash is "
                "not the entry_hash of the entry before it"
            ]
        if compute_entry_hash(entry.prev_hash, entry.record_cid, entry.raw) != entry.entry_hash:
            return [
                f"the log chain is broken at seq {entry.seq}: its entry_hash is "
                "not sha256(prev_hash || record_cid || raw)"
            ]
        expected_seq += 1
        expected_prev = entry.entry_hash
    return []


# --- the records ------------------------------------------------------------


def _authentication_problem(record: Mapping[str, Any]) -> str | None:
    """Why ``record`` is not authentic, or ``None`` when it is."""
    try:
        recomputed = compute_record_id(record)
    except (ValueError, KeyError, TypeError):
        return "is not a well-formed record"
    if record.get("id") != recomputed:
        return "id does not match the hash of its content"
    signature = record.get("sig")
    if not isinstance(signature, (str, bytes, bytearray)):
        return "has no signature"
    if not verify_envelope(record, signature):
        return "signature does not verify against its author"
    return None


def _record_problems(records: Sequence[Mapping[str, Any]]) -> list[str]:
    problems = []
    for record in records:
        problem = _authentication_problem(record)
        if problem is not None:
            problems.append(f"{record.get('type')} {record.get('id')}: {problem}")
    return problems


def _log_binding_problems(
    entries: Sequence[LogEntry], records: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Check that the log and the archive tell the same story."""
    by_id: dict[str, Mapping[str, Any]] = {
        record["id"]: record
        for record in records
        if isinstance(record.get("id"), str)
    }
    logged = {entry.record_cid for entry in entries}
    problems = []
    for record in records:
        record_id = record.get("id")
        if isinstance(record_id, str) and record_id not in logged:
            problems.append(f"{record.get('type')} {record_id} is not named by any log entry")
    for entry in entries:
        record = by_id.get(entry.record_cid)
        if record is None:
            continue  # the record is simply not in this archive; the chain covers it
        try:
            raw = record_bytes(record)
        except (ValueError, KeyError, TypeError):
            continue  # already reported: the record did not authenticate
        if raw != entry.raw:
            problems.append(
                f"log entry seq {entry.seq} does not carry the canonical bytes "
                f"of record {entry.record_cid}"
            )
    return problems


def _paper_ids(records: Sequence[Mapping[str, Any]]) -> list[str]:
    """Every paper the records describe or refer to, sorted."""
    ids: set[str] = set()
    for record in records:
        if record.get("type") == GENESIS_TYPE:
            record_id = record.get("id")
        elif record.get("type") == VERSION_TYPE:
            body = record.get("body")
            record_id = body.get("paper") if isinstance(body, Mapping) else None
        else:
            continue
        if isinstance(record_id, str) and record_id:
            ids.add(record_id)
    return sorted(ids)


def _short(paper_id: str) -> str | None:
    try:
        return derive_short_id(paper_id)
    except ValueError:
        return None


def _paper_problems(records: Sequence[Mapping[str, Any]]) -> list[str]:
    """Verify every paper the archive describes, as ``scholium verify`` does."""
    problems = []
    for paper_id in _paper_ids(records):
        label = _short(paper_id) or paper_id
        try:
            report = verify_paper(records, paper=paper_id)
        except ValueError:
            problems.append(
                f"{label}: a record names the paper id {paper_id}, "
                "which is not a valid record id"
            )
            continue
        if report.valid:
            continue
        failing = [check for check in report.checks.values() if not check.passed]
        problems.append(f"{label}: {failing[0].message}")
    return problems


# --- the views --------------------------------------------------------------


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _jsonable(value: Any) -> Any:
    """Map decoded DAG-CBOR values onto their JSON wire form."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    return value


def _json(value: Any) -> str:
    return json.dumps(_jsonable(value), sort_keys=True)


@dataclass(frozen=True)
class PaperView:
    paper_cid: str
    short_id: str
    title: str
    categories: str
    licence: str
    status: str
    latest_version_cid: str | None
    version_count: int
    created: str


@dataclass(frozen=True)
class VersionView:
    version_cid: str
    paper_cid: str
    n: int
    title: str
    abstract: str
    manifest_cid: str
    prev_cid: str | None
    authors: str
    licence: str
    change_note: str | None
    created: str


@dataclass(frozen=True)
class StatusView:
    paper_cid: str
    short_id: str
    status: str
    rule: str
    evidence: str


def _body_of(record: Mapping[str, Any]) -> Mapping[str, Any]:
    body = record.get("body")
    return body if isinstance(body, Mapping) else {}


def _version_number(record: Mapping[str, Any]) -> int:
    """``body.n`` when it is a number, else 0 (verified records always have one)."""
    n = _body_of(record).get("n")
    if isinstance(n, int) and not isinstance(n, bool):
        return n
    return 0


def _versions_of(records: Sequence[Mapping[str, Any]]) -> dict[str, list[Mapping[str, Any]]]:
    """Chain versions of each paper, oldest first (by ``n``, then id)."""
    by_paper: dict[str, list[Mapping[str, Any]]] = {}
    seen: set[str] = set()
    for record in records:
        if record.get("type") != VERSION_TYPE:
            continue
        record_id = record.get("id")
        if not isinstance(record_id, str) or record_id in seen:
            continue
        seen.add(record_id)
        paper_id = _body_of(record).get("paper")
        if isinstance(paper_id, str) and paper_id:
            by_paper.setdefault(paper_id, []).append(record)
    for versions in by_paper.values():
        versions.sort(key=lambda r: (_version_number(r), str(r.get("id"))))
    return by_paper


def _status_targets(records: Sequence[Mapping[str, Any]]) -> dict[str, set[str]]:
    """Map each target id a status record may name to the papers it implicates.

    A notice, moderation decision or review names a paper by its genesis
    record id, by one of its version record ids, or (moderation) by the cid
    of a file in one of its versions' manifests.
    """
    targets: dict[str, set[str]] = {}
    versions = _versions_of(records)
    by_id = {
        record["id"]: record
        for record in records
        if isinstance(record.get("id"), str)
    }

    def implicate(target: Any, paper_id: str) -> None:
        if isinstance(target, str) and target:
            targets.setdefault(target, set()).add(paper_id)

    for paper_id, paper_versions in versions.items():
        implicate(paper_id, paper_id)
        for version in paper_versions:
            implicate(version.get("id"), paper_id)
            body = version.get("body")
            manifest_id = body.get("manifest") if isinstance(body, Mapping) else None
            manifest = by_id.get(manifest_id) if isinstance(manifest_id, str) else None
            if manifest is None:
                continue
            try:
                files = validate_manifest_body(manifest.get("body"))["files"]
            except (ValueError, KeyError, TypeError):
                continue
            for entry in files:
                implicate(entry.get("cid"), paper_id)
    return targets


def _status_views(
    records: Sequence[Mapping[str, Any]], papers: Sequence[tuple[str, str]]
) -> list[StatusView]:
    """One status row per ``(paper_cid, short_id)``, in the order given."""
    targets = _status_targets(records)
    by_paper: dict[str, list[Mapping[str, Any]]] = {}
    for record in records:
        if record.get("type") not in STATUS_RECORD_TYPES:
            continue
        target = _body_of(record).get("target")
        for paper_id in targets.get(target, ()) if isinstance(target, str) else ():
            by_paper.setdefault(paper_id, []).append(record)

    views = []
    for paper_id, short_id in papers:
        result: StatusResult = status_of(by_paper.get(paper_id, []))
        views.append(
            StatusView(
                paper_cid=paper_id,
                short_id=short_id,
                status=result.status,
                rule=result.rule,
                evidence=_json(list(result.evidence)),
            )
        )
    return views


def build_views(
    records: Sequence[Mapping[str, Any]],
) -> tuple[list[PaperView], list[VersionView], list[StatusView]]:
    """Derive the paper, version and status views from verified records."""
    by_paper = _versions_of(records)
    by_id = {
        record["id"]: record
        for record in records
        if isinstance(record.get("id"), str)
    }

    statuses = _status_views(records, [(pid, _short(pid) or pid) for pid in _paper_ids(records)])
    status_by_paper = {status.paper_cid: status for status in statuses}

    papers: list[PaperView] = []
    versions: list[VersionView] = []
    for paper_id in _paper_ids(records):
        chain = by_paper.get(paper_id, [])
        head = chain[-1] if chain else None
        head_body = _body_of(head) if head is not None else {}
        genesis = by_id.get(paper_id)
        genesis_body = _body_of(genesis) if genesis is not None else {}
        short_id = _short(paper_id)
        assert short_id is not None  # every paper verified, so the id is a cid
        papers.append(
            PaperView(
                paper_cid=paper_id,
                short_id=short_id,
                title=_text(head_body.get("title")) or "",
                categories=_json(head_body.get("categories") or genesis_body.get("categories") or []),
                licence=_text(head_body.get("licence")) or _text(genesis_body.get("licence")) or "",
                status=status_by_paper[paper_id].status,
                latest_version_cid=_text(head.get("id")) if head is not None else None,
                version_count=len(chain),
                created=(_text(genesis.get("created")) if genesis is not None else None) or "",
            )
        )
        for version in chain:
            body = _body_of(version)
            versions.append(
                VersionView(
                    version_cid=str(version.get("id")),
                    paper_cid=paper_id,
                    n=_version_number(version),
                    title=_text(body.get("title")) or "",
                    abstract=_text(body.get("abstract")) or "",
                    manifest_cid=_text(body.get("manifest")) or "",
                    prev_cid=_text(version.get("prev")),
                    authors=_json(body.get("authors") or []),
                    licence=_text(body.get("licence")) or "",
                    change_note=_text(body.get("changeNote")),
                    created=_text(version.get("created")) or "",
                )
            )
    return papers, versions, statuses


def write_database(
    path: Path,
    papers: Sequence[PaperView],
    versions: Sequence[VersionView],
    statuses: Sequence[StatusView],
) -> None:
    """Create the fresh database at ``path`` and write the three views."""
    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        connection.executemany(
            "INSERT INTO paper VALUES (?,?,?,?,?,?,?,?,?)",
            [
                (
                    paper.paper_cid,
                    paper.short_id,
                    paper.title,
                    paper.categories,
                    paper.licence,
                    paper.status,
                    paper.latest_version_cid,
                    paper.version_count,
                    paper.created,
                )
                for paper in papers
            ],
        )
        connection.executemany(
            "INSERT INTO paper_version VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    version.version_cid,
                    version.paper_cid,
                    version.n,
                    version.title,
                    version.abstract,
                    version.manifest_cid,
                    version.prev_cid,
                    version.authors,
                    version.licence,
                    version.change_note,
                    version.created,
                )
                for version in versions
            ],
        )
        connection.executemany(
            "INSERT INTO paper_status VALUES (?,?,?,?,?)",
            [
                (
                    status.paper_cid,
                    status.short_id,
                    status.status,
                    status.rule,
                    status.evidence,
                )
                for status in statuses
            ],
        )
        connection.commit()
    finally:
        connection.close()


# --- the command ------------------------------------------------------------


@dataclass(frozen=True)
class RebuildResult:
    """The outcome of rebuilding one archive."""

    ok: bool
    problems: tuple[str, ...] = ()
    entry_count: int = 0
    head_seq: int | None = None
    record_count: int = 0
    file_count: int = 0
    paper_count: int = 0
    version_count: int = 0
    db_path: str | None = None


def rebuild_car_bytes(data: bytes, db_path: str | Path) -> RebuildResult:
    """Verify the archive in ``data`` and rebuild the views into ``db_path``.

    The database is written only when everything verified; a failed rebuild
    returns its problems and touches nothing.
    """
    try:
        car = read_car(data)
    except CarError as exc:
        return RebuildResult(
            ok=False, problems=(f"this file is not a readable CAR archive: {exc}",)
        )
    archive = load_archive(car)

    problems: list[str] = list(archive.corrupt_messages())

    entries: list[LogEntry] = []
    for mapping in archive.log_entries:
        parsed = _parse_entry(mapping)
        if isinstance(parsed, str):
            problems.append(parsed)
        else:
            entries.append(parsed)

    if archive.records and not entries:
        problems.append(
            "the archive carries no log entries, so the log chain cannot be verified"
        )
    problems.extend(_chain_problems(entries))
    problems.extend(_log_binding_problems(entries, archive.records))
    problems.extend(_record_problems(archive.records))
    problems.extend(_paper_problems(archive.records))

    if problems:
        return RebuildResult(
            ok=False,
            problems=tuple(problems),
            record_count=len(archive.records),
            file_count=len(archive.files),
        )

    papers, versions, statuses = build_views(archive.records)
    write_database(Path(db_path), papers, versions, statuses)
    return RebuildResult(
        ok=True,
        entry_count=len(entries),
        head_seq=max((entry.seq for entry in entries), default=None),
        record_count=len(archive.records),
        file_count=len(archive.files),
        paper_count=len(papers),
        version_count=len(versions),
        db_path=str(db_path),
    )


def _plural(count: int, noun: str) -> str:
    if count == 1:
        return f"1 {noun}"
    if noun.endswith("y"):
        return f"{count} {noun[:-1]}ies"
    return f"{count} {noun}s"


def render(result: RebuildResult) -> list[str]:
    """The rebuild report as lines of text."""
    if not result.ok:
        count = len(result.problems)
        lines = [f"Rebuild failed with {_plural(count, 'problem')}:"]
        lines.extend(f"  - {problem}" for problem in result.problems)
        lines.append("")
        lines.append(f"Result: NOT REBUILT ({_plural(count, 'problem')})")
        return lines

    span = f" (seq 1-{result.head_seq})" if result.head_seq else ""
    files = f", {_plural(result.file_count, 'file')}" if result.file_count else ""
    lines = [
        f"Log chain intact: {_plural(result.entry_count, 'entry')}{span}",
        f"{_plural(result.record_count, 'record')} authenticated{files}",
        f"Rebuilt {_plural(result.paper_count, 'paper')} "
        f"({_plural(result.version_count, 'version')}) into {result.db_path}",
        "",
        f"Result: REBUILT ({_plural(result.paper_count, 'paper')})",
    ]
    return lines


def run(args: argparse.Namespace, out: TextIO | None = None, err: TextIO | None = None) -> int:
    """Run ``scholium rebuild`` for parsed ``args``; return the exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    db = Path(args.db)
    if db.exists():
        print(
            f"scholium: {db} already exists; rebuild writes a fresh database -- "
            "move it aside or pass a new path",
            file=err,
        )
        return EXIT_USAGE
    path = Path(args.file)
    try:
        data = path.read_bytes()
    except OSError as exc:
        print(f"scholium: cannot read {path}: {exc.strerror or exc}", file=err)
        return EXIT_USAGE

    try:
        result = rebuild_car_bytes(data, db)
    except (OSError, sqlite3.Error) as exc:
        _discard(db)
        print(f"scholium: cannot write {db}: {exc}", file=err)
        return EXIT_USAGE

    for line in render(result):
        print(line, file=out)
    return EXIT_REBUILT if result.ok else EXIT_NOT_REBUILT


def _discard(db: Path) -> None:
    """Best-effort removal of a half-written database."""
    try:
        db.unlink()
    except OSError:
        pass
