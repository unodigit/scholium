"""Verification of a whole paper from a set of records.

:func:`verify_paper` is the offline verifier of ``docs/tech_architect.md``
§3.4.  Given the records of a paper -- in any order, possibly mixed with
records of other papers and with reviews, discussion and so on -- it
follows ``prev`` links from the newest version back to the genesis record,
and reports whether the paper is intact and what its standing is::

    report = verify_paper(records)
    report.status          # "verified" | "corrected" | "retracted" |
                           # "tombstoned" | "invalid"
    report.signers         # DIDs whose signatures authenticate the paper
    report.version_count   # versions followed from head to genesis
    report.checks          # {"chain": CheckResult, "signatures": ...}

Record shapes
-------------

* ``paper.genesis`` -- ``prev`` is ``null``.  Its record id *is* the paper
  (:func:`~scholium_record_core.short_id.derive_short_id` gives the
  ``sch:`` id).
* ``paper.version`` -- ``body.paper`` is the genesis record id, ``body.n``
  the version number, ``body.authors`` a non-empty list of
  ``{"did": ...}`` entries, ``body.manifest`` the id of a ``manifest``
  record.  ``prev`` names the previous version, or the genesis record for
  version 1; ``n`` runs 1, 2, 3, ... along the chain.
* ``coauthor.consent`` -- signed by the consenting author;
  ``body.version`` is the version record id and ``body.decision`` is
  ``accept`` or ``decline``.
* ``retraction`` / ``correction`` -- ``body.target`` is the genesis id or
  a version record id.
* ``moderation.decision`` with ``body.action == "tombstone"`` --
  ``body.target`` is the genesis id, a version record id or the cid of a
  file in a manifest.

Checks
------

The report always carries every check in :data:`CHECK_NAMES`; a check
that cannot run says so and fails.

``chain``
    The paper and its head version are identified, and ``prev`` links
    lead from the head to the genesis record through ``paper.version``
    records of this paper only, with ``n`` counting 1, 2, ... without gaps.
    Without ``head``, the records must contain exactly one newest version;
    a fork (two versions sharing a ``prev``) is reported as competing
    heads rather than guessed at.
``signatures``
    Every record the verdict rests on -- genesis, chain versions, their
    manifests and every ``coauthor.consent`` that names a chain version --
    has an ``id`` equal to the hash of its content and a signature that
    verifies against its ``author`` did:key.
``prev_hashes``
    Every ``prev`` link equals the hash of the content of the record it
    names, so no record in the chain was swapped or rewritten.
``consents``
    For each chain version, every listed author -- the submitting author
    included -- has an authentic ``accept`` consent and none has declined.
    A single decline fails the version, whatever else was signed.
``manifests``
    Each chain version names a ``manifest`` record that is present and
    whose body is a valid manifest.
``supersession``
    Every ``retraction``, ``correction`` and tombstone that names the
    paper authenticates; see below.

Supersession
------------

A notice is *authorized* when it is signed by an author of the paper (the
genesis author, a chain version's author or a listed author) or by one of
the ``authorities`` the caller trusts (the integrity committee, security
council, moderators).  Tombstones are authorized by authorities only;
anyone else's tombstone is advisory and reported but never applied.
Authentic but unauthorized notices are reported with ``applied=False``
and do not fail the check.  A notice that names the paper yet fails
authentication fails the ``supersession`` check -- a verifier must not
treat a damaged retraction as absent.

Authorized retractions and corrections apply to the paper as a whole (the
banner shows on every version).  An authorized tombstone applies when it
targets the paper, the verified version or a file in its manifest; one
that targets only an earlier version is reported but does not change the
verified version's status.

``status`` is ``invalid`` when any check fails.  Otherwise the applied
notices decide it, most severe first: ``retracted``, ``tombstoned``,
``corrected``, else ``verified``.  The history of a retracted or
tombstoned paper still verifies; its notices are never a verification
failure.

Everything a record can get wrong -- tampering, missing records, forks,
forged notices -- is a failed check, never an exception.  Only invalid
*arguments* (a non-mapping record, a malformed ``paper``/``head``) raise
:class:`ValueError`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from .envelope import compute_record_id
from .manifest import MANIFEST_TYPE, validate_manifest_body
from .short_id import derive_short_id, parse_short_id, parse_version_id
from .signing import is_ed25519_did_key, verify_envelope

#: Record types the verifier reads.
GENESIS_TYPE = "paper.genesis"
VERSION_TYPE = "paper.version"
CONSENT_TYPE = "coauthor.consent"
RETRACTION_TYPE = "retraction"
CORRECTION_TYPE = "correction"
MODERATION_TYPE = "moderation.decision"

#: ``moderation.decision`` action that removes content.
TOMBSTONE_ACTION = "tombstone"

#: ``coauthor.consent`` decisions.
CONSENT_ACCEPT = "accept"
CONSENT_DECLINE = "decline"

#: Report ``status`` values.
STATUS_VERIFIED = "verified"
STATUS_CORRECTED = "corrected"
STATUS_RETRACTED = "retracted"
STATUS_TOMBSTONED = "tombstoned"
STATUS_INVALID = "invalid"
STATUSES: tuple[str, ...] = (
    STATUS_VERIFIED,
    STATUS_CORRECTED,
    STATUS_RETRACTED,
    STATUS_TOMBSTONED,
    STATUS_INVALID,
)

#: Supersession notice kinds.
KIND_RETRACTION = "retraction"
KIND_CORRECTION = "correction"
KIND_TOMBSTONE = "tombstone"

#: The checks every report carries, in report order.
CHECK_NAMES: tuple[str, ...] = (
    "chain",
    "signatures",
    "prev_hashes",
    "consents",
    "manifests",
    "supersession",
)


@dataclass(frozen=True)
class CheckResult:
    """Outcome of one verification check."""

    name: str
    passed: bool
    message: str
    """One plain-language line for a checklist."""
    details: tuple[str, ...] = ()
    """Every individual failure (or, for ``supersession``, finding)."""

    def __bool__(self) -> bool:
        return self.passed

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "message": self.message,
            "details": list(self.details),
        }


@dataclass(frozen=True)
class Supersession:
    """One retraction, correction or tombstone that names the paper."""

    kind: str
    """``retraction``, ``correction`` or ``tombstone``."""
    id: str | None
    author: str | None
    target: str
    scope: str
    """``paper``, ``version`` or ``file``: what ``target`` names."""
    applied: bool
    """True when it is authentic, authorized and affects the verified version."""
    reason: str | None = None
    """Why it was not applied; ``None`` when it was."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "id": self.id,
            "author": self.author,
            "target": self.target,
            "scope": self.scope,
            "applied": self.applied,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class VerificationReport:
    """The result of :func:`verify_paper`."""

    status: str
    """One of :data:`STATUSES`."""
    short_id: str | None
    """``sch:xxxx-xxxx-xxxx`` of the paper, when it could be identified."""
    genesis: str | None
    """Record id of the paper's genesis record."""
    head: str | None
    """Record id of the version that was verified."""
    version_count: int
    """Versions followed from the head back to the genesis (0 if none)."""
    signers: tuple[str, ...]
    """Distinct did:keys with an authentic signed record in the chain.

    Ordered by first appearance from the genesis to the head: the genesis
    author, then for each version its author, its manifest's author and
    the listed authors that accepted.  Notice signers are not included.
    """
    authors: tuple[str, ...]
    """The head version's listed authors."""
    checks: dict[str, CheckResult]
    """Per-check results keyed by :data:`CHECK_NAMES`."""
    supersessions: tuple[Supersession, ...] = ()
    """Every retraction, correction and tombstone that names the paper."""

    @property
    def valid(self) -> bool:
        """True when every check passed (``status`` is not ``invalid``)."""
        return self.status != STATUS_INVALID

    def to_dict(self) -> dict[str, Any]:
        """A JSON-serializable rendering of the report."""
        return {
            "status": self.status,
            "valid": self.valid,
            "short_id": self.short_id,
            "genesis": self.genesis,
            "head": self.head,
            "version_count": self.version_count,
            "signers": list(self.signers),
            "authors": list(self.authors),
            "checks": {name: check.to_dict() for name, check in self.checks.items()},
            "supersessions": [item.to_dict() for item in self.supersessions],
        }


# --- helpers ------------------------------------------------------------


def _body(record: Mapping[str, Any]) -> Mapping[str, Any]:
    body = record.get("body")
    return body if isinstance(body, Mapping) else {}


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _version_number(record: Mapping[str, Any]) -> int | None:
    n = _body(record).get("n")
    return n if isinstance(n, int) and not isinstance(n, bool) and n >= 1 else None


def _label(record: Mapping[str, Any]) -> str:
    return f"{record.get('type')} {record.get('id')}"


def _short_of(record_id: str) -> str | None:
    try:
        return derive_short_id(record_id)
    except ValueError:
        return None


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


class _Index:
    """The input records, indexed by claimed id, with cached authentication."""

    def __init__(self, records: Iterable[Mapping[str, Any]]) -> None:
        self.records: list[Mapping[str, Any]] = []
        self.by_id: dict[str, Mapping[str, Any]] = {}
        #: Ids claimed by two different records.
        self.conflicts: set[str] = set()
        self._problems: dict[int, str | None] = {}
        for position, record in enumerate(records):
            if not isinstance(record, Mapping):
                raise ValueError(
                    f"records[{position}] must be a mapping, "
                    f"got {type(record).__name__}"
                )
            record_id = _text(record.get("id"))
            if record_id is not None:
                known = self.by_id.get(record_id)
                if known is None:
                    self.by_id[record_id] = record
                elif dict(known) == dict(record):
                    continue  # an exact duplicate adds nothing
                else:
                    self.conflicts.add(record_id)
            self.records.append(record)

    def recomputed_id(self, record: Mapping[str, Any]) -> str | None:
        try:
            return compute_record_id(record)
        except (ValueError, KeyError, TypeError):
            return None

    def problem(self, record: Mapping[str, Any]) -> str | None:
        """Why ``record`` is not authentic, or ``None`` when it is."""
        key = id(record)
        if key not in self._problems:
            self._problems[key] = self._authenticate(record)
        return self._problems[key]

    def _authenticate(self, record: Mapping[str, Any]) -> str | None:
        recomputed = self.recomputed_id(record)
        if recomputed is None:
            return "is not a well-formed record"
        if record.get("id") != recomputed:
            return "id does not match the hash of its content"
        signature = record.get("sig")
        if not isinstance(signature, (str, bytes, bytearray)):
            return "has no signature"
        if not verify_envelope(record, signature):
            return "signature does not verify against its author"
        return None

    def of_type(self, record_type: str) -> list[Mapping[str, Any]]:
        return [r for r in self.records if r.get("type") == record_type]


class _Locator(NamedTuple):
    """A parsed ``paper=`` or ``head=`` argument."""

    record_id: str | None
    short_id: str | None
    version: int | None


def _parse_record_id(value: str, what: str) -> str:
    try:
        derive_short_id(value)  # validates: a dag-cbor sha2-256 CIDv1
    except ValueError as exc:
        raise ValueError(
            f"{what} must be a 'sch:' id or a record id: {exc}"
        ) from exc
    return value


def _is_sch(value: str) -> bool:
    return value[:4].lower() == "sch:"


def _parse_paper(value: object) -> _Locator | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"paper must be a string, got {type(value).__name__}")
    if _is_sch(value):
        return _Locator(None, parse_short_id(value), None)
    record_id = _parse_record_id(value, "paper")
    return _Locator(record_id, derive_short_id(record_id), None)


def _parse_head(value: object) -> _Locator | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"head must be a string, got {type(value).__name__}")
    if _is_sch(value):
        version_id = parse_version_id(value)
        return _Locator(None, version_id.short_id, version_id.version)
    return _Locator(_parse_record_id(value, "head"), None, None)


def _coerce_authorities(authorities: object) -> frozenset[str]:
    if isinstance(authorities, (str, bytes)) or not isinstance(authorities, Iterable):
        raise ValueError(
            "authorities must be a collection of did:key strings, "
            f"got {type(authorities).__name__}"
        )
    trusted = frozenset(authorities)
    for did in trusted:
        if not isinstance(did, str):
            raise ValueError(
                f"authorities must be did:key strings, got {type(did).__name__}"
            )
    return trusted


# --- the chain ----------------------------------------------------------


@dataclass
class _Chain:
    """The paper and version chain the records resolve to."""

    paper_id: str | None = None
    genesis: Mapping[str, Any] | None = None
    head_id: str | None = None
    versions: list[Mapping[str, Any]] = field(default_factory=list)
    """Chain versions, oldest first."""
    candidates: list[Mapping[str, Any]] = field(default_factory=list)
    """Every ``paper.version`` record that claims this paper."""
    problems: list[str] = field(default_factory=list)


def _paper_candidates(index: _Index) -> list[str]:
    """Genesis ids the records describe or refer to, sorted."""
    ids: set[str] = set()
    for record in index.records:
        if record.get("type") == GENESIS_TYPE:
            record_id = _text(record.get("id"))
        elif record.get("type") == VERSION_TYPE:
            record_id = _text(_body(record).get("paper"))
        else:
            continue
        if record_id is not None:
            ids.add(record_id)
    return sorted(ids)


def _identify_paper(
    index: _Index, paper: _Locator | None, head: _Locator | None, chain: _Chain
) -> str | None:
    """Return the genesis record id the verification is about."""
    problems = chain.problems
    if paper is not None and paper.record_id is not None:
        return paper.record_id

    short = (paper.short_id if paper is not None else None) or (
        head.short_id if head is not None else None
    )
    if short is not None:
        matches = [p for p in _paper_candidates(index) if _short_of(p) == short]
        if len(matches) == 1:
            return matches[0]
        if matches:
            problems.append(
                f"{len(matches)} papers share the id {short}; "
                "pass the genesis record id as paper="
            )
        else:
            problems.append(f"no record belongs to the paper {short}")
        return None

    if head is not None and head.record_id is not None:
        record = index.by_id.get(head.record_id)
        if record is None:
            problems.append(f"head {head.record_id} is not among the records")
            return None
        paper_id = _text(_body(record).get("paper"))
        if record.get("type") != VERSION_TYPE or paper_id is None:
            problems.append(f"head {head.record_id} is not a paper.version record")
            return None
        return paper_id

    candidates = _paper_candidates(index)
    if len(candidates) == 1:
        return candidates[0]
    if candidates:
        problems.append(
            f"the records describe {len(candidates)} papers; "
            "name one with paper="
        )
    else:
        problems.append("the records contain no paper.genesis or paper.version")
    return None


def _identify_head(
    index: _Index, head: _Locator | None, chain: _Chain
) -> str | None:
    """Return the record id of the version to verify."""
    problems = chain.problems
    paper_id = chain.paper_id
    assert paper_id is not None

    if head is not None and head.record_id is not None:
        return head.record_id

    if head is not None:  # a sch:xxxx-xxxx-xxxx/vN version id
        if head.short_id != _short_of(paper_id):
            problems.append(f"head names paper {head.short_id}, not this paper")
            return None
        matches = [r for r in chain.candidates if _version_number(r) == head.version]
        if len(matches) == 1:
            return _text(matches[0].get("id"))
        if matches:
            problems.append(
                f"{len(matches)} records claim version {head.version}; "
                "name one by record id with head="
            )
        else:
            problems.append(f"the records contain no version {head.version}")
        return None

    if not chain.candidates:
        problems.append("the records contain no paper.version for this paper")
        return None
    ids = [_text(r.get("id")) for r in chain.candidates]
    if None in ids:
        problems.append("a paper.version record has no id")
    referenced = {r.get("prev") for r in chain.candidates}
    tips = sorted({i for i in ids if i is not None and i not in referenced})
    if len(tips) == 1:
        return tips[0]
    if tips:
        # A version whose predecessor is absent is a tip too, so a gap in the
        # chain looks like a fork.  Name the gap first: it is the likelier cause.
        for record in chain.candidates:
            previous = _text(record.get("prev"))
            if previous is not None and previous != paper_id and previous not in index.by_id:
                problems.append(
                    f"version {record.get('id')} names prev {previous}, "
                    "which is not among the records"
                )
        problems.append(
            f"competing heads ({len(tips)} versions are not followed by any "
            f"other): {', '.join(tips)}; name the one to verify with head="
        )
    else:
        problems.append("the prev links of the paper's versions form a cycle")
    return None


def _walk(index: _Index, chain: _Chain, head_id: str) -> None:
    """Follow ``prev`` from ``head_id`` to the genesis; fill ``chain.versions``."""
    problems = chain.problems
    paper_id = chain.paper_id
    newest_first: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    reached_genesis = False
    child: str | None = None
    current: str = head_id
    while True:
        if current == paper_id:
            reached_genesis = child is not None
            if not reached_genesis:
                problems.append(f"head {head_id} is the genesis record, not a version")
            break
        record = index.by_id.get(current)
        if record is None:
            problems.append(
                f"head {current} is not among the records"
                if child is None
                else f"version {child} names prev {current}, "
                "which is not among the records"
            )
            break
        if current in seen:
            problems.append(f"the prev links loop back to {current}")
            break
        seen.add(current)
        if record.get("type") != VERSION_TYPE:
            problems.append(
                f"{current} is a {record.get('type')!r} record, not a paper.version"
            )
            break
        newest_first.append(record)
        previous = _text(record.get("prev"))
        if previous is None:
            problems.append(f"version {current} has no prev link")
            break
        child, current = current, previous

    chain.versions = newest_first[::-1]
    first_n: int | None = None
    for position, record in enumerate(chain.versions):
        where = f"version {record.get('id')}"
        if _body(record).get("paper") != paper_id:
            problems.append(f"{where} belongs to a different paper")
        n = _version_number(record)
        if n is None:
            problems.append(f"{where} has no valid version number n")
            continue
        if position == 0:
            first_n = n
        expected = (1 if reached_genesis else first_n or n) + position
        if n != expected:
            problems.append(f"{where} has n={n}, expected {expected}")


def _resolve_chain(
    index: _Index, paper: _Locator | None, head: _Locator | None
) -> _Chain:
    chain = _Chain()
    chain.paper_id = _identify_paper(index, paper, head, chain)
    paper_id = chain.paper_id
    if paper_id is None:
        return chain

    genesis = index.by_id.get(paper_id)
    if genesis is None:
        chain.problems.append(
            f"the paper.genesis record {paper_id} is not among the records"
        )
    elif genesis.get("type") != GENESIS_TYPE:
        chain.problems.append(
            f"record {paper_id} is a {genesis.get('type')!r} record, "
            "not a paper.genesis"
        )
    else:
        chain.genesis = genesis
        if genesis.get("prev") is not None:
            chain.problems.append("the paper.genesis record must have prev null")

    chain.candidates = sorted(
        (
            r
            for r in index.records
            if r.get("type") == VERSION_TYPE and _body(r).get("paper") == paper_id
        ),
        key=lambda r: str(r.get("id")),
    )
    chain.head_id = _identify_head(index, head, chain)
    if chain.head_id is not None:
        _walk(index, chain, chain.head_id)
    return chain


# --- per-check state ----------------------------------------------------


def _listed_authors(version: Mapping[str, Any]) -> tuple[tuple[str, ...], str | None]:
    """Return a version's listed author DIDs, or why they cannot be read."""
    authors = _body(version).get("authors")
    if isinstance(authors, (str, bytes)) or not isinstance(authors, (list, tuple)):
        return (), "body.authors must be a list"
    if not authors:
        return (), "body.authors must list at least one author"
    dids: list[str] = []
    for position, entry in enumerate(authors):
        did = entry.get("did") if isinstance(entry, Mapping) else None
        if not isinstance(did, str) or not is_ed25519_did_key(did):
            return (), f"body.authors[{position}].did is not an Ed25519 did:key"
        if did not in dids:
            dids.append(did)
    return tuple(dids), None


@dataclass
class _VersionConsents:
    version: Mapping[str, Any]
    listed: tuple[str, ...]
    problem: str | None
    accepted: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    declined: list[str] = field(default_factory=list)

    def missing(self) -> list[str]:
        return [
            did
            for did in self.listed
            if did not in self.accepted and did not in self.declined
        ]


@dataclass
class _Context:
    index: _Index
    chain: _Chain
    authorities: frozenset[str]
    #: Consent records by the version record id they name, sorted by id.
    consents: dict[str, list[Mapping[str, Any]]] = field(default_factory=dict)
    version_consents: list[_VersionConsents] = field(default_factory=list)
    #: Manifest record per chain version id (when present).
    manifests: dict[str, Mapping[str, Any]] = field(default_factory=dict)
    manifest_problems: list[str] = field(default_factory=list)
    #: File cids of each chain version's manifest, by version id.
    files: dict[str, frozenset[str]] = field(default_factory=dict)


def _gather_consents(index: _Index) -> dict[str, list[Mapping[str, Any]]]:
    by_version: dict[str, list[Mapping[str, Any]]] = {}
    for record in index.of_type(CONSENT_TYPE):
        version_id = _text(_body(record).get("version"))
        if version_id is not None:
            by_version.setdefault(version_id, []).append(record)
    for records in by_version.values():
        records.sort(key=lambda r: str(r.get("id")))
    return by_version


def _evaluate_consents(ctx: _Context) -> None:
    for version in ctx.chain.versions:
        listed, problem = _listed_authors(version)
        state = _VersionConsents(version, listed, problem)
        for consent in ctx.consents.get(str(version.get("id")), []):
            if ctx.index.problem(consent) is not None:
                continue  # reported by the signatures check, never counted
            did = consent.get("author")
            if did not in listed:
                continue
            decision = _body(consent).get("decision")
            if decision == CONSENT_ACCEPT:
                state.accepted.setdefault(did, consent)
            elif decision == CONSENT_DECLINE and did not in state.declined:
                state.declined.append(did)
        ctx.version_consents.append(state)


def _evaluate_manifests(ctx: _Context) -> None:
    for version in ctx.chain.versions:
        version_id = str(version.get("id"))
        where = f"version {version_id}"
        reference = _text(_body(version).get("manifest"))
        if reference is None:
            ctx.manifest_problems.append(f"{where} names no manifest")
            continue
        manifest = ctx.index.by_id.get(reference)
        if manifest is None:
            ctx.manifest_problems.append(
                f"{where}: manifest {reference} is not among the records"
            )
        elif manifest.get("type") != MANIFEST_TYPE:
            ctx.manifest_problems.append(
                f"{where}: {reference} is a {manifest.get('type')!r} record, "
                "not a manifest"
            )
        else:
            ctx.manifests[version_id] = manifest
            try:
                files = validate_manifest_body(manifest.get("body"))["files"]
            except ValueError as exc:
                ctx.manifest_problems.append(
                    f"{where}: manifest {reference} is invalid: {exc}"
                )
            else:
                ctx.files[version_id] = frozenset(entry["cid"] for entry in files)


# --- the checks ---------------------------------------------------------


def _unchecked(name: str, chain: _Chain) -> CheckResult:
    reason = chain.problems[0] if chain.problems else "no version chain was found"
    return CheckResult(name, False, f"Not checked: {reason}", tuple(chain.problems))


def _check_chain(ctx: _Context) -> CheckResult:
    chain = ctx.chain
    if chain.problems:
        return CheckResult(
            "chain",
            False,
            f"The version history is broken: {chain.problems[0]}",
            tuple(chain.problems),
        )
    count = len(chain.versions)
    span = "v1" if count == 1 else f"v1 → v{count}"
    return CheckResult(
        "chain", True, f"Version history is intact ({span}) back to the genesis record"
    )


def _relevant_records(ctx: _Context) -> list[Mapping[str, Any]]:
    """Records the verdict rests on, each once, in a stable order."""
    chain = ctx.chain
    ordered: list[Mapping[str, Any]] = []
    if chain.genesis is not None:
        ordered.append(chain.genesis)
    for version in chain.versions:
        ordered.append(version)
        manifest = ctx.manifests.get(str(version.get("id")))
        if manifest is not None:
            ordered.append(manifest)
        ordered.extend(ctx.consents.get(str(version.get("id")), []))
    unique: dict[int, Mapping[str, Any]] = {}
    for record in ordered:
        unique.setdefault(id(record), record)
    return list(unique.values())


def _check_signatures(ctx: _Context) -> CheckResult:
    records = _relevant_records(ctx)
    if not records:
        return _unchecked("signatures", ctx.chain)
    details = []
    for record in records:
        problem = ctx.index.problem(record)
        if problem is not None:
            details.append(f"{_label(record)}: {problem}")
    claimed = {r["id"] for r in records if isinstance(r.get("id"), str)}
    for conflict in sorted(ctx.index.conflicts & claimed):
        details.append(f"two different records claim the id {conflict}")
    if details:
        return CheckResult(
            "signatures",
            False,
            f"{_plural(len(details), 'record')} failed authentication: {details[0]}",
            tuple(details),
        )
    return CheckResult(
        "signatures",
        True,
        f"All {len(records)} records carry a valid signature from their author",
    )


def _check_prev_hashes(ctx: _Context) -> CheckResult:
    chain = ctx.chain
    if not chain.versions:
        return _unchecked("prev_hashes", chain)
    details = []
    for position, version in enumerate(chain.versions):
        where = f"version {version.get('id')}"
        named = version.get("prev")
        if named is None:
            details.append(f"{where} has no prev link")
            continue
        if position:
            previous: Mapping[str, Any] | None = chain.versions[position - 1]
        else:  # the oldest version found links to the genesis, or to a gap
            previous = chain.genesis if named == chain.paper_id else None
        if previous is None:
            details.append(
                f"{where} names prev {named}, which is not among the records, "
                "so the link cannot be checked"
            )
            continue
        actual = ctx.index.recomputed_id(previous)
        if actual != named:
            details.append(
                f"{where} names prev {named}, but the record before it "
                + (f"hashes to {actual}" if actual else "cannot be hashed")
            )
    if details:
        return CheckResult(
            "prev_hashes",
            False,
            f"A prev link does not match its record: {details[0]}",
            tuple(details),
        )
    return CheckResult(
        "prev_hashes",
        True,
        f"All {_plural(len(chain.versions), 'prev link')} match the hash of the "
        "record they name",
    )


def _check_consents(ctx: _Context) -> CheckResult:
    if not ctx.version_consents:
        return _unchecked("consents", ctx.chain)
    details = []
    for state in ctx.version_consents:
        where = f"version {state.version.get('id')}"
        if state.problem is not None:
            details.append(f"{where}: {state.problem}")
            continue
        details.extend(f"{where}: declined by {did}" for did in state.declined)
        details.extend(f"{where}: no consent from {did}" for did in state.missing())
    if details:
        return CheckResult(
            "consents",
            False,
            f"Not every listed author consented: {details[0]}",
            tuple(details),
        )
    head = ctx.version_consents[-1]
    return CheckResult(
        "consents",
        True,
        f"Signed by all {len(head.listed)} listed authors "
        f"(every version has a consent from each of its authors)",
    )


def _check_manifests(ctx: _Context) -> CheckResult:
    chain = ctx.chain
    if not chain.versions:
        return _unchecked("manifests", chain)
    if ctx.manifest_problems:
        return CheckResult(
            "manifests",
            False,
            f"A manifest is missing or invalid: {ctx.manifest_problems[0]}",
            tuple(ctx.manifest_problems),
        )
    head_files = ctx.files.get(str(chain.versions[-1].get("id")), frozenset())
    return CheckResult(
        "manifests",
        True,
        f"Every version lists a valid manifest ({_plural(len(head_files), 'file')} "
        "in the verified version)",
    )


def _paper_authors(ctx: _Context) -> frozenset[str]:
    """DIDs that count as authors of the paper for authorizing notices."""
    authors: set[str] = set()
    chain = ctx.chain
    records = ([chain.genesis] if chain.genesis is not None else []) + chain.versions
    for record in records:
        author = _text(record.get("author"))
        if author is not None:
            authors.add(author)
    for state in ctx.version_consents:
        authors.update(state.listed)
    return frozenset(authors)


def _notice(record: Mapping[str, Any]) -> tuple[str, str] | None:
    """Return ``(kind, target)`` when ``record`` is a supersession notice."""
    body = _body(record)
    target = _text(body.get("target"))
    if target is None:
        return None
    kind = record.get("type")
    if kind == RETRACTION_TYPE:
        return KIND_RETRACTION, target
    if kind == CORRECTION_TYPE:
        return KIND_CORRECTION, target
    if kind == MODERATION_TYPE and body.get("action") == TOMBSTONE_ACTION:
        return KIND_TOMBSTONE, target
    return None


def _evaluate_supersession(ctx: _Context) -> tuple[CheckResult, tuple[Supersession, ...]]:
    chain = ctx.chain
    paper_id = chain.paper_id
    if paper_id is None or not chain.versions:
        return _unchecked("supersession", chain), ()

    version_ids = {
        record_id
        for record in (*chain.candidates, *chain.versions)
        if (record_id := _text(record.get("id"))) is not None
    }
    all_files = frozenset().union(*ctx.files.values()) if ctx.files else frozenset()
    head_id = str(chain.versions[-1].get("id"))
    head_files = ctx.files.get(head_id, frozenset())
    authors = _paper_authors(ctx)

    found: list[Supersession] = []
    failures: list[str] = []
    for record in ctx.index.records:
        notice = _notice(record)
        if notice is None:
            continue
        kind, target = notice
        if target == paper_id:
            scope = "paper"
        elif target in version_ids:
            scope = "version"
        elif target in all_files:
            scope = "file"
        else:
            continue  # names some other paper's record or file

        record_id = _text(record.get("id"))
        signer = _text(record.get("author"))
        problem = ctx.index.problem(record)
        applied = False
        reason: str | None
        if problem is not None:
            reason = f"not authentic: {problem}"
            failures.append(f"{_label(record)}: {problem}")
        elif kind == KIND_TOMBSTONE and signer not in ctx.authorities:
            reason = "advisory: a tombstone applies only when a trusted authority signs it"
        elif kind != KIND_TOMBSTONE and signer not in authors | ctx.authorities:
            reason = "signer is neither an author of the paper nor a trusted authority"
        elif kind == KIND_TOMBSTONE and not (
            scope == "paper" or target == head_id or target in head_files
        ):
            reason = "targets an earlier version, not the verified version"
        else:
            applied, reason = True, None
        found.append(Supersession(kind, record_id, signer, target, scope, applied, reason))

    found.sort(key=lambda s: (s.kind, s.id or ""))
    if failures:
        return (
            CheckResult(
                "supersession",
                False,
                f"{_plural(len(failures), 'notice')} failed authentication: "
                f"{failures[0]}",
                tuple(failures),
            ),
            tuple(found),
        )
    applied_kinds = [s.kind for s in found if s.applied]
    if not applied_kinds:
        message = "No retraction, correction or tombstone applies"
    else:
        counts = [
            _plural(applied_kinds.count(kind), kind)
            for kind in (KIND_RETRACTION, KIND_CORRECTION, KIND_TOMBSTONE)
            if kind in applied_kinds
        ]
        message = f"On record: {', '.join(counts)}"
    details = tuple(
        f"{s.kind} {s.id}: " + ("applied" if s.applied else str(s.reason))
        for s in found
    )
    return CheckResult("supersession", True, message, details), tuple(found)


def _collect_signers(ctx: _Context) -> tuple[str, ...]:
    if not ctx.chain.versions:
        return ()  # no chain was verified, so nobody signed a verified paper
    signers: dict[str, None] = {}

    def add(record: Mapping[str, Any] | None) -> None:
        if record is None or ctx.index.problem(record) is not None:
            return
        author = _text(record.get("author"))
        if author is not None:
            signers.setdefault(author)

    add(ctx.chain.genesis)
    for state in ctx.version_consents:
        add(state.version)
        add(ctx.manifests.get(str(state.version.get("id"))))
        for did in state.listed:
            add(state.accepted.get(did))
    return tuple(signers)


def _status(checks: dict[str, CheckResult], found: tuple[Supersession, ...]) -> str:
    if not all(checks.values()):
        return STATUS_INVALID
    applied = {s.kind for s in found if s.applied}
    if KIND_RETRACTION in applied:
        return STATUS_RETRACTED
    if KIND_TOMBSTONE in applied:
        return STATUS_TOMBSTONED
    if KIND_CORRECTION in applied:
        return STATUS_CORRECTED
    return STATUS_VERIFIED


# --- entry point --------------------------------------------------------


def verify_paper(
    records: Iterable[Mapping[str, Any]],
    *,
    paper: str | None = None,
    head: str | None = None,
    authorities: Iterable[str] = (),
) -> VerificationReport:
    """Verify a paper from a set of signed records.

    Follows ``prev`` links from the newest version to the genesis record,
    checks every signature, every prev hash and that every listed author
    of every version consented, then applies retraction, correction and
    tombstone supersession.  See the module docstring for the record
    shapes, the checks and the supersession rules.

    Args:
        records: signed records in any order.  Records of other papers and
            of types the verifier does not read are ignored.
        paper: the paper to verify, as a ``sch:xxxx-xxxx-xxxx`` id or the
            genesis record id.  Optional when the records describe one
            paper.
        head: the version to verify, as a version record id or a
            ``sch:xxxx-xxxx-xxxx/vN`` id.  Defaults to the newest version;
            required to choose between competing heads.
        authorities: did:keys the caller trusts to retract, correct or
            tombstone any paper (integrity committee, security council,
            moderators).  Authors may retract and correct their own paper
            without being listed here; only authorities can tombstone.

    Returns:
        A :class:`VerificationReport`.  Bad *data* never raises; it fails
        a check and makes the status ``invalid``.

    Raises:
        ValueError: if a record is not a mapping, or ``paper``, ``head``
            or ``authorities`` is malformed or inconsistent.
    """
    trusted = _coerce_authorities(authorities)
    index = _Index(records)
    paper_locator = _parse_paper(paper)
    head_locator = _parse_head(head)
    if (
        paper_locator is not None
        and head_locator is not None
        and paper_locator.short_id is not None
        and head_locator.short_id is not None
        and paper_locator.short_id != head_locator.short_id
    ):
        raise ValueError(
            f"paper {paper_locator.short_id} and head {head_locator.short_id} "
            "name different papers"
        )

    chain = _resolve_chain(index, paper_locator, head_locator)
    ctx = _Context(index, chain, trusted, consents=_gather_consents(index))

    checks: dict[str, CheckResult] = {}
    supersessions: tuple[Supersession, ...] = ()
    if chain.paper_id is None or not chain.versions:
        # Without a version chain nothing else can be established.
        checks["chain"] = _check_chain(ctx)
        for name in CHECK_NAMES[1:]:
            checks[name] = _unchecked(name, chain)
    else:
        _evaluate_consents(ctx)
        _evaluate_manifests(ctx)
        checks["chain"] = _check_chain(ctx)
        checks["signatures"] = _check_signatures(ctx)
        checks["prev_hashes"] = _check_prev_hashes(ctx)
        checks["consents"] = _check_consents(ctx)
        checks["manifests"] = _check_manifests(ctx)
        checks["supersession"], supersessions = _evaluate_supersession(ctx)

    head_authors = ctx.version_consents[-1].listed if ctx.version_consents else ()
    return VerificationReport(
        status=_status(checks, supersessions),
        short_id=_short_of(chain.paper_id) if chain.paper_id else None,
        genesis=chain.paper_id,
        head=_text(chain.versions[-1].get("id")) if chain.versions else None,
        version_count=len(chain.versions),
        signers=_collect_signers(ctx),
        authors=head_authors,
        checks=checks,
        supersessions=supersessions,
    )
