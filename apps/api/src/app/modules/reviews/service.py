"""Create and read review invitations (plugin: reviews).

An invitation names a paper version and the DID of the invited reviewer.  It
is created through ``POST /v1/papers/{id}/review-invitations`` by an author of
the paper or a tier-4 member, and targets a tier-3 reviewer.  The row is
stored in the ``review_invitations`` table with status ``pending``.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import db
from app.security import Tier

from app.modules import submissions
from app.modules.endorsements import account_tier, can_submit
from app.modules.identity.models import Account, ensure_account_table
from app.modules.ingest.errors import InvalidRecord
from app.modules.ingest.service import PAPER_GENESIS_TYPE, PAPER_VERSION_TYPE

from .errors import (
    ReviewAlreadyCommitted,
    ReviewNotAuthorized,
    UnknownReviewTarget,
)
from .models import Review, ReviewInvitation, ensure_table, ensure_tables

__all__ = [
    "COMMITTED",
    "REVIEW_COMMIT_MIN_TIER",
    "REVIEW_COMMIT_TYPE",
    "Review",
    "ReviewCommitFields",
    "ReviewInvitation",
    "apply_review_commit",
    "create_invitation",
    "create_review_invitation",
    "find_review_by_nullifier",
    "get_invitation",
    "get_review",
    "get_review_invitation",
    "handle_review_commit",
    "is_author_or_moderator",
    "is_tier3_reviewer",
    "list_invitations",
    "list_review_invitations",
    "nullifier_bytes",
    "persist_review_commit",
    "require_not_author",
    "resolve_paper",
    "resolve_review_target",
    "resolve_version",
    "review_commit_fields",
    "save_invitation",
    "save_review_invitation",
]


class _PaperRef:
    """Lightweight paper handle usable by both DB- and ledger-backed resolves."""

    def __init__(self, paper_cid: str, short_id: str, categories: list):
        self.paper_cid = paper_cid
        self.short_id = short_id
        self.categories = categories

    # Submissions Paper uses attribute ``categories``; expose same.


class _VersionRef:
    def __init__(self, version_cid: str, n: int, paper_cid: str):
        self.version_cid = version_cid
        self.n = n
        self.paper_cid = paper_cid


def _ledger_rows():
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    from sqlalchemy import select

    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog).order_by(EventLog.seq)
            ).scalars()
        )
        for r in rows:
            session.expunge(r)
        return rows


def _body_of(entry) -> dict:
    body = getattr(entry, "body", None)
    return body if isinstance(body, dict) else {}


def _resolve_from_ledger(identifier: str):
    """Return (paper_ref, version_ref or None) resolved from the event log."""
    from scholium_record_core import parse_short_id, parse_version_id, derive_short_id

    # Determine canonical short id / genesis cid / version.
    short_id = None
    genesis_cid = None
    version_cid = None
    version_n = None

    # version id spelling sch:.../vN
    try:
        vid = parse_version_id(identifier)
        short_id = vid.short_id
        version_n = vid.version
    except ValueError:
        pass

    # short id spelling
    if short_id is None:
        try:
            parse_short_id(identifier)
            short_id = identifier
        except ValueError:
            pass

    rows = _ledger_rows()

    # genesis cid spelling
    if short_id is None and genesis_cid is None and version_cid is None:
        # maybe a genesis cid
        for row in rows:
            if row.record_type == PAPER_GENESIS_TYPE and row.record_cid == identifier:
                genesis_cid = identifier
                try:
                    short_id = derive_short_id(identifier)
                except Exception:
                    short_id = None
                break
        # maybe a version cid
        if genesis_cid is None:
            for row in rows:
                if row.record_type == PAPER_VERSION_TYPE and row.record_cid == identifier:
                    version_cid = identifier
                    body = _body_of(row)
                    g = body.get("paper")
                    if isinstance(g, str):
                        genesis_cid = g
                        try:
                            short_id = derive_short_id(g)
                        except Exception:
                            short_id = None
                    version_n = body.get("n")
                    break

    if short_id is not None and genesis_cid is None:
        # find genesis in ledger
        for row in rows:
            if row.record_type != PAPER_GENESIS_TYPE:
                continue
            try:
                if derive_short_id(row.record_cid) == short_id:
                    genesis_cid = row.record_cid
                    break
            except ValueError:
                continue

    if genesis_cid is None:
        return None, None

    # categories from genesis body
    categories = []
    for row in rows:
        if row.record_type == PAPER_GENESIS_TYPE and row.record_cid == genesis_cid:
            body = _body_of(row)
            cats = body.get("categories")
            if isinstance(cats, list):
                categories = [str(c) for c in cats]
            break

    if short_id is None:
        try:
            short_id = derive_short_id(genesis_cid)
        except Exception:
            short_id = genesis_cid

    paper_ref = _PaperRef(genesis_cid, short_id, categories)

    # resolve version
    if version_cid is not None:
        # ensure belongs to paper
        vbody = None
        for row in rows:
            if row.record_type == PAPER_VERSION_TYPE and row.record_cid == version_cid:
                vbody = _body_of(row)
                break
        if vbody is not None and vbody.get("paper") == genesis_cid:
            n = vbody.get("n")
            if not isinstance(n, int) or isinstance(n, bool):
                n = version_n
            return paper_ref, _VersionRef(version_cid, int(n) if isinstance(n, int) else 0, genesis_cid)

    if version_n is not None:
        for row in rows:
            if row.record_type != PAPER_VERSION_TYPE:
                continue
            body = _body_of(row)
            if body.get("paper") != genesis_cid:
                continue
            v = body.get("n")
            if isinstance(v, bool) or not isinstance(v, int):
                continue
            if v == version_n:
                return paper_ref, _VersionRef(row.record_cid, v, genesis_cid)

    # latest version by n
    candidates = []
    for row in rows:
        if row.record_type != PAPER_VERSION_TYPE:
            continue
        body = _body_of(row)
        if body.get("paper") != genesis_cid:
            continue
        v = body.get("n")
        if isinstance(v, bool) or not isinstance(v, int):
            continue
        candidates.append((v, row.record_cid))
    if candidates:
        v, cid = max(candidates, key=lambda x: x[0])
        return paper_ref, _VersionRef(cid, v, genesis_cid)

    return paper_ref, None


def _as_paper(identifier: object):
    if not isinstance(identifier, str) or not identifier:
        return None
    # DB-backed first
    paper = submissions.get_paper(identifier)
    if paper is not None:
        return paper
    paper = submissions.get_paper_by_short_id(identifier)
    if paper is not None:
        return paper
    try:
        from scholium_record_core import parse_version_id

        vid = parse_version_id(identifier)
        paper = submissions.get_paper_by_short_id(vid.short_id)
        if paper is not None:
            return paper
    except Exception:
        pass
    from app.modules.submissions import get_version

    version = get_version(identifier)
    if version is not None:
        p = submissions.get_paper(version.paper_cid)
        if p is not None:
            return p
    # Ledger-backed fallback
    paper_ref, _ = _resolve_from_ledger(identifier)
    return paper_ref


def resolve_paper(identifier: object):
    """Resolve any spelling of a paper id to a paper handle, or ``None``."""
    return _as_paper(identifier)


def _latest_version_db(paper) -> Optional[Any]:
    if paper is None:
        return None
    if isinstance(paper, _PaperRef):
        return None  # handled in resolve_version
    versions = submissions.versions_for_paper(paper.paper_cid)
    if not versions:
        return None
    listed = [v for v in versions if getattr(v, "state", None) == "listed"]
    pool = listed if listed else versions
    return max(pool, key=lambda v: int(v.n))


def resolve_version(paper_id: object, version_hint: object = None):
    """Resolve the paper and the target version for an invitation.

    Returns ``(paper, version)`` or ``(None, None)``.
    """
    # Ledger-backed path
    # Detect if identifier is a short/genesis/version cid not in DB.
    paper = _as_paper(paper_id)
    if paper is None:
        return None, None

    # DB-backed paper (submissions.Paper)
    if not isinstance(paper, _PaperRef):
        if isinstance(version_hint, str) and version_hint:
            from app.modules.submissions import get_version

            version = get_version(version_hint)
            if version is not None and getattr(version, "paper_cid", None) == paper.paper_cid:
                return paper, version
            try:
                n = int(version_hint)
            except (TypeError, ValueError):
                n = None
            if n is not None:
                for v in submissions.versions_for_paper(paper.paper_cid):
                    if int(v.n) == n:
                        return paper, v
        version = _latest_version_db(paper)
        if version is None:
            # try ledger
            p, v = _resolve_from_ledger(paper_id if isinstance(paper_id, str) else paper.short_id)
            if v is not None:
                return paper, v  # version may be _VersionRef; okay
        return paper, version

    # Ledger-backed paper
    # Determine version hint
    hint = version_hint
    # If version_hint is None but paper_id encoded a version, _resolve_from_ledger already handled? Re-run with hint
    p, v = _resolve_from_ledger(paper_id if isinstance(paper_id, str) else paper.short_id)
    # If a specific hint provided, resolve again by constructing identifier with hint? Simpler: handle hint here.
    if isinstance(hint, str) and hint:
        # version cid
        if hint.startswith("bafy") or hint.startswith("Qm") or "cid" in hint.lower():
            # treat as cid
            pp, vv = _resolve_from_ledger(hint)
            if vv is not None and vv.paper_cid == paper.paper_cid:
                return paper, vv
        # version number
        try:
            n = int(hint)
        except (TypeError, ValueError):
            n = None
        if n is not None:
            # find in ledger
            rows = _ledger_rows()
            for row in rows:
                if row.record_type != PAPER_VERSION_TYPE:
                    continue
                body = _body_of(row)
                if body.get("paper") != paper.paper_cid:
                    continue
                vnum = body.get("n")
                if isinstance(vnum, bool) or not isinstance(vnum, int):
                    continue
                if vnum == n:
                    return paper, _VersionRef(row.record_cid, vnum, paper.paper_cid)
    if v is not None:
        return paper, v
    return paper, None


def _first(payload: Any, keys: tuple[str, ...]) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
    return None


_REVIEWER_KEYS = (
    "reviewer",
    "reviewer_did",
    "reviewerDid",
    "reviewer_id",
    "reviewerId",
    "did",
    "invitee",
    "invitee_did",
    "inviteeDid",
    "target",
    "target_did",
    "targetDid",
)
_VERSION_KEYS = (
    "version",
    "version_cid",
    "versionCid",
    "version_id",
    "versionId",
    "target_version",
    "targetVersion",
)


def _make_invitation(
    *,
    invitation_id: Optional[str],
    version_cid: str,
    reviewer_did: str,
    status: str,
) -> ReviewInvitation:
    ensure_table()
    iid = invitation_id or str(uuid.uuid4())
    row = ReviewInvitation(
        id=iid,
        version_cid=version_cid,
        reviewer_did=reviewer_did,
        status=status,
    )
    with db.SessionLocal() as session:
        session.add(row)
        session.commit()
        session.refresh(row)
        session.expunge(row)
    return row


def create_invitation(
    *,
    paper_id: object = None,
    version_cid: Optional[str] = None,
    version: object = None,
    version_id: object = None,
    reviewer_did: Optional[str] = None,
    reviewer: Optional[str] = None,
    reviewer_id: Optional[str] = None,
    did: Optional[str] = None,
    invitation_id: Optional[str] = None,
    status: str = "pending",
    inviter_did: Optional[str] = None,
    **kwargs: Any,
) -> ReviewInvitation:
    """Create and store a review invitation row."""
    # Accept alternate keys from kwargs.
    if reviewer_did is None:
        reviewer_did = kwargs.pop("reviewer_did", None) or kwargs.pop("reviewer", None) or kwargs.pop("reviewer_id", None) or kwargs.pop("did", None) or reviewer or reviewer_id or did
    if version_cid is None:
        version_cid = kwargs.pop("version_cid", None) or kwargs.pop("versionCid", None) or kwargs.pop("version_id", None) or kwargs.pop("versionId", None)
    if version is None:
        version = kwargs.pop("version", None) or kwargs.pop("version_hint", None)
    if paper_id is None:
        paper_id = kwargs.pop("paper_id", None) or kwargs.pop("paper", None) or kwargs.pop("paperId", None)

    vc = version_cid
    if not vc and paper_id is not None:
        paper, ver = resolve_version(paper_id, version)
        if ver is not None:
            vc = ver.version_cid
    if not vc and version is not None and isinstance(version, str):
        # maybe version is a cid
        vc = version
    if not vc:
        raise ValueError("version_cid is required")
    reviewer = str(reviewer_did or "").strip()
    if not reviewer:
        raise ValueError("reviewer_did is required")
    st = status if isinstance(status, str) else "pending"
    if not st.strip():
        st = "pending"
    return _make_invitation(
        invitation_id=invitation_id,
        version_cid=vc,
        reviewer_did=reviewer,
        status=st,
    )


# Aliases
create_review_invitation = create_invitation
save_invitation = create_invitation
save_review_invitation = create_invitation


def get_invitation(invitation_id: str) -> Optional[ReviewInvitation]:
    ensure_table()
    with db.SessionLocal() as session:
        row = session.get(ReviewInvitation, invitation_id)
        if row is not None:
            session.expunge(row)
        return row


get_review_invitation = get_invitation


def list_invitations(*, reviewer_did: Optional[str] = None, version_cid: Optional[str] = None):
    ensure_table()
    with db.SessionLocal() as session:
        stmt = select(ReviewInvitation)
        if reviewer_did is not None:
            stmt = stmt.where(ReviewInvitation.reviewer_did == reviewer_did)
        if version_cid is not None:
            stmt = stmt.where(ReviewInvitation.version_cid == version_cid)
        rows = list(session.execute(stmt).scalars().all())
        for row in rows:
            session.expunge(row)
        return rows


list_review_invitations = list_invitations


def _paper_authors_from_ledger(paper_cid: str) -> set:
    authors: set = set()
    try:
        authors |= set(submissions.paper_authors(paper_cid))
    except Exception:
        pass
    try:
        for row in _ledger_rows():
            if row.record_type == PAPER_GENESIS_TYPE and row.record_cid == paper_cid:
                if getattr(row, "author_did", None):
                    authors.add(str(row.author_did))
            if row.record_type == PAPER_VERSION_TYPE:
                body = _body_of(row)
                if body.get("paper") == paper_cid:
                    if getattr(row, "author_did", None):
                        authors.add(str(row.author_did))
                    for a in body.get("authors") or []:
                        if isinstance(a, str):
                            authors.add(a)
                        elif isinstance(a, dict):
                            d = a.get("did") or a.get("author")
                            if isinstance(d, str):
                                authors.add(d)
    except Exception:
        pass
    return authors


def is_author_or_moderator(inviter_did: str, paper, principal_tier: int) -> bool:
    if principal_tier >= int(Tier.MODERATOR):
        return True
    if paper is None:
        return False
    authors = _paper_authors_from_ledger(paper.paper_cid)
    return inviter_did in authors


def is_tier3_reviewer(reviewer_did: str, paper) -> bool:
    if not isinstance(reviewer_did, str) or not reviewer_did:
        return False
    if account_tier(reviewer_did) < int(Tier.REVIEWER):
        return False
    # "in the paper category": prefer an active endorsement in one of the
    # paper's categories when endorsements exist; otherwise accept any tier-3.
    try:
        categories = list(paper.categories) if paper is not None and paper.categories else []
    except Exception:
        categories = []
    if not categories:
        return True
    # If the reviewer holds an active endorsement in at least one category,
    # require it to be one of the paper's categories.
    try:
        from app.modules.endorsements import active_endorsements

        ends = active_endorsements(reviewer_did)
    except Exception:
        ends = []
    if ends:
        return any(e.category in categories for e in ends)
    return True


def parse_payload(payload: Any):
    """Extract (reviewer_did, version_hint) from a request body."""
    if not isinstance(payload, dict):
        payload = {}
    reviewer = _first(payload, _REVIEWER_KEYS)
    version_hint = _first(payload, _VERSION_KEYS)
    status = _first(payload, ("status",))
    return reviewer, version_hint, status


# --------------------------------------------------------------------------- #
# Committing a review (feature 107)
# --------------------------------------------------------------------------- #

#: The record type this plugin owns.
REVIEW_COMMIT_TYPE = "review.commit"

#: The state an accepted commit reports back to the client.
COMMITTED = "committed"

#: Lowest *author* tier the ingest registry lets through.  A ``review.commit``
#: is signed by the reviewer's pseudonymous per-paper key, which has no account
#: row and therefore reads as tier 0.  Who may review -- a tier-3 *caller* -- is
#: the endpoint's `require_tier(3)` dependency, not the record author's tier.
REVIEW_COMMIT_MIN_TIER = 0


@dataclass(frozen=True)
class ReviewCommitFields:
    """The parts of a ``review.commit`` this plugin acts on, shape-checked."""

    #: cid of the commit record (its ``id``).
    review_cid: str
    #: cid of the ``paper.version`` under review (``body.target``).
    version_cid: str
    #: cid of that version's paper (its genesis record).
    paper_cid: str
    #: The pseudonymous per-paper key the eventual review is signed with.
    review_key: str
    #: Hash commitment to the sealed review content.
    commitment: str
    #: ``H(secret || paperId)`` as bytes; deterministic per reviewer and paper.
    nullifier: bytes
    #: The instant the record is dated (``created``), not when it arrived.
    committed_at: datetime


def nullifier_bytes(value: Any) -> bytes:
    """Decode a client's nullifier to the bytes the ``review`` table stores.

    A nullifier arrives as the hex digest ``H(secret || paperId)``; hex is
    decoded so the column holds the 32-byte digest.  Anything that is not
    hexadecimal is stored as its UTF-8 bytes, so a client using another
    encoding still gets a stable value to compare against.
    """
    text = str(value).strip()
    try:
        return bytes.fromhex(text)
    except ValueError:
        return text.encode("utf-8")


def _invalid(loc: list[Any], message: str, error_type: str, value: Any = None) -> InvalidRecord:
    """A ``422`` for one bad field of a ``review.commit``, located at ``loc``."""
    shown = value if isinstance(value, (str, int, float, bool, type(None))) else None
    if isinstance(shown, str) and len(shown) > 64:
        shown = shown[:61] + "..."
    full = f"The review commit {message}."
    return InvalidRecord(
        [{"loc": loc, "msg": full, "type": error_type, "input": shown}],
        detail=full,
    )


def _created_at(record: Mapping[str, Any]) -> datetime:
    """The record's ``created`` as naive UTC (a bare timestamp is read as UTC), or ``422``."""
    value = record.get("created")
    try:
        moment = datetime.fromisoformat(value.strip()) if isinstance(value, str) else None
    except ValueError:
        moment = None
    if moment is None:
        raise _invalid(
            ["created"],
            "field 'created' must be an ISO 8601 instant",
            "invalid_created",
            value,
        )
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).replace(tzinfo=None)


def resolve_review_target(target: str) -> tuple[str, str]:
    """Return ``(version_cid, paper_cid)`` for a review's ``body.target``.

    The submissions projection is consulted first; the event log second, so a
    ``paper.version`` whose handler has not indexed it can still be reviewed.

    Raises:
        UnknownReviewTarget: ``422`` when ``target`` is not a version here.
    """
    version = submissions.get_version(target)
    if version is not None:
        return str(version.version_cid), str(version.paper_cid)

    from app.modules import ledger

    entry = ledger.entry_by_cid(target)
    if entry is not None and getattr(entry, "record_type", None) == PAPER_VERSION_TYPE:
        body = getattr(entry, "body", None)
        paper = body.get("paper") if isinstance(body, Mapping) else None
        if isinstance(paper, str) and paper:
            return str(target), paper
    raise UnknownReviewTarget(target)


def review_commit_fields(record: Mapping[str, Any]) -> ReviewCommitFields:
    """Shape-check a ``review.commit`` and return the fields this plugin acts on.

    The ingest pipeline's schema check normally runs first; this re-checks the
    shape so a direct caller gets ``422`` problem details rather than a
    ``TypeError`` or a half-written row.

    Raises:
        InvalidRecord: ``422`` when the body is not an object, ``target`` is
            missing, neither ``commitment`` nor ``commitmentHash`` is given,
            ``nullifier`` is missing, or ``created`` is not an instant.
        UnknownReviewTarget: ``422`` when ``target`` is not a version here.
    """
    body = record.get("body")
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the review.commit body must be an object"],
            detail="The review.commit body must be a JSON object.",
        )

    review_cid = record.get("id")
    if not isinstance(review_cid, str) or not review_cid:
        message = "The review.commit record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )

    target = body.get("target")
    if not isinstance(target, str) or not target.strip():
        raise _invalid(
            ["body", "target"],
            "needs the cid of the paper version under review in 'target'",
            "invalid_target",
            target,
        )
    target = target.strip()

    commitment = body.get("commitment")
    if not isinstance(commitment, str) or not commitment:
        commitment = body.get("commitmentHash")
    if not isinstance(commitment, str) or not commitment:
        raise _invalid(
            ["body", "commitment"],
            "needs a non-empty 'commitment' (or 'commitmentHash')",
            "missing_commitment",
            body.get("commitment"),
        )

    nullifier = body.get("nullifier")
    if not isinstance(nullifier, str) or not nullifier.strip():
        raise _invalid(
            ["body", "nullifier"],
            "needs a non-empty 'nullifier'",
            "missing_nullifier",
            nullifier,
        )

    review_key = body.get("reviewKey")
    if not isinstance(review_key, str) or not review_key:
        review_key = body.get("review_key")
    if not isinstance(review_key, str) or not review_key:
        # The reviewer's per-paper key signs the commit; the envelope's author
        # is that key, so it is the natural fallback.
        review_key = record.get("author")
    if not isinstance(review_key, str) or not review_key:
        raise _invalid(
            ["body", "reviewKey"],
            "needs the per-paper review key in 'reviewKey'",
            "missing_review_key",
            body.get("reviewKey"),
        )

    version_cid, paper_cid = resolve_review_target(target)
    return ReviewCommitFields(
        review_cid=review_cid,
        version_cid=version_cid,
        paper_cid=paper_cid,
        review_key=review_key,
        commitment=commitment,
        nullifier=nullifier_bytes(nullifier),
        committed_at=_created_at(record),
    )


def get_review(review_cid: object) -> Optional[Review]:
    """The saved review with this cid, or ``None``."""
    if not isinstance(review_cid, str) or not review_cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Review, review_cid)
        if row is not None:
            session.expunge(row)
        return row


def find_review_by_nullifier(nullifier: bytes) -> Optional[Review]:
    """The saved review with this nullifier, or ``None``.

    A nullifier is ``H(secret || paperId)``: one reviewer and one paper give
    one value, every time, so finding one means this person has reviewed this
    paper already.  Another reviewer, or the same reviewer on another paper,
    derives another nullifier.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        row = (
            session.query(Review)
            .filter(Review.nullifier == nullifier)
            .one_or_none()
        )
        if row is not None:
            session.expunge(row)
        return row


def require_not_author(caller_did: object, paper_cid: str) -> None:
    """Refuse unless ``caller_did`` is not an author of the paper (``403``).

    ``caller_did`` is the access token's subject -- the member asking -- not
    the commit's pseudonymous author.  Authorship is the definition
    :func:`app.modules.submissions.paper_authors` gives -- whoever signed the
    genesis or a version, and everyone listed on a byline -- plus the bylines
    the event log holds for a paper the submissions handler has not indexed.

    Raises:
        ReviewNotAuthorized: ``403``.
    """
    if isinstance(caller_did, str) and caller_did:
        if caller_did in _paper_authors_from_ledger(paper_cid):
            raise ReviewNotAuthorized(caller_did, paper_cid)


def handle_review_commit(record: Mapping[str, Any]) -> str:
    """Validate a ``review.commit``; return the state it will be saved with.

    Runs before the record is appended to the ledger, so a conflict stores
    nothing.  Nothing is saved here either: the ``review`` row is written by
    :func:`apply_review_commit` once the record is in the log.

    Raises:
        InvalidRecord, UnknownReviewTarget: ``422``.
        ReviewAlreadyCommitted: ``409`` -- this person reviewed this paper.
    """
    fields = review_commit_fields(record)
    existing = find_review_by_nullifier(fields.nullifier)
    if existing is not None:
        raise ReviewAlreadyCommitted(fields.paper_cid, existing.review_cid)
    return COMMITTED


def apply_review_commit(record: Mapping[str, Any]) -> Review:
    """Save the review to the ``review`` table; return its row.

    Idempotent per review cid: a commit that already has its row is returned
    as it is, so the ledger subscriber and the endpoint may both call this for
    the same record.  The record is validated again first, so no row exists for
    a commit the handler would have refused.

    Raises:
        InvalidRecord, UnknownReviewTarget: ``422``.
        ReviewAlreadyCommitted: ``409`` -- another review holds the nullifier.
    """
    fields = review_commit_fields(record)

    existing = get_review(fields.review_cid)
    if existing is not None:
        return existing

    conflict = find_review_by_nullifier(fields.nullifier)
    if conflict is not None:
        raise ReviewAlreadyCommitted(fields.paper_cid, conflict.review_cid)

    row = Review(
        review_cid=fields.review_cid,
        version_cid=fields.version_cid,
        review_key=fields.review_key,
        nullifier=fields.nullifier,
        committed_at=fields.committed_at,
    )
    with db.SessionLocal() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            # This very record was saved by another writer between the check
            # above and now; its row is this record's row.
            saved = session.get(Review, fields.review_cid)
            if saved is not None:
                session.expunge(saved)
                return saved
            raise
        session.refresh(row)
        session.expunge(row)
    return row


def persist_review_commit(entry: Any) -> None:
    """Ledger subscriber: save every ``review.commit`` once it is in the log.

    Failures are logged by the ledger and do not undo the append; the endpoint
    applies the commit again and reports a real failure to its caller.
    """
    if getattr(entry, "record_type", None) != REVIEW_COMMIT_TYPE:
        return
    from app.modules import ledger

    apply_review_commit(ledger.stored_envelope(entry).model_dump())