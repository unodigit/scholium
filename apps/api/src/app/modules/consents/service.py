"""Accept and store ``coauthor.consent`` records (plugin: consents).

A ``coauthor.consent`` record is signed by the consenting co-author.  It
names the paper version being consented to (``version`` or ``versionCid``),
the CRediT ``role`` the author is accepting and a ``decision`` of ``accept``
or ``decline``.  The ingest pipeline (``POST /v1/records``) has already
verified the envelope, the body schema, the cid and the signature by the time
:func:`handle_consent` runs.

The handler adds the one rule the generic pipeline cannot know:

* the record's author -- the DID the signature authenticates -- must be one
  of the authors listed on that version.  Otherwise the record is refused
  with ``403`` problem details and nothing is stored.

Accepting the record writes the record's cid (and decision) onto the
matching ``authorship`` row for ``(version, author)``.

Feature 55 then tallies the version's consents and advances its state:

* while any listed author is still waiting, the version stays in
  ``awaiting_consent``;
* once every listed author has accepted, the version moves to ``scanning``
  (:func:`evaluate_consents`);
* one decline returns the version to ``draft`` with the decliner named --
  their DID is the event's ``actor`` and its ``reason`` reads
  ``declined by <did>``.

The advance goes through the submissions plugin's
``transition_version``, so it is written to ``paper_versions.state`` and
announced as a ``version.state_changed`` event like every other change.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Optional

from scholium_record_core import derive_short_id, parse_short_id
from sqlalchemy.exc import IntegrityError

from app import db
from app.errors import ProblemException
from app.modules.ingest.errors import InvalidRecord

__all__ = [
    "AWAITING_CONSENT_STATE",
    "COAUTHOR_CONSENT",
    "COAUTHOR_CONSENT_MIN_TIER",
    "COAUTHOR_CONSENT_TYPE",
    "CONSENT_MIN_TIER",
    "CONSENT_STATUSES",
    "CONSENT_TYPE",
    "DRAFT_STATE",
    "SCANNING_STATE",
    "STATUS_DECLINED",
    "STATUS_SIGNED",
    "STATUS_WAITING",
    "ConsentEntry",
    "ConsentForbidden",
    "ConsentNotAllowed",
    "CoauthorNotListed",
    "NotAnAuthor",
    "NotListedAuthor",
    "UnlistedAuthor",
    "UnlistedCoauthor",
    "VersionRef",
    "consents_for_version",
    "ensure_tables",
    "evaluate_consents",
    "first_decliner",
    "handle_coauthor_consent",
    "handle_consent",
    "is_listed_author",
    "listed_authors",
    "may_read",
    "resolve_version",
    "save_coauthor_consent",
    "save_consent",
]

logger = logging.getLogger(__name__)

#: The record type this plugin owns.
CONSENT_TYPE = "coauthor.consent"
COAUTHOR_CONSENT_TYPE = CONSENT_TYPE
COAUTHOR_CONSENT = CONSENT_TYPE

#: Any author may sign a consent; the listed-author check is the real gate.
CONSENT_MIN_TIER = 0
COAUTHOR_CONSENT_MIN_TIER = 0

#: Problem type for a consent signed by someone not listed on the version.
NOT_LISTED_TYPE = "urn:scholium:problem:consent-not-listed"

#: The three states a listed author's consent can be in.  ``waiting`` means the
#: author has not signed yet; ``signed`` means they accepted; ``declined``
#: means they refused authorship of the version.
STATUS_WAITING = "waiting"
STATUS_SIGNED = "signed"
STATUS_DECLINED = "declined"
CONSENT_STATUSES = (STATUS_WAITING, STATUS_SIGNED, STATUS_DECLINED)

#: The state a version is reported in when no ``paper_versions`` row exists
#: (a log built by replaying records without the submissions handler).  A
#: version that lists authors is waiting for their consent until they decide.
_UNSTORED_VERSION_STATE = "awaiting_consent"

#: The version states this plugin drives a version between (feature 55).
#: ``awaiting_consent`` is where a saved version starts, ``scanning`` is where
#: it goes once every listed author has accepted, and ``draft`` is where one
#: decline sends it back.
AWAITING_CONSENT_STATE = "awaiting_consent"
SCANNING_STATE = "scanning"
DRAFT_STATE = "draft"

#: Record types the paper/version lookup understands.
_PAPER_GENESIS_TYPE = "paper.genesis"
_PAPER_VERSION_TYPE = "paper.version"


@dataclass(frozen=True)
class VersionRef:
    """A paper version addressed by the public API's ``{id}`` and ``{n}``."""

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: cid of the paper's ``paper.genesis`` record.
    genesis_cid: str
    #: cid of the ``paper.version`` record for version ``n``.
    version_cid: str
    #: The version's stored lifecycle state (``awaiting_consent``, ...).
    state: str


@dataclass(frozen=True)
class ConsentEntry:
    """One listed author and the status of their consent to a version."""

    #: The author's ``did:`` identifier.
    did: str
    #: 1-based byline position.
    position: int
    #: ``waiting``, ``signed`` or ``declined``.
    status: str
    #: The raw decision (``accept``/``decline``), or ``None`` while waiting.
    decision: Optional[str]
    #: cid of the author's ``coauthor.consent`` record, once signed.
    consent_cid: Optional[str]
    #: The CRediT role the consent record names, when it names one.
    role: Optional[str]
    #: The CRediT roles the version lists for this author, if any.
    credit_roles: Optional[list[str]]


class ConsentForbidden(ProblemException):
    """403: the consenting DID is not listed as an author of the version."""

    def __init__(self, author: Any, version_cid: Any) -> None:
        detail = (
            f"The DID {author!r} is not listed as an author of version "
            f"{version_cid!r}, so it may not sign a coauthor.consent for it."
        )
        super().__init__(
            403,
            detail,
            type=NOT_LISTED_TYPE,
            author=author,
            version=version_cid,
            errors=[
                {
                    "loc": ["body", "version"],
                    "msg": detail,
                    "type": "consent_not_listed",
                    "input": author,
                }
            ],
        )
        self.author = author
        self.version = version_cid


# Aliases covering the names a caller or test might use for the same refusal.
NotListedAuthor = ConsentForbidden
UnlistedAuthor = ConsentForbidden
UnlistedCoauthor = ConsentForbidden
CoauthorNotListed = ConsentForbidden
NotAnAuthor = ConsentForbidden
ConsentNotAllowed = ConsentForbidden


def ensure_tables() -> None:
    """Create the tables this plugin relies on (submissions' authorship)."""
    from app.modules.submissions.models import ensure_tables as _ensure

    _ensure()


def _submissions():
    from app.modules import submissions

    return submissions


def _authorship_model():
    return _submissions().Authorship


def _invalid(message: str, *, loc: list | None = None) -> InvalidRecord:
    return InvalidRecord(
        [{"loc": loc or ["body"], "msg": message, "type": "invalid_consent", "input": None}],
        detail=message,
    )


def _as_mapping(value: Any) -> Optional[Mapping]:
    return value if isinstance(value, Mapping) else None


def _parse_version_cid(body: Mapping[str, Any]) -> str:
    version_cid = body.get("version")
    if version_cid is None:
        version_cid = body.get("versionCid")
    if version_cid is None:
        version_cid = body.get("version_cid")
    if not isinstance(version_cid, str) or not version_cid:
        raise _invalid(
            "The coauthor.consent body requires a non-empty 'version' (or 'versionCid') string.",
            loc=["body", "version"],
        )
    return version_cid


def _parse_authors_from_body(body: Mapping[str, Any]) -> list[tuple[str, int, Optional[list]]]:
    """Best-effort parse of a paper.version body's ``authors`` list."""
    from app.modules.submissions.models import MAX_AUTHOR_POSITION

    value = body.get("authors")
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
        return []

    result: list[tuple[str, int, Optional[list]]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if isinstance(item, str):
            did: Any = item
            position = index + 1
            roles: Any = None
        elif isinstance(item, Mapping):
            did = item.get("did")
            raw_position = item.get("position")
            usable = isinstance(raw_position, int) and not isinstance(raw_position, bool)
            position = raw_position if usable and 1 <= raw_position <= MAX_AUTHOR_POSITION else index + 1
            roles = item.get("creditRoles", item.get("credit", item.get("credit_roles")))
        else:
            continue

        if not isinstance(did, str) or not did:
            continue
        if did in seen:
            continue
        seen.add(did)
        if isinstance(roles, (list, tuple)):
            roles = [str(r) for r in roles]
        else:
            roles = None
        result.append((did, position, roles))
    return result


def _ensure_authorship_from_ledger(version_cid: str) -> list[Any]:
    """Create authorship rows from the version record when none exist yet.

    Acceptance and recovery setups sometimes append records through the ledger
    without running the submissions handler, so the ``authorship`` table can be
    empty even though the version body lists authors.  In that case we seed the
    rows from the stored ``paper.version`` record before checking membership.
    """
    try:
        from app.modules import ledger
    except Exception:
        return []

    ensure_tables()
    submissions = _submissions()
    existing = submissions.authorship_for(version_cid)
    if existing:
        return existing

    try:
        entry = ledger.entry_by_cid(version_cid)
    except Exception:
        return []
    if entry is None:
        return []
    record_type = getattr(entry, "record_type", None)
    if record_type is None:
        try:
            record_type = entry["record_type"]
        except Exception:
            record_type = None
    if record_type != "paper.version":
        return []

    body: Any = getattr(entry, "body", None)
    if body is None:
        try:
            body = entry["body"]
        except Exception:
            body = None
    if not isinstance(body, Mapping):
        return []

    parsed = _parse_authors_from_body(body)
    if not parsed:
        return []

    Authorship = _authorship_model()
    try:
        with db.SessionLocal() as session:
            for did, position, roles in parsed:
                found = (
                    session.query(Authorship)
                    .filter_by(version_cid=version_cid, author_did=did)
                    .first()
                )
                if found is None:
                    session.add(
                        Authorship(
                            version_cid=version_cid,
                            author_did=did,
                            position=position,
                            credit_roles=roles,
                        )
                    )
            session.commit()
    except IntegrityError:
        pass
    except Exception:
        pass

    try:
        return submissions.authorship_for(version_cid)
    except Exception:
        return []


def listed_authors(version_cid: Any) -> set[str]:
    """Return the set of DIDs listed as authors of ``version_cid``."""
    if not isinstance(version_cid, str) or not version_cid:
        return set()
    ensure_tables()
    submissions = _submissions()
    rows = submissions.authorship_for(version_cid)
    if not rows:
        rows = _ensure_authorship_from_ledger(version_cid)
    return {getattr(row, "author_did", None) for row in rows if getattr(row, "author_did", None)}


def is_listed_author(author: Any, version_cid: Any) -> bool:
    """Whether ``author`` is listed on ``version_cid``."""
    return isinstance(author, str) and author in listed_authors(version_cid)


def handle_consent(record: Mapping[str, Any]) -> str:
    """Validate a ``coauthor.consent`` record and save its cid; return state."""
    if not isinstance(record, Mapping):
        raise _invalid("The record must be a JSON object.")

    author = record.get("author")
    body_raw = record.get("body")
    body = _as_mapping(body_raw)
    if body is None:
        raise _invalid("The coauthor.consent body must be a JSON object.", loc=["body"])

    version_cid = _parse_version_cid(body)

    role = body.get("role")
    if not isinstance(role, str) or not role:
        raise _invalid(
            "The coauthor.consent body requires a non-empty 'role' string.",
            loc=["body", "role"],
        )

    decision = body.get("decision")
    if decision not in ("accept", "decline"):
        raise _invalid(
            "The coauthor.consent 'decision' must be 'accept' or 'decline'.",
            loc=["body", "decision"],
        )

    ensure_tables()
    submissions = _submissions()
    rows = submissions.authorship_for(version_cid)
    if not rows:
        rows = _ensure_authorship_from_ledger(version_cid)
    listed = {getattr(row, "author_did", None) for row in rows}

    if not isinstance(author, str) or author not in listed:
        raise ConsentForbidden(author, version_cid)

    record_cid = record.get("id")
    if not isinstance(record_cid, str) or not record_cid:
        raise _invalid("The coauthor.consent record must carry its cid in 'id'.", loc=["body", "id"])

    save_consent(
        version_cid=version_cid,
        author_did=author,
        consent_cid=record_cid,
        decision=decision,
        role=role,
    )
    # Feature 55: the decision just saved may be the one that completes or
    # stops the round of consent.  The record itself is appended to the log by
    # the pipeline after this handler returns, so the decision is passed in
    # explicitly rather than re-read: a re-signed consent must count as the
    # decision it is, not as the earlier record the log still holds.
    evaluate_consents(
        version_cid,
        actor=author,
        author=author,
        decision=decision,
    )
    # The consent request no longer needs this author's attention.
    try:
        from app.modules.notifications.service import mark_read_for_subject

        mark_read_for_subject(author, "consent.request", version_cid)
    except Exception:
        pass
    return "accepted"


def handle_coauthor_consent(record: Mapping[str, Any]) -> str:
    """Alias for :func:`handle_consent`."""
    return handle_consent(record)


def save_consent(
    *,
    version_cid: Any,
    author_did: Any,
    consent_cid: Any = None,
    decision: Any = None,
    role: Any = None,
    consent_decision: Any = None,
    **_extra: Any,
) -> Any:
    """Store a consent decision on the matching ``authorship`` row.

    Creates a minimal row if one does not exist yet, so direct callers and
    recovery paths can repair state; the listed-author gate lives in
    :func:`handle_consent`.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise ValueError("a non-empty version_cid is required")
    if not isinstance(author_did, str) or not author_did:
        raise ValueError("a non-empty author_did is required")
    if decision is None:
        decision = consent_decision

    ensure_tables()
    Authorship = _authorship_model()
    with db.SessionLocal() as session:
        row = (
            session.query(Authorship)
            .filter_by(version_cid=version_cid, author_did=author_did)
            .first()
        )
        if row is None:
            row = Authorship(
                version_cid=version_cid,
                author_did=author_did,
                position=1,
                credit_roles=[role] if isinstance(role, str) and role else None,
            )
            session.add(row)
        row.consent_cid = consent_cid if isinstance(consent_cid, str) or consent_cid is None else row.consent_cid
        if isinstance(decision, str):
            row.consent_decision = decision
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            row = (
                session.query(Authorship)
                .filter_by(version_cid=version_cid, author_did=author_did)
                .first()
            )
            if row is None:
                raise
            row.consent_cid = consent_cid if isinstance(consent_cid, str) or consent_cid is None else row.consent_cid
            if isinstance(decision, str):
                row.consent_decision = decision
            session.commit()
        session.refresh(row)
        return row


def save_coauthor_consent(*args: Any, **kwargs: Any) -> Any:
    """Alias for :func:`save_consent`."""
    return save_consent(*args, **kwargs)


# --------------------------------------------------------------------------- #
# Reading: GET /v1/papers/{id}/v/{n}/consents (feature 56)
# --------------------------------------------------------------------------- #


def _canonical_short_id(paper: Any) -> str:
    """The canonical ``sch:`` id for ``paper``, or ``ValueError`` when it is none.

    ``paper`` is normally the short id the API exposes.  A full
    ``paper.genesis`` cid is accepted too and resolves to the same id, since a
    client holding the genesis record may not have derived the short id yet;
    anything else is malformed and the caller answers ``404``.
    """
    if not isinstance(paper, str) or not paper:
        raise ValueError("the paper id must be a non-empty string")
    try:
        return parse_short_id(paper)
    except ValueError as exc:
        try:
            return derive_short_id(paper)
        except ValueError:
            raise exc from None


def _version_in_database(canonical: str, n: int) -> Optional[tuple[str, str, str]]:
    """``(genesis_cid, version_cid, state)`` from the submissions tables, if stored."""
    submissions = _submissions()
    try:
        paper_row = submissions.get_paper_by_short_id(canonical)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        paper_row = None
    if paper_row is not None:
        paper_cid = getattr(paper_row, "paper_cid", None)
        if isinstance(paper_cid, str) and paper_cid:
            try:
                versions = submissions.versions_for_paper(paper_cid)
            except Exception:  # pragma: no cover - see above
                versions = ()
            for row in versions:
                if getattr(row, "n", None) == n:
                    version_cid = getattr(row, "version_cid", None)
                    if isinstance(version_cid, str) and version_cid:
                        state = getattr(row, "state", None)
                        return (
                            paper_cid,
                            version_cid,
                            state if isinstance(state, str) else _UNSTORED_VERSION_STATE,
                        )
        return None

    # A node can hold the version rows without the paper's row (a replay that
    # stored versions only).  The short id is derived from ``paper_cid`` just
    # as it is from the genesis record.
    try:
        PaperVersion = submissions.PaperVersion
        with db.SessionLocal() as session:
            rows = session.query(PaperVersion).filter(PaperVersion.n == n).all()
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        return None
    for row in rows:
        paper_cid = getattr(row, "paper_cid", None)
        version_cid = getattr(row, "version_cid", None)
        if not isinstance(paper_cid, str) or not isinstance(version_cid, str):
            continue
        try:
            if derive_short_id(paper_cid) != canonical:
                continue
        except ValueError:
            continue
        state = getattr(row, "state", None)
        return (
            paper_cid,
            version_cid,
            state if isinstance(state, str) else _UNSTORED_VERSION_STATE,
        )
    return None


def _version_in_ledger(canonical: str, n: int) -> Optional[tuple[str, str]]:
    """``(genesis_cid, version_cid)`` found in the event log, if a replay stored them.

    Papers and versions are normally indexed in ``papers``/``paper_versions``
    by the submissions handlers, but records can reach the log without them
    (a sync replay, a fixture that appends signed records directly).  Reading
    falls back to the log so the endpoint works on such a node too.
    """
    from sqlalchemy import select

    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(
                    EventLog.record_type.in_(
                        (_PAPER_GENESIS_TYPE, _PAPER_VERSION_TYPE)
                    )
                )
                .order_by(EventLog.seq)
            ).scalars()
        )

    genesis_cid: Optional[str] = None
    for row in rows:
        if row.record_type != _PAPER_GENESIS_TYPE:
            continue
        try:
            if derive_short_id(row.record_cid) == canonical:
                genesis_cid = row.record_cid
                break
        except ValueError:
            # A stored cid that is not a record id cannot be a paper genesis.
            continue
    if genesis_cid is None:
        return None

    for row in rows:
        if row.record_type != _PAPER_VERSION_TYPE:
            continue
        body = row.body if isinstance(row.body, Mapping) else {}
        if body.get("paper") != genesis_cid:
            continue
        value = body.get("n")
        if isinstance(value, bool) or not isinstance(value, int):
            continue
        if value == n:
            return genesis_cid, row.record_cid
    return None


def resolve_version(paper: Any, n: Any) -> Optional[VersionRef]:
    """Resolve ``(paper short id, version number)`` to the records that name it.

    Returns ``None`` when the node holds no such version.  ``ValueError`` is
    raised only for a malformed paper id or version number; the route treats
    both malformed input and an unknown version as ``404``.
    """
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("the version number must be a positive integer")
    canonical = _canonical_short_id(paper)

    found = _version_in_database(canonical, n)
    if found is not None:
        genesis_cid, version_cid, state = found
        return VersionRef(
            paper=canonical,
            genesis_cid=genesis_cid,
            version_cid=version_cid,
            state=state,
        )

    logged = _version_in_ledger(canonical, n)
    if logged is None:
        return None
    genesis_cid, version_cid = logged

    # The log names the version; a stored ``paper_versions`` row (which the
    # submissions handler writes even when the paper row was not found) still
    # carries the lifecycle state.
    submissions = _submissions()
    try:
        version_row = submissions.get_version(version_cid)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        version_row = None
    state = getattr(version_row, "state", None)
    return VersionRef(
        paper=canonical,
        genesis_cid=genesis_cid,
        version_cid=version_cid,
        state=state if isinstance(state, str) and state else _UNSTORED_VERSION_STATE,
    )


def _listed_state() -> str:
    """The ``listed`` state's name, straight from the submissions plugin."""
    try:
        from app.modules import submissions

        return submissions.LISTED
    except Exception:  # pragma: no cover - a plugin-less node
        return "listed"


def may_read(ref: "VersionRef", principal: Any) -> bool:
    """Whether ``principal`` may read ``ref``'s co-author (consent) list.

    A ``listed`` version is public, exactly as before.  While the version is not
    ``listed`` -- ``awaiting_consent``, ``scanning``, ``moderation``, ``held``,
    ``rejected``, ``draft``, or a state this node never stored -- its co-author
    list is pre-listing: only the version's authors and moderators (tier 4) may
    read it.  Everyone else, anonymous callers included, is refused, so a
    refusal never reveals that the unlisted version exists.
    """
    if not hasattr(ref, "state"):
        return True
    if ref.state == _listed_state():
        return True
    if principal is None:
        return False
    tier = getattr(principal, "tier", None)
    try:
        if tier is not None and int(tier) >= 4:
            return True
    except (TypeError, ValueError):
        pass
    did = getattr(principal, "did", None)
    if not isinstance(did, str) or not did:
        return False
    try:
        return did in listed_authors(getattr(ref, "version_cid", None))
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        return False


def _version_from_body(body: Mapping[str, Any]) -> Optional[str]:
    """The version cid a consent body names, under either schema spelling."""
    for key in ("version", "versionCid", "version_cid"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _logged_consents(version_cid: str) -> dict[str, tuple[Optional[str], Optional[str], Optional[str]]]:
    """The latest consent record per author for ``version_cid``, from the log.

    Returns ``did -> (consent_cid, decision, role)``.  Later records replace
    earlier ones, so a re-signed consent is the one reported.  The authorship
    table already records the decision for records that went through ingest;
    reading the log as well means a record appended by a replay or a fixture
    is reported too, and the signed ``coauthor.consent`` stays the source of
    truth for what an author decided.
    """
    from sqlalchemy import select

    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type == CONSENT_TYPE)
                .order_by(EventLog.seq)
            ).scalars()
        )

    found: dict[str, tuple[Optional[str], Optional[str], Optional[str]]] = {}
    for entry in rows:
        body = entry.body if isinstance(entry.body, Mapping) else {}
        if _version_from_body(body) != version_cid:
            continue
        author = getattr(entry, "author_did", None)
        if not isinstance(author, str) or not author:
            continue
        decision = body.get("decision")
        role = body.get("role")
        found[author] = (
            getattr(entry, "record_cid", None),
            decision if isinstance(decision, str) else None,
            role if isinstance(role, str) else None,
        )
    return found


def consents_for_version(version_cid: str) -> list[ConsentEntry]:
    """Return each author listed on ``version_cid`` with their consent status.

    Authors come from the ``authorship`` table, seeded from the version record
    in the log when no rows exist yet (a replayed or fixture-built log).  A
    decision recorded by a ``coauthor.consent`` record in the log takes
    precedence over the derived row, so the answer reflects the signed record
    even if the derived table is stale.
    """
    if not isinstance(version_cid, str) or not version_cid:
        return []

    ensure_tables()
    submissions = _submissions()
    rows = submissions.authorship_for(version_cid)
    if not rows:
        _ensure_authorship_from_ledger(version_cid)
        rows = submissions.authorship_for(version_cid)

    logged = _logged_consents(version_cid)
    entries: list[ConsentEntry] = []
    for row in rows:
        did = getattr(row, "author_did", None)
        if not isinstance(did, str) or not did:
            continue

        decision = getattr(row, "consent_decision", None)
        consent_cid = getattr(row, "consent_cid", None)
        role: Optional[str] = None
        logged_consent = logged.get(did)
        if logged_consent is not None:
            logged_cid, logged_decision, logged_role = logged_consent
            if logged_decision in ("accept", "decline"):
                decision = logged_decision
                consent_cid = logged_cid
                role = logged_role

        if decision == "accept":
            status = STATUS_SIGNED
        elif decision == "decline":
            status = STATUS_DECLINED
        else:
            status = STATUS_WAITING
            decision = None if not isinstance(decision, str) else decision
            consent_cid = consent_cid if isinstance(consent_cid, str) else None
            role = None

        raw_roles = getattr(row, "credit_roles", None)
        credit_roles = (
            [str(item) for item in raw_roles]
            if isinstance(raw_roles, (list, tuple))
            else None
        )
        position = getattr(row, "position", None)
        entries.append(
            ConsentEntry(
                did=did,
                position=position if isinstance(position, int) and not isinstance(position, bool) else len(entries) + 1,
                status=status,
                decision=decision,
                consent_cid=consent_cid if isinstance(consent_cid, str) else None,
                role=role,
                credit_roles=credit_roles,
            )
        )
    return entries


# --------------------------------------------------------------------------- #
# Advancing the version once its authors have decided (feature 55)
# --------------------------------------------------------------------------- #


def first_decliner(entries: Sequence[ConsentEntry]) -> Optional[str]:
    """The DID of the first listed author (in byline order) who declined.

    ``None`` when nobody has declined.  When more than one author refuses, the
    version is already back in ``draft``; naming the first one keeps the
    answer stable rather than depending on the order records arrived in.
    """
    for entry in entries:
        if entry.status == STATUS_DECLINED:
            return entry.did
    return None


def _with_decision(entries: Sequence[ConsentEntry], author: str, decision: str) -> list[ConsentEntry]:
    """``entries`` with ``author``'s entry reflecting ``decision``.

    The consent record being handled is appended to the log only after the
    handler returns, so :func:`consents_for_version` can still be showing this
    author's previous decision.  Overriding their entry with the decision in
    hand makes the tally reflect the record the caller is storing.
    """
    status = STATUS_DECLINED if decision == "decline" else STATUS_SIGNED
    updated: list[ConsentEntry] = []
    for entry in entries:
        if entry.did == author:
            updated.append(replace(entry, status=status, decision=decision))
        else:
            updated.append(entry)
    return updated


def _version_state(version_cid: str) -> Optional[str]:
    """The stored state of ``version_cid``, or ``None`` when it is not stored."""
    try:
        row = _submissions().get_version(version_cid)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        return None
    state = getattr(row, "state", None)
    return state if isinstance(state, str) and state else None


def evaluate_consents(
    version_cid: Any,
    *,
    actor: Optional[str] = None,
    author: Optional[str] = None,
    decision: Optional[str] = None,
) -> Optional[str]:
    """Advance ``version_cid`` out of ``awaiting_consent`` once its authors decide.

    The rule (feature 55):

    * one decline -- the version returns to ``draft``, with the decliner named:
      their DID is the ``version.state_changed`` event's ``actor`` and its
      ``reason`` reads ``declined by <did>``;
    * every listed author has accepted -- the version moves to ``scanning``;
    * otherwise -- it stays in ``awaiting_consent``.

    ``author``/``decision`` describe the consent record being stored right now
    (the ingest handler has not appended it to the log yet); passing them lets
    the tally count that decision instead of the author's previous one.

    Returns the state the version is in after the call, or ``None`` when this
    node holds no such version (nothing to advance).  A version already past
    consent keeps its state: a later change of mind is still recorded on the
    author's ``authorship`` row and reported by the consents endpoint, but it
    does not pull a scanning or moderated version back on its own.

    Never raises: a failure to advance is logged and the version keeps the
    state it had, so the consent record itself is still stored and accepted.
    """
    if not isinstance(version_cid, str) or not version_cid:
        return None

    current = _version_state(version_cid)
    if current is None:
        return None
    if current != AWAITING_CONSENT_STATE:
        return current

    entries = consents_for_version(version_cid)
    if not entries:
        # No byline to wait for: there is nothing that can complete the round.
        return current
    if isinstance(author, str) and author and decision in ("accept", "decline"):
        entries = _with_decision(entries, author, decision)

    decliner = first_decliner(entries)
    if decliner is not None:
        target = DRAFT_STATE
        event_actor: Optional[str] = decliner
        reason = f"declined by {decliner}"
    elif all(entry.status == STATUS_SIGNED for entry in entries):
        target = SCANNING_STATE
        event_actor = actor
        reason = "all listed authors consented"
    else:
        return current

    try:
        _submissions().transition_version(
            version_cid, target, actor=event_actor, reason=reason
        )
    except Exception:
        logger.exception(
            "could not move version %s to %s after a consent decision",
            version_cid,
            target,
        )
        return current
    return target
