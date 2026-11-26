"""``scholium verify <file.car>``: verify a paper or a whole node offline.

Reads the CARv1 archive, checks every block against its CID, verifies the
paper with :func:`scholium_record_core.verify_paper` and prints the
plain-language checklist (see :mod:`scholium_cli.checklist`).  Nothing here
touches the network.

An archive exported by ``GET /v1/export/archive.car`` holds a whole node: the
signed log head, every log entry, and the records of every paper.  When the
records describe more than one paper, ``verify`` checks the archive as a
whole -- the log's hash chain, the signed head, every record's signature and
content id -- and each paper's version history separately, printing a
per-paper summary.  ``--paper`` narrows that to one paper; a single-paper
archive is checked exactly as before.

Exit codes:

``0``
    Verified: every signature and hash checked out.  A paper that has been
    retracted, corrected or tombstoned still verifies -- the notice is shown
    on the checklist, but it is not a failure of the paper's history.
``1``
    Not verified: a signature, a hash or the archive itself failed (a block
    that does not match its CID, a broken version chain or log chain, a forged
    record or head, an unreadable archive).
``2``
    The command could not run: the file cannot be read or an option is
    invalid.  Nothing was verified.
"""

from __future__ import annotations

import dag_cbor
import httpx

import argparse
import base64
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

from scholium_record_core import (
    derive_short_id,
    parse_file_cid,
    verify_envelope,
    verify_paper,
)
from scholium_record_core.verify import (
    _coerce_authorities,
    paper_ids,
    record_problem,
    verify_signed_head,
)

from .archive import Archive, load_archive
from .car import CarError, read_car
from .checklist import (
    FAIL,
    PASS,
    PENDING,
    WARN,
    Item,
    Verdict,
    _archive_item,
    build_verdict,
    moderation_item,
    unreadable_verdict,
)
from .rebuild import (
    _chain_problems,
    _legacy_unsigned_erasure,
    _log_binding_problems,
    _parse_entry,
)

__all__ = [
    "EXIT_NOT_VERIFIED",
    "EXIT_USAGE",
    "EXIT_VERIFIED",
    "ArchiveVerdict",
    "PaperVerdict",
    "add_arguments",
    "render",
    "run",
    "verify_car_bytes",
]

EXIT_VERIFIED = 0
EXIT_NOT_VERIFIED = 1
EXIT_USAGE = 2

#: Findings printed under one item before the rest are summarised.
_DETAIL_LIMIT = 8

_UNICODE_MARKS = {PASS: "✓", FAIL: "✗", PENDING: "…", WARN: "!"}
_ASCII_MARKS = {PASS: "[ok]", FAIL: "[FAIL]", PENDING: "[..]", WARN: "[!]"}

#: The checklist lines that describe one paper, shown under its summary.
_PAPER_ITEM_KEYS = ("authors", "history", "files", "retraction", "withdrawal")

#: ``status`` values, most severe first, when reports of several papers merge.
_STATUS_SEVERITY = ("invalid", "retracted", "tombstoned", "corrected")

#: ``moderation.decision`` actions that set a version's state, as
#: ``app.modules.status.compute`` reads them.  The newest decision on a target
#: is the one in force, so a later ``release`` (or ``list``, ``reject``, ...)
#: ends a hold.
_STATE_SETTING_ACTIONS = frozenset(
    {"list", "hold", "reject", "delist", "tombstone", "release"}
)
_RELEASE_ACTION = "release"
_HELD_STATE = "held"
_REJECTED_STATE = "rejected"
_REJECT_ACTION = "reject"
_DELIST_ACTION = "delist"
_REJECTED_STATUS = "rejected"
_DELISTED_STATUS = "delisted"

#: The version state each plain state-setting action asks for, as
#: ``app.modules.moderation.decisions.ACTION_STATES`` maps them.  A ``release``
#: names its state in the record, so it is read from ``body.state`` instead,
#: and a ``tombstone`` moves the version it can to ``rejected``.
_ACTION_STATES = {
    "list": "listed",
    "hold": _HELD_STATE,
    "reject": _REJECTED_STATE,
    "delist": _REJECTED_STATE,
    "tombstone": _REJECTED_STATE,
}
_LISTED_STATE = "listed"
_MODERATION_STATE = "moderation"

#: The states a ``release`` may name (``app.modules.moderation.decisions``).
_RELEASE_STATES = frozenset(
    {_LISTED_STATE, _MODERATION_STATE, _HELD_STATE, _REJECTED_STATE}
)

#: The state of a paper no version of which a moderator has listed: the
#: archive cannot tell a version held by the safety scan from one still in
#: the moderation queue (both leave no public decision), so it says only that
#: no version is listed yet -- never "awaiting moderation", which claims a
#: queue position the records cannot show (bug_spec_verify27, D1).
_NOT_LISTED_YET = "not listed yet"

#: An unreadable ``created`` sorts before every real time.
_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class PaperVerdict:
    """One paper's outcome inside a whole-node archive."""

    label: str
    """``sch:xxxx-xxxx-xxxx/vN`` when known, else the genesis record id."""
    report: Any = None
    """The :class:`~scholium_record_core.VerificationReport`, when it ran."""
    items: tuple[Item, ...] = ()
    """The paper's own checklist lines (authors, history, files, notices)."""
    problems: tuple[str, ...] = ()
    """Why the paper could not be verified at all, when it could not."""
    status: str = "invalid"
    withdrawn: int = 0

    @property
    def ok(self) -> bool:
        return not self.problems and all(item.state != FAIL for item in self.items)


@dataclass(frozen=True)
class ArchiveVerdict:
    """The outcome of verifying a whole-node archive: every paper in it."""

    items: tuple[Item, ...]
    """The archive-wide checks: blocks, log chain, signed head, records."""
    papers: tuple[PaperVerdict, ...]
    status: str
    block_count: int = 0
    record_count: int = 0
    file_count: int = 0
    #: Kept for callers that treat both verdict kinds alike.
    report: None = None
    version: None = None

    @property
    def ok(self) -> bool:
        """True when every archive-wide check and every paper passed."""
        return all(item.state != FAIL for item in self.items) and all(
            paper.ok for paper in self.papers
        )

    @property
    def failures(self) -> tuple[Item, ...]:
        found = [item for item in self.items if item.state == FAIL]
        for paper in self.papers:
            for problem in paper.problems:
                found.append(Item("paper", FAIL, f"{paper.label}: {problem}"))
            found.extend(item for item in paper.items if item.state == FAIL)
        return tuple(found)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    """Add the ``verify`` options to ``parser``."""
    parser.add_argument("file", metavar="FILE.car", help="a CARv1 archive exported from a node")
    parser.add_argument(
        "--paper",
        metavar="ID",
        help="verify only this paper (sch: id or genesis record id) from an "
        "archive holding more than one",
    )
    parser.add_argument(
        "--head",
        metavar="ID",
        help="the version to verify (sch:xxxx-xxxx-xxxx/vN or version record id); "
        "defaults to the newest, needed to choose between competing heads",
    )
    parser.add_argument(
        "--authority",
        metavar="DID",
        action="append",
        default=[],
        help="a did:key you trust to retract, correct or tombstone any paper "
        "(repeatable); without it only a paper's own authors can retract or "
        "correct it and no tombstone applies",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="also print record ids, signers and every individual finding",
    )
    parser.add_argument(
        "--node",
        metavar="URL",
        help="fetch the records and proofs from this node instead of reading a "
        "local archive (pass an sch: id as the positional argument)",
    )


def verify_car_bytes(
    data: bytes,
    *,
    paper: str | None = None,
    head: str | None = None,
    authorities: Sequence[str] = (),
) -> Verdict | ArchiveVerdict:
    """Verify the archive in ``data``.

    A whole-node archive (one whose records describe more than one paper) is
    verified in full when neither ``paper`` nor ``head`` narrows it; every
    other archive is verified as one paper, as before.

    Raises:
        ValueError: if ``paper``, ``head`` or ``authorities`` is malformed.
    """
    try:
        car = read_car(data)
    except CarError as exc:
        return unreadable_verdict(str(exc))
    archive = load_archive(car)
    if paper is None and head is None:
        described = paper_ids(archive.records)
        if len(described) > 1:
            return _whole_node_verdict(archive, authorities)
    report = verify_paper(archive.records, paper=paper, head=head, authorities=authorities)
    return build_verdict(archive, report)


# --- a whole node: the log, every record, every paper --------------------


def _plural(count: int, noun: str) -> str:
    if count == 1:
        return f"1 {noun}"
    if noun.endswith("y"):
        return f"{count} {noun[:-1]}ies"
    return f"{count} {noun}s"


def _short(record_id: str) -> str | None:
    try:
        return derive_short_id(record_id)
    except ValueError:
        return None


def _record_label(record: Any) -> str:
    return f"{record.get('type')} {record.get('id')}"


def _log_chain_item(archive: Archive) -> Item | None:
    """The event log's hash chain, when the archive carries log entries."""
    if not archive.log_entries:
        return None
    entries = []
    problems: list[str] = []
    for mapping in archive.log_entries:
        parsed = _parse_entry(mapping)
        if isinstance(parsed, str):
            problems.append(parsed)
        else:
            entries.append(parsed)
    problems.extend(_chain_problems(entries))
    if problems:
        return Item(
            "log",
            FAIL,
            f"The log chain is broken: {problems[0]}",
            tuple(problems),
        )
    head_seq = max(entry.seq for entry in entries)
    return Item(
        "log",
        PASS,
        f"Log chain intact: {_plural(len(entries), 'entry')} (seq 1-{head_seq})",
    )


def _head_item(archive: Archive) -> Item | None:
    """The node's signed log head, when the archive carries one."""
    if archive.head is None:
        return None
    last = None
    if archive.log_entries:
        last = max(
            archive.log_entries,
            key=lambda entry: entry["seq"]
            if isinstance(entry.get("seq"), int) and not isinstance(entry.get("seq"), bool)
            else -1,
        )
    problem = verify_signed_head(archive.head, last_entry=last)
    if problem is not None:
        return Item(
            "head",
            FAIL,
            f"The signed log head does not verify: it {problem}",
        )
    return Item(
        "head",
        PASS,
        f"The log head is signed by {archive.head.get('node_did')}",
    )


def _records_item(archive: Archive) -> Item:
    """Every record's content id and signature, whether or not a paper uses it."""
    records = archive.records
    if not records:
        return Item("records", PASS, "The archive carries no records")
    legacy = sum(1 for record in records if _legacy_unsigned_erasure(record))
    details = [
        f"{_record_label(record)}: {problem}"
        for record in records
        if not _legacy_unsigned_erasure(record)
        if (problem := record_problem(record)) is not None
    ]
    if details:
        return Item(
            "records",
            FAIL,
            f"{_plural(len(details), 'record')} failed authentication: {details[0]}",
            tuple(details),
        )
    if legacy:
        return Item(
            "records",
            PASS,
            f"{len(records) - legacy} of {len(records)} records carry a valid "
            "signature from their author",
        )
    return Item(
        "records",
        PASS,
        f"All {len(records)} records carry a valid signature from their author",
    )


def _legacy_item(archive: Archive) -> Item | None:
    """Unsigned erasure requests a pre-D1 log holds, accepted as legacy (D1).

    A member's profile erasure used to be appended unsigned; the node signs
    them now, but a log written before that keeps its unsigned ones forever.
    They can never authenticate, so they are reported here, on their own line,
    and do not fail the archive.
    """
    count = sum(1 for record in archive.records if _legacy_unsigned_erasure(record))
    if not count:
        return None
    return Item(
        "legacy",
        WARN,
        f"{_plural(count, 'legacy erasure record')} without a signature (accepted)",
    )


def _log_records_item(archive: Archive) -> Item | None:
    """The log's account of the records: binding and its stored signatures.

    A node exports each record's canonical bytes beside a log entry that names
    them and carries the author's signature.  The chain check proves the log
    was not rewritten; this check proves the log and the record blocks tell the
    same story and that each signature in the log authenticates its record.
    """
    if not archive.log_entries:
        return None
    parsed: list[tuple[Any, Any]] = []
    for mapping in archive.log_entries:
        entry = _parse_entry(mapping)
        if not isinstance(entry, str):  # malformed entries are the chain check's
            parsed.append((mapping, entry))
    problems = _log_binding_problems(
        [entry for _mapping, entry in parsed], archive.records
    )
    for mapping, entry in parsed:
        signature = mapping.get("sig")
        if not isinstance(signature, (str, bytes, bytearray)):
            continue  # an unsigned entry is a record-level failure if it matters
        try:
            record = dag_cbor.decode(entry.raw)
        except (ValueError, TypeError, RecursionError):
            record = None
        if not isinstance(record, dict) or not verify_envelope(record, signature):
            problems.append(
                f"log entry seq {entry.seq} carries a signature that does not "
                "verify against its author"
            )
    if problems:
        return Item(
            "log-records",
            FAIL,
            f"The log does not match the records: {problems[0]}",
            tuple(problems),
        )
    if any(record_problem(record) is not None for record in archive.records):
        # A record did not authenticate (the records line already reports it,
        # and an accepted legacy erasure did not authenticate either), so the
        # tick below would contradict it.
        return None
    return Item(
        "log-records",
        PASS,
        "Every log entry carries its record and the author's signature",
    )


def _created(value: Any) -> datetime:
    """Read an envelope's ``created``; anything unreadable sorts first."""
    if not isinstance(value, str):
        return _EPOCH
    try:
        when = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return _EPOCH
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


def _action(value: Any) -> str | None:
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def _version_record_ids(archive: Archive, paper_id: str) -> set[str]:
    """The paper's genesis and every version record id a decision may target."""
    ids = {paper_id}
    for record in archive.records:
        if record.get("type") != "paper.version":
            continue
        body = record.get("body")
        if isinstance(body, Mapping) and body.get("paper") == paper_id:
            record_id = record.get("id")
            if isinstance(record_id, str):
                ids.add(record_id)
    return ids


def _state_of_decision(body: Mapping[str, Any]) -> str | None:
    """The version state the decision in ``body`` asks for, if it sets one."""
    action = _action(body.get("action"))
    if action not in _STATE_SETTING_ACTIONS:
        return None
    if action == _RELEASE_ACTION:
        state = _action(body.get("state"))
        return state if state in _RELEASE_STATES else None
    return _ACTION_STATES.get(action)


def _states_in_force(archive: Archive, targets: Iterable[str]) -> dict[str, str]:
    """The state each of ``targets`` is in, from the newest decision on it.

    The node settles a version's state by its newest state-setting decision
    (``app.modules.status.compute``).  An archive carries those same decisions,
    so the summary can read the state the node's own pages show: a later
    ``release`` -- or any other state-setting decision -- replaces the earlier
    one, and only the newest counts.  A target no decision has set is absent,
    which is the moderation queue's own "no decision yet".
    """
    targets = frozenset(targets)
    current: dict[str, tuple[datetime, str, str]] = {}
    for record in archive.records:
        if record.get("type") != "moderation.decision":
            continue
        body = record.get("body")
        if not isinstance(body, Mapping):
            continue
        target = body.get("target")
        if not isinstance(target, str) or target not in targets:
            continue
        state = _state_of_decision(body)
        if state is None:
            continue
        record_id = record.get("id")
        order = (
            _created(record.get("created")),
            record_id if isinstance(record_id, str) else "",
        )
        if target not in current or order > current[target][:2]:
            current[target] = (order[0], order[1], state)
    return {target: state for target, (_, _, state) in current.items()}


def _held_in_force(archive: Archive, paper_id: str) -> bool:
    """Whether a moderation hold is in force on any version of ``paper_id``."""
    states = _states_in_force(archive, _version_record_ids(archive, paper_id))
    return _HELD_STATE in states.values()


def _newest_version_id(archive: Archive, paper_id: str) -> str | None:
    """The record id of the paper's newest posted version, when it has one."""
    versions = _posted_versions(archive, paper_id)
    return versions[-1] if versions else None


def _decision_in_force(archive: Archive, target: str) -> tuple[str | None, str | None]:
    """The newest state-setting decision on ``target``: ``(action, state)``.

    The action distinguishes a ``reject`` from a ``delist`` (both leave the
    version in the rejected state), which the summary names separately.
    ``(None, None)`` means no decision sets the target -- the records show no
    public decision at all.
    """
    current: tuple[tuple[datetime, str], str | None, str] | None = None
    for record in archive.records:
        if record.get("type") != "moderation.decision":
            continue
        body = record.get("body")
        if not isinstance(body, Mapping) or body.get("target") != target:
            continue
        state = _state_of_decision(body)
        if state is None:
            continue
        record_id = record.get("id")
        order = (
            _created(record.get("created")),
            record_id if isinstance(record_id, str) else "",
        )
        if current is None or order > current[0]:
            current = (order, _action(body.get("action")), state)
    if current is None:
        return None, None
    return current[1], current[2]


def _decision_record_in_force(
    archive: Archive, target: str
) -> Mapping[str, Any] | None:
    """The newest state-setting decision on ``target``, as a record.

    :func:`_decision_in_force` answers what the decision *does*; this returns
    the record itself so the per-paper checklist can name its clause, reason
    and signer.  ``None`` means no decision sets the target's state.
    """
    current: tuple[tuple[datetime, str], Mapping[str, Any]] | None = None
    for record in archive.records:
        if record.get("type") != "moderation.decision":
            continue
        body = record.get("body")
        if not isinstance(body, Mapping) or body.get("target") != target:
            continue
        if _state_of_decision(body) is None:
            continue
        record_id = record.get("id")
        order = (
            _created(record.get("created")),
            record_id if isinstance(record_id, str) else "",
        )
        if current is None or order > current[0]:
            current = (order, record)
    return current[1] if current is not None else None


def _unlisted_status(archive: Archive, paper_id: str) -> tuple[str, bool]:
    """How an unlisted paper reads, and whether a public decision is in force.

    No public decision is "not listed yet": the archive cannot tell a version
    held by the safety scan from one still in the moderation queue (D1), so it
    never claims "awaiting moderation".  A ``reject`` or ``delist`` decision in
    force is named as such; a hold is settled by ``_held_in_force`` first.
    """
    target = _newest_version_id(archive, paper_id) or paper_id
    action, state = _decision_in_force(archive, target)
    if action is None and state is None:
        return _NOT_LISTED_YET, False
    if action == _DELIST_ACTION:
        return _DELISTED_STATUS, True
    if action == _REJECT_ACTION or state == _REJECTED_STATE:
        return _REJECTED_STATUS, True
    if state == _HELD_STATE:  # a hold on the newest version, should one slip past
        return _HELD_STATE, True
    return _NOT_LISTED_YET, True


def _any_version_listed(archive: Archive, paper_id: str) -> bool:
    """Whether any of the paper's versions is listed.

    The node's catalog serves a paper while at least one of its versions is
    listed: a paper ``sch:`` id resolves to the newest *listed* version (so a
    queued newer version does not hide the listed one), and the node counts a
    paper with at least one listed version.  Only a ``list`` decision (or a
    ``release`` naming ``listed``) puts a version in the catalog; a version no
    moderator has decided on, or one held or rejected, is not listed.
    """
    targets = _version_record_ids(archive, paper_id)
    return _LISTED_STATE in _states_in_force(archive, targets).values()


def _posted_versions(archive: Archive, paper_id: str) -> list[str]:
    """The record ids of the paper's ``paper.version`` records, oldest first.

    ``body.n`` is the version number; a fork may hold two records with the same
    number, so ``created`` and the record id break the tie the way the rest of
    the summary orders decisions.
    """
    versions: list[tuple[tuple[int, datetime, str], str]] = []
    for record in archive.records:
        if record.get("type") != "paper.version":
            continue
        body = record.get("body")
        if not isinstance(body, Mapping) or body.get("paper") != paper_id:
            continue
        record_id = record.get("id")
        if not isinstance(record_id, str):
            continue
        number = body.get("n")
        if isinstance(number, bool) or not isinstance(number, int):
            number = 0
        versions.append(((number, _created(record.get("created")), record_id), record_id))
    versions.sort()
    return [record_id for _key, record_id in versions]


def _newest_listed_head(archive: Archive, paper_id: str) -> tuple[str | None, int]:
    """The version to verify, and how many newer versions are not listed.

    ``(None, 0)`` means "verify the newest version", which is both the old
    behaviour and the right answer when the newest version is listed or when
    no version of the paper is (it is then in the moderation queue).

    A paper whose newest version no moderator has listed, but an older one
    has, is served by the node as that older, newest listed version -- and an
    archive carries the files that version's manifest names, not the queued
    newer version's.  Verifying the newest version would therefore report its
    file as missing and never compare the file the archive does hold.  So the
    newest listed version is the head, and the count is the newer versions
    whose files are consequently absent.
    """
    versions = _posted_versions(archive, paper_id)
    if not versions:
        return None, 0
    states = _states_in_force(archive, versions)
    if states.get(versions[-1]) == _LISTED_STATE:
        return None, 0
    listed = [
        record_id for record_id in versions if states.get(record_id) == _LISTED_STATE
    ]
    if not listed:
        return None, 0
    head = listed[-1]
    return head, len(versions) - versions.index(head) - 1


def _paper_verdict(archive: Archive, paper_id: str, authorities: Iterable[str]) -> PaperVerdict:
    label = _short(paper_id) or paper_id
    head, newer = _newest_listed_head(archive, paper_id)
    try:
        report = verify_paper(
            archive.records, paper=paper_id, head=head, authorities=authorities
        )
    except ValueError as exc:
        # A record names a paper with an id that is not a record id at all.
        return PaperVerdict(label=label, problems=(str(exc),))
    verdict = build_verdict(archive, report)
    items = tuple(item for item in verdict.items if item.key in _PAPER_ITEM_KEYS)
    if newer:
        # The archive holds the listed version's file, not the newer, unlisted
        # one's: say so on one line rather than muting the whole files check.
        text = (
            "1 newer version not listed yet (its file is not in this archive)"
            if newer == 1
            else f"{newer} newer versions not listed yet "
            "(their files are not in this archive)"
        )
        items += (Item("version", WARN, text),)
    failed = any(item.state == FAIL for item in items) or not report.valid
    status = "invalid" if failed else report.status
    # The report's own status is about the paper's history; a hold is the
    # node's current moderation state of it and outranks a correction, but
    # never a retraction or tombstone (nor an invalid history).
    if not failed and status in ("verified", "corrected") and _held_in_force(archive, paper_id):
        status = _HELD_STATE
    elif (
        not failed
        and status == "verified"
        and not _any_version_listed(archive, paper_id)
    ):
        # Verified history, but no moderator has listed any of its versions.
        # The records say only what the decision in force says -- a reject or
        # delist, or nothing public yet.
        status, decided = _unlisted_status(archive, paper_id)
        if not decided:
            items += (
                Item(
                    "listing",
                    PENDING,
                    "No public decision yet: the safety scan and the moderation "
                    "queue are not part of the public record.",
                ),
            )
    # A hold, rejection or delisting in force on the newest version is the
    # public decision that explains the paper's state; name it with its clause
    # and reason, as a "not listed yet" paper and a withdrawal are named (D1,
    # bug_spec_verify29).  A release or a later list adds no line.
    decision = _decision_record_in_force(
        archive, _newest_version_id(archive, paper_id) or paper_id
    )
    if decision is not None:
        notice = moderation_item(decision)
        if notice is not None:
            items += (notice,)
    withdrawn_count = sum(1 for item in items if item.key == "withdrawal")
    return PaperVerdict(
        label=verdict.version or report.short_id or label,
        report=report,
        items=items,
        status=status,
        withdrawn=withdrawn_count,
    )


def _whole_node_status(papers: Sequence[PaperVerdict]) -> str:
    statuses = {paper.status for paper in papers}
    for status in _STATUS_SEVERITY:
        if status in statuses:
            return status
    return "verified"


def _whole_node_verdict(
    archive: Archive, authorities: Sequence[str]
) -> ArchiveVerdict:
    """Verify a whole-node archive: its log, its records and every paper."""
    # Bad arguments are a usage error (exit 2), never a paper's failure.
    trusted = _coerce_authorities(authorities)

    items: list[Item] = [_archive_item(archive)]
    for item in (
        _log_chain_item(archive),
        _head_item(archive),
        _records_item(archive),
        _legacy_item(archive),
        _log_records_item(archive),
    ):
        if item is not None:
            items.append(item)

    papers = tuple(
        _paper_verdict(archive, paper_id, trusted)
        for paper_id in paper_ids(archive.records)
    )
    failed = any(item.state == FAIL for item in items)
    return ArchiveVerdict(
        items=tuple(items),
        papers=papers,
        status="invalid" if failed else _whole_node_status(papers),
        block_count=archive.block_count,
        record_count=len(archive.records),
        file_count=len(archive.files),
    )


def _marks(stream: TextIO) -> dict[str, str]:
    try:
        "✓✗…".encode(stream.encoding or "ascii")
    except (UnicodeEncodeError, LookupError):
        return _ASCII_MARKS
    return _UNICODE_MARKS


def render(
    verdict: Verdict | ArchiveVerdict,
    name: str,
    *,
    verbose: bool = False,
    marks: dict[str, str],
) -> list[str]:
    """The checklist as lines of text."""
    if isinstance(verdict, ArchiveVerdict):
        return _render_whole_node(verdict, name, verbose=verbose, marks=marks)

    report = verdict.report
    lines = [f"Verifying {name}"]
    if report is not None and report.short_id is not None:
        lines.append(f"Paper: {verdict.version or report.short_id}")
    if verdict.block_count:
        lines.append(
            f"Archive: {verdict.block_count} blocks "
            f"({verdict.record_count} records, {verdict.file_count} files)"
        )
    lines.append("")

    width = max(len(mark) for mark in marks.values())
    for item in verdict.items:
        lines.append(f"  {marks[item.state].ljust(width)} {item.text}")
        lines.extend(_detail_lines(item, verbose, indent=" " * (width + 5)))

    if verbose and report is not None:
        lines.extend(_technical_details(report))

    lines.append("")
    lines.append(_result_line(verdict))
    return lines


def _render_whole_node(
    verdict: ArchiveVerdict,
    name: str,
    *,
    verbose: bool,
    marks: dict[str, str],
) -> list[str]:
    """A whole-node archive: the archive-wide checks, then one block per paper."""
    lines = [f"Verifying {name}"]
    if verdict.block_count:
        lines.append(
            f"Archive: {verdict.block_count} blocks "
            f"({verdict.record_count} records, {verdict.file_count} files)"
        )
    lines.append("")

    width = max(len(mark) for mark in marks.values())
    indent = " " * (width + 5)
    for item in verdict.items:
        lines.append(f"  {marks[item.state].ljust(width)} {item.text}")
        lines.extend(_detail_lines(item, verbose, indent=indent))

    for paper in verdict.papers:
        lines.append("")
        lines.append(f"Paper {paper.label}")
        if paper.problems:
            for problem in paper.problems:
                lines.append(f"  {marks[FAIL].ljust(width)} {problem}")
            continue
        for item in paper.items:
            lines.append(f"  {marks[item.state].ljust(width)} {item.text}")
            lines.extend(_detail_lines(item, verbose, indent=indent))
        if verbose and paper.report is not None:
            lines.extend(_technical_details(paper.report))

    lines.append("")
    lines.append(_result_line(verdict))
    return lines


def _technical_details(report: Any) -> list[str]:
    lines = ["", "Technical details"]
    lines.append(f"  genesis  {report.genesis}")
    lines.append(f"  head     {report.head}")
    lines.append(f"  status   {report.status}")
    for did in report.signers:
        lines.append(f"  signer   {did}")
    for check_name, check in report.checks.items():
        lines.append(
            f"  {check_name:<12} {'ok' if check.passed else 'FAILED'}: {check.message}"
        )
    return lines


def _detail_lines(item: Item, verbose: bool, indent: str) -> list[str]:
    if not item.details or not (verbose or item.state in (FAIL, WARN)):
        return []
    shown = item.details if verbose else item.details[:_DETAIL_LIMIT]
    lines = [f"{indent}- {detail}" for detail in shown]
    if len(shown) < len(item.details):
        lines.append(f"{indent}- ... and {len(item.details) - len(shown)} more (use --verbose)")
    return lines


def _result_line(verdict: Verdict | ArchiveVerdict) -> str:
    if not verdict.ok:
        count = len(verdict.failures)
        return f"Result: NOT VERIFIED ({count} check{'s' if count != 1 else ''} failed)"
    if isinstance(verdict, ArchiveVerdict):
        return _whole_node_result_line(verdict)
    if verdict.status == "verified":
        return "Result: VERIFIED"
    return f"Result: VERIFIED (status: {verdict.status})"


def _whole_node_result_line(verdict: ArchiveVerdict) -> str:
    """The result of a whole-node archive: how many papers, and in what state.

    A single paper's status is its own; an archive's is not.  Summing the
    papers is the honest summary -- carrying one retracted paper's status
    would make every other paper in the export read as retracted too.
    """
    counts = {status: 0 for status in _STATUS_SEVERITY if status != "invalid"}
    listed = 0
    held = 0
    not_listed = 0
    rejected = 0
    delisted = 0
    withdrawn = 0
    for paper in verdict.papers:
        if paper.status == "verified":
            listed += 1
        elif paper.status == _HELD_STATE:
            held += 1
        elif paper.status == _NOT_LISTED_YET:
            not_listed += 1
        elif paper.status == _REJECTED_STATUS:
            rejected += 1
        elif paper.status == _DELISTED_STATUS:
            delisted += 1
        else:
            counts[paper.status] = counts.get(paper.status, 0) + 1
        if paper.withdrawn:
            withdrawn += 1
    parts = [f"{listed} listed"]
    if held:
        parts.append(f"{held} held")
    if rejected:
        parts.append(f"{rejected} rejected")
    if delisted:
        parts.append(f"{delisted} delisted")
    if not_listed:
        parts.append(f"{not_listed} {_NOT_LISTED_YET}")
    for status in ("corrected", "retracted", "tombstoned"):
        if counts.get(status):
            parts.append(f"{counts[status]} {status}")
    if withdrawn:
        if withdrawn == 1:
            parts.append("1 withdrawn by its authors")
        else:
            parts.append(f"{withdrawn} withdrawn by their authors")
    return (
        f"Result: VERIFIED — {_plural(len(verdict.papers), 'paper')} "
        f"({', '.join(parts)})"
    )


def _fetch_sync_range(base: str, cursor: int = 0) -> list[dict[str, Any]]:
    """Fetch every event-log entry from ``base`` (paginated)."""
    entries: list[dict[str, Any]] = []
    seen: set[int] = set()
    current = cursor
    while True:
        response = httpx.get(
            f"{base}/v1/sync/range", params={"from": current}, timeout=30.0
        )
        response.raise_for_status()
        page = response.json()
        if not isinstance(page, list) or not page:
            break
        new_items = [item for item in page if item.get("seq") not in seen]
        if not new_items:
            break
        for item in new_items:
            seen.add(item.get("seq"))
        entries.extend(new_items)
        current = max(item.get("seq", current) for item in new_items)
        if len(page) < 1:
            break
    return entries


def _run_node(args: argparse.Namespace, out: TextIO, err: TextIO) -> int:
    """Run ``scholium verify ... --node URL``; return the exit code."""
    base = str(args.node).rstrip("/")
    target = str(getattr(args, "file", None) or getattr(args, "target", None) or "")
    paper = args.paper or (target.split("/")[0] if target.startswith("sch:") else None)
    head = args.head or (target if "/" in target else None)
    authorities = list(args.authority or [])

    entries: list[dict[str, Any]] = []
    sync_error: Exception | None = None
    try:
        entries = _fetch_sync_range(base)
    except Exception as exc:  # noqa: BLE001 - network/HTTP/JSON failure
        sync_error = exc

    records: list[dict[str, Any]] = []
    files: dict[bytes, bytes] = {}
    if entries:
        for entry in entries:
            raw_value = entry.get("raw")
            try:
                raw = base64.b64decode(str(raw_value), validate=True)
                value = dag_cbor.decode(raw)
            except Exception:  # noqa: BLE001 - skip malformed entries
                continue
            if not isinstance(value, dict):
                continue
            record = dict(value)
            if "id" not in record:
                record["id"] = entry.get("record_cid")
            # ``raw`` is the canonical record: the bytes the id hashes, which
            # never include ``sig``.  The node serves the author's signature
            # beside it on the log entry; without it every record is unsigned.
            # (The signature is still checked cryptographically by
            # ``verify_paper``; a full envelope keeps the one it carries.)
            signature = entry.get("sig")
            if record.get("sig") is None and isinstance(signature, str):
                record["sig"] = signature
            records.append(record)

        # Fetch proofs (best effort: the node must answer, but a failure to
        # fetch one does not invalidate the records we already hold).
        for entry in entries:
            cid = entry.get("record_cid")
            if not isinstance(cid, str):
                continue
            try:
                httpx.get(f"{base}/v1/records/{cid}/proof", timeout=30.0).raise_for_status()
            except Exception:  # noqa: BLE001
                pass

        # Fetch file bytes for any manifest we can decode (best effort).
        record_by_id = {r.get("id"): r for r in records if isinstance(r.get("id"), str)}
        for record in records:
            body = record.get("body")
            if not isinstance(body, dict):
                continue
            manifest_cid = body.get("manifest")
            manifest = record_by_id.get(manifest_cid) if isinstance(manifest_cid, str) else None
            if not isinstance(manifest, dict):
                continue
            manifest_body = manifest.get("body")
            if not isinstance(manifest_body, dict):
                continue
            for entry_file in manifest_body.get("files", []) or []:
                if not isinstance(entry_file, dict):
                    continue
                cid = entry_file.get("cid")
                if not isinstance(cid, str):
                    continue
                try:
                    response = httpx.get(f"{base}/v1/content/{cid}", timeout=30.0)
                    response.raise_for_status()
                except Exception:  # noqa: BLE001
                    continue
                try:
                    key = bytes(parse_file_cid(cid))
                except Exception:  # noqa: BLE001
                    continue
                files[key] = response.content

    # Fall back to an exported CAR when the log could not be replayed.
    if not records:
        paper_id = paper or target.split("/")[0]
        try:
            response = httpx.get(f"{base}/v1/export/paper/{paper_id}.car", timeout=30.0)
            response.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            cause = sync_error if sync_error is not None else exc
            print(f"scholium: cannot fetch from {base}: {cause}", file=err)
            return EXIT_USAGE
        try:
            verdict = verify_car_bytes(
                response.content, paper=paper, head=head, authorities=authorities
            )
        except ValueError as exc:
            print(f"scholium: {exc}", file=err)
            return EXIT_USAGE
        name = target
        for line in render(verdict, name, verbose=args.verbose, marks=_marks(out)):
            print(line, file=out)
        return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED

    try:
        archive = Archive(
            block_count=len(entries) + len(records) + len(files),
            records=tuple(records),
            files=files,
            corrupt={},
            cids={},
        )
        report = verify_paper(tuple(records), paper=paper, head=head, authorities=authorities)
    except ValueError as exc:
        print(f"scholium: {exc}", file=err)
        return EXIT_USAGE
    verdict = build_verdict(archive, report)

    name = target
    for line in render(verdict, name, verbose=args.verbose, marks=_marks(out)):
        print(line, file=out)
    return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED


def run(args: argparse.Namespace, out: TextIO | None = None, err: TextIO | None = None) -> int:
    """Run ``scholium verify`` for parsed ``args``; return the exit code."""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    if getattr(args, "node", None):
        return _run_node(args, out, err)

    target = getattr(args, "file", None) or getattr(args, "target", None)
    path = Path(target)
    try:
        data = path.read_bytes()
    except OSError as exc:
        print(f"scholium: cannot read {path}: {exc.strerror or exc}", file=err)
        return EXIT_USAGE
    try:
        verdict = verify_car_bytes(
            data, paper=args.paper, head=args.head, authorities=args.authority
        )
    except ValueError as exc:
        print(f"scholium: {exc}", file=err)
        return EXIT_USAGE

    for line in render(verdict, path.name, verbose=args.verbose, marks=_marks(out)):
        print(line, file=out)
    return EXIT_VERIFIED if verdict.ok else EXIT_NOT_VERIFIED
