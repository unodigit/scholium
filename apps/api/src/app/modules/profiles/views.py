"""Assemble the public view of a profile (feature 29).

``GET /v1/profiles/{did}`` answers with everything a profile page shows::

    from app.modules.profiles import public_profile

    view = public_profile("did:key:z6Mk...")
    # PublicProfile(did=..., name="Ada", affiliation="Co.", email=None,
    #               orcid="0000-0002-1825-0097", tier=1, erased=False,
    #               reviews=[SignedReview(...), ...])

The email is personal data and is returned only when the caller passes
``viewer_did`` equal to the profile's DID -- the owner reading their own
profile.  It is ``None`` for every other caller.

The view is assembled from four sources, and only the first is this plugin's
own storage:

``profile`` / ``profile_keys``
    The decrypted name, affiliation and email (feature 28).  When the
    per-object key is gone -- what erasure leaves behind -- the fields read as
    ``None`` instead of raising: crypto-shredding is a state, not an error.
    A blob that is present, keyed, and still fails to decrypt *is* an error
    (:class:`~app.modules.profiles.crypto.ProfileDecryptionError`) and is
    deliberately left to the caller to report; corruption must not be mistaken
    for erasure.
``accounts`` (identity plugin)
    The trust tier.  A DID that has no account row -- or whose plugin table
    does not exist yet -- reads as tier 0, the tier every account starts at.
``credentials`` (orcid plugin)
    The linked ORCID iD, taken from the ORCID ownership credential.  The
    table belongs to a plugin that may not be loaded, so absence of the table
    simply means "nothing linked".
``review`` (reviews plugin)
    The reviews this DID chose to sign with their name (feature 111), once
    they have been revealed: signed **and** revealed is what "public" means
    here.  An anonymous review (``signed_by`` empty) never appears on a
    profile -- that is the point of pseudonymous review -- and a signed one
    stays off it until the escrow opens.

Erasure
    Erasure is detected without waiting for the DELETE route (feature 30): a
    profile row whose key was deleted, or an ``erasure.request`` record on the
    event log for this DID when even the row is gone.  An erased profile shows
    the pseudonymous DID, the tier and the public signed reviews only: the
    name, affiliation and email are unreadable, and the ORCID iD is withheld
    even though its credential row survives -- an ORCID iD identifies a person
    more surely than a name does, and "showing only the pseudonymous DID after
    erasure" must hold for it too.  Saving again after erasure is allowed
    (feature 28), and a readable profile beats the old erasure record: the
    account is no longer erased.

The foreign tables are mirrored into a private :class:`~sqlalchemy.MetaData`
(the same trick as the admin plugin's ``accounts`` mirror) rather than
imported from their owning plugins: those plugins may not be loaded at all,
and a second declarative model for the same table would collide with theirs
on the shared base.  Nothing here creates a foreign table; if one is missing,
the corresponding answer is "none" (tier 0, no ORCID, no reviews).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    LargeBinary,
    MetaData,
    Table,
    Text,
    inspect,
    select,
)

from app import db

from .crypto import open_profile
from .models import Profile, ProfileKey, ensure_tables
from .service import _require_did

__all__ = [
    "ERASURE_RECORD_TYPE",
    "MAX_TIER",
    "ORCID_PATTERN",
    "PublicProfile",
    "SignedReview",
    "accounts_table",
    "credentials_table",
    "event_log_table",
    "public_profile",
    "read_orcid",
    "read_signed_reviews",
    "read_tier",
    "review_table",
]

#: Record type an erasure appends to the event log (feature 30).
ERASURE_RECORD_TYPE = "erasure.request"

#: Highest trust tier; a wilder value in the table is clamped down to it.
MAX_TIER = 4

#: A bare ORCID iD: four groups of four digits, the last character being the
#: MOD 11-2 checksum which may be ``X``.  The look-around terms refuse to match
#: inside a longer digit/hyphen run, so nothing ORCID-shaped-but-longer (a
#: phone number, a UUID fragment) is read as an iD.
ORCID_PATTERN = re.compile(r"(?<![\dXx-])\d{4}-\d{4}-\d{4}-\d{3}[\dX](?![\dXx-])")

#: Credential statuses that must stop being displayed.  Every other status
#: (``valid``, ``issued``, ``active``...) is shown; the orcid plugin that owns
#: the table has not fixed its vocabulary yet.
_WITHDRAWN_STATUSES = frozenset({"revoked", "suspended"})

# Foreign tables this plugin only ever reads.  Mirrored, not imported: their
# owning plugins may not be loaded, and mirroring into a private MetaData
# cannot collide with their declarative models on the shared base.  Column
# shapes follow ``database_schema`` in ``app_spec.xml``; only the columns a
# query here names are ever read.
_foreign_metadata = MetaData()

accounts_table = Table(
    "accounts",
    _foreign_metadata,
    Column("did", Text, primary_key=True),
    Column("tier", Integer, nullable=False),
    Column("created_at", DateTime, nullable=False),
)

credentials_table = Table(
    "credentials",
    _foreign_metadata,
    Column("id", Text, primary_key=True),
    Column("did", Text, nullable=False),
    Column("kind", Text, nullable=False),
    # JSON in the spec, mirrored as Text and decoded below: decoding here, per
    # row, lets one malformed credential be skipped instead of failing the
    # whole public profile read.
    Column("vc", Text, nullable=False),
    Column("status", Text, nullable=False),
)

event_log_table = Table(
    "event_log",
    _foreign_metadata,
    Column("seq", Integer, primary_key=True),
    Column("record_cid", Text, nullable=False),
    Column("record_type", Text, nullable=False),
    Column("author_did", Text, nullable=False),
)

review_table = Table(
    "review",
    _foreign_metadata,
    Column("review_cid", Text, primary_key=True),
    Column("version_cid", Text, nullable=False),
    Column("review_key", Text, nullable=False),
    Column("nullifier", LargeBinary, nullable=False),
    # Decoded per row below, like credentials.vc above.
    Column("scores", Text),
    Column("recommendation", Text),
    Column("confidence", Integer),
    Column("report_cid", Text),
    Column("signed_by", Text),
    Column("committed_at", DateTime),
    Column("revealed_at", DateTime),
)


@dataclass(frozen=True)
class SignedReview:
    """One revealed review the DID chose to sign with their name.

    Only public columns are carried across.  ``review_key`` and ``nullifier``
    -- the material that ties a review to its pseudonymous commitment -- are
    read by nobody and must never appear in a response.
    """

    review_cid: str
    version_cid: str
    recommendation: Optional[str] = None
    confidence: Optional[int] = None
    scores: Optional[Any] = None
    report_cid: Optional[str] = None
    committed_at: Optional[datetime] = None
    revealed_at: Optional[datetime] = None


@dataclass(frozen=True)
class PublicProfile:
    """Everything ``GET /v1/profiles/{did}`` shows for one DID.

    ``name``/``affiliation``/``email``/``orcid`` are ``None`` when there is
    nothing to show: never saved, or erased.  ``email`` is also ``None``
    unless the viewer is the profile's owner -- it is personal data, while
    the other fields are the DID's public face.  ``tier`` and ``reviews`` are
    never personal data -- the tier is an account property and the reviews are
    signed public records -- so both survive erasure, which is the point: the
    DID stays pseudonymous, its history keeps verifying.
    """

    did: str
    tier: int = 0
    erased: bool = False
    name: Optional[str] = None
    affiliation: Optional[str] = None
    email: Optional[str] = None
    orcid: Optional[str] = None
    reviews: list[SignedReview] = field(default_factory=list)


def _table_exists(name: str) -> bool:
    """Return whether ``name`` is a table on the shared engine right now.

    Deliberately uncached: tests (and, one day, plugins) create tables while
    the process is running, so a memoized "missing" would lie.
    """
    return inspect(db.engine).has_table(name)


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _decode_json_cell(value: Any) -> Any:
    """Decode a JSON table cell, or ``None`` when it holds nothing usable.

    The cells reach here as text (or bytes) because the owning plugin's JSON
    encoding is mirrored as Text above; a cell that is empty or not valid JSON
    reads as ``None`` -- one bad cell must not fail the profile it appears on.
    On PostgreSQL the owning table's column really is ``json``, and the driver
    decodes it before this code sees it; an object or array that arrives
    already decoded is the document itself and is returned as it is.
    """
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = bytes(value).decode("utf-8", "replace")
    if value is None or not isinstance(value, str) or not value.strip():
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def read_tier(did: str) -> int:
    """Return the trust tier of ``did``'s account, 0 when there is none to read.

    A tier outside 0-:data:`MAX_TIER` in the table is clamped into range
    rather than trusted: the value feeds authorization elsewhere and must not
    carry surprises.  No ``accounts`` table yet (the identity plugin not
    loaded) also reads as 0, the tier sign-in grants.
    """
    if not _table_exists("accounts"):
        return 0
    with db.engine.connect() as conn:
        value = conn.execute(
            select(accounts_table.c.tier).where(accounts_table.c.did == did)
        ).scalar()
    tier = _int_or_none(value)
    if tier is None:
        return 0
    return min(max(tier, 0), MAX_TIER)


def _find_orcid(node: Any) -> Optional[str]:
    """Return the first bare ORCID iD in JSON-decoded ``node``, or None.

    Walks the document in order and takes the first string that contains an
    iD, wherever the issuing plugin nested it (``credentialSubject.orcid``,
    a URI form, a display claim).  An ORCID ownership credential has no other
    ORCID-shaped data in it, so the walk cannot pick up the wrong value.
    """
    if isinstance(node, str):
        match = ORCID_PATTERN.search(node)
        return None if match is None else match.group(0)
    if isinstance(node, dict):
        for value in node.values():
            found = _find_orcid(value)
            if found is not None:
                return found
    elif isinstance(node, (list, tuple)):
        for value in node:
            found = _find_orcid(value)
            if found is not None:
                return found
    return None


def read_orcid(did: str) -> Optional[str]:
    """Return the ORCID iD linked to ``did``, or None when none is linked.

    Candidates are the DID's credential rows that are not withdrawn
    (``revoked``/``suspended``), ordered so rows whose ``kind`` names ORCID
    are consulted first, then by ``id`` for determinism.  The iD is whatever
    ORCID-shaped string the credential carries, in bare form.  A credential
    whose ``vc`` cannot be decoded is skipped, not fatal: one malformed row
    must not hide a good one.
    """
    if not _table_exists("credentials"):
        return None
    query = select(
        credentials_table.c.id,
        credentials_table.c.kind,
        credentials_table.c.vc,
        credentials_table.c.status,
    ).where(credentials_table.c.did == did)
    with db.engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(query).mappings()]
    if not rows:
        return None

    def prefer_orcid_kind(row: dict) -> tuple[bool, str]:
        kind = row["kind"] if isinstance(row["kind"], str) else ""
        return ("orcid" not in kind.lower(), row["id"] if isinstance(row["id"], str) else "")

    for row in sorted(rows, key=prefer_orcid_kind):
        status = row["status"] if isinstance(row["status"], str) else ""
        if status.strip().lower() in _WITHDRAWN_STATUSES:
            continue
        vc = _decode_json_cell(row["vc"])
        if vc is None:
            continue
        found = _find_orcid(vc)
        if found is not None:
            return found
    return None


def read_signed_reviews(did: str) -> list[SignedReview]:
    """Return the DID's revealed, signed reviews, oldest reveal first.

    "Public" is ``signed_by`` set (the reviewer asked for credit) *and*
    ``revealed_at`` set (the escrow opened; feature 110 keeps report bodies
    sealed until then).  A row whose columns will not coerce is skipped rather
    than allowed to fail the whole profile.
    """
    if not _table_exists("review"):
        return []
    query = (
        select(
            review_table.c.review_cid,
            review_table.c.version_cid,
            review_table.c.recommendation,
            review_table.c.confidence,
            review_table.c.scores,
            review_table.c.report_cid,
            review_table.c.committed_at,
            review_table.c.revealed_at,
        )
        .where(review_table.c.signed_by == did, review_table.c.revealed_at.is_not(None))
        .order_by(review_table.c.revealed_at, review_table.c.review_cid)
    )
    reviews: list[SignedReview] = []
    with db.engine.connect() as conn:
        for row in conn.execute(query).mappings():
            try:
                reviews.append(
                    SignedReview(
                        review_cid=row["review_cid"],
                        version_cid=row["version_cid"],
                        recommendation=row["recommendation"],
                        confidence=_int_or_none(row["confidence"]),
                        scores=_decode_json_cell(row["scores"]),
                        report_cid=row["report_cid"],
                        committed_at=row["committed_at"],
                        revealed_at=row["revealed_at"],
                    )
                )
            except (TypeError, ValueError):
                continue
    return reviews


def _erasure_requested(did: str) -> bool:
    """Return whether an ``erasure.request`` record has been appended for ``did``.

    The erasure route (feature 30) appends the record and deletes the key; a
    deployment that also deletes the ``profile`` row leaves this record as the
    only trace, so it is what the row-less case is decided on.  Only records
    the DID itself signed count (``author_did``): the MVP erasure flow is the
    data subject's own request.
    """
    if not _table_exists("event_log"):
        return False
    query = select(event_log_table.c.seq).where(
        event_log_table.c.author_did == did,
        event_log_table.c.record_type == ERASURE_RECORD_TYPE,
    )
    with db.engine.connect() as conn:
        return conn.execute(query).first() is not None


def public_profile(did: str, *, viewer_did: Optional[str] = None) -> PublicProfile:
    """Assemble everything ``GET /v1/profiles/{did}`` shows for ``did``.

    ``viewer_did`` is the authenticated caller, when there is one.  The email
    is personal data (PRD ID-7, tech_architect §12): it is returned only when
    the viewer *is* the profile's owner, and is ``None`` for everyone else,
    including when no viewer is given.  The name, affiliation, ORCID iD, tier
    and signed reviews are the DID's public face and are returned regardless.

    Raises :class:`~app.modules.profiles.crypto.ProfileDecryptionError` when a
    keyed blob still will not open: that is corruption, and the caller must
    surface it rather than let it pass for erasure.  ``ValueError`` for a
    blank ``did``.
    """
    _require_did(did)
    ensure_tables()

    name: Optional[str] = None
    affiliation: Optional[str] = None
    email: Optional[str] = None
    erased = False

    with db.SessionLocal() as session:
        profile = session.get(Profile, did)
        if profile is None:
            # No row at all: erased only if an erasure record says the row was
            # removed; otherwise this DID simply never saved a profile.
            erased = _erasure_requested(did)
        else:
            key_row = session.get(ProfileKey, profile.key_ref)
            if key_row is None:
                erased = True  # crypto-shredded: the blob is unreadable for good
            else:
                # A readable profile beats an older erasure record: the account
                # saved again after erasing, which feature 28 allows.
                fields = open_profile(key_row.key, did, profile.enc_blob)
                name = fields.get("name")
                affiliation = fields.get("affiliation")
                email = fields.get("email")

    return PublicProfile(
        did=did,
        tier=read_tier(did),
        erased=erased,
        name=name,
        affiliation=affiliation,
        # The address is personal data; only its owner may read it back.
        email=email if viewer_did == did else None,
        # An ORCID iD identifies a person; an erased profile shows none.
        orcid=None if erased else read_orcid(did),
        reviews=read_signed_reviews(did),
    )
