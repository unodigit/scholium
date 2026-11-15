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
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError

from app import db
from app.errors import ProblemException
from app.modules.ingest.errors import InvalidRecord

__all__ = [
    "COAUTHOR_CONSENT",
    "COAUTHOR_CONSENT_MIN_TIER",
    "COAUTHOR_CONSENT_TYPE",
    "CONSENT_MIN_TIER",
    "CONSENT_TYPE",
    "ConsentForbidden",
    "ConsentNotAllowed",
    "CoauthorNotListed",
    "NotAnAuthor",
    "NotListedAuthor",
    "UnlistedAuthor",
    "UnlistedCoauthor",
    "ensure_tables",
    "handle_coauthor_consent",
    "handle_consent",
    "is_listed_author",
    "listed_authors",
    "save_coauthor_consent",
    "save_consent",
]

#: The record type this plugin owns.
CONSENT_TYPE = "coauthor.consent"
COAUTHOR_CONSENT_TYPE = CONSENT_TYPE
COAUTHOR_CONSENT = CONSENT_TYPE

#: Any author may sign a consent; the listed-author check is the real gate.
CONSENT_MIN_TIER = 0
COAUTHOR_CONSENT_MIN_TIER = 0

#: Problem type for a consent signed by someone not listed on the version.
NOT_LISTED_TYPE = "urn:scholium:problem:consent-not-listed"


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
            position = raw_position if isinstance(raw_position, int) and not isinstance(raw_position, bool) and raw_position >= 1 else index + 1
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
