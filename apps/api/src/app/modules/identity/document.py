"""GET /v1/did/{did}: resolve a did:key to a DID document (plugin: identity).

Feature 26: anyone can resolve a DID this node knows about::

    GET /v1/did/did:key:z6Mk...

    200 OK
    {
      "did": "did:key:z6Mk...",
      "active_key": "did:key:z6Mk...",
      "tier": 0,
      "key_history": []
    }

The document is assembled from three sources:

* ``active_key`` -- the key authorised to sign for the DID *right now*.
  Before any rotation that is the key the ``did:key`` identifier itself
  encodes (a ``did:key`` is its own genesis key); once the author has
  ``key.rotation`` records in the log it is the ``newKey`` of the newest
  one, because each rotation (feature 36) is what makes a new key active.
* ``key_history`` -- every ``key.rotation`` record in the node's event log
  authored by this DID, oldest first.  Each entry mirrors the record's
  body (``oldKey``, ``newKey``, ``effectiveAt``, ``reason``) alongside the
  record's ``cid`` and log ``seq``, so a client can fetch the signed record
  itself from ``GET /v1/records/{cid}`` and check the rotation's evidence.
* ``tier`` -- the account's trust tier from the ``accounts`` table.  A DID
  that has never signed in has no account row; it still resolves, at
  tier 0 -- the tier first sign-in creates (feature 24).

Resolution is read-only and unauthenticated: a ``did:key`` is
self-certifying, so the document resolves for every canonical Ed25519
identifier whether or not the account exists -- the same availability
ingest's key resolution (feature 27) relies on for authors that have
never signed in to this node.

Errors are RFC 9457 problem details via the app-wide handlers:

* ``422`` -- ``did`` is not a canonical Ed25519 did:key (type
  :data:`INVALID_DID_TYPE`).  Nothing is queried.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, List, Mapping, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app import db

from .challenge import INVALID_DID_TYPE
from .models import Account, ensure_account_table
from .service import InvalidDid, validate_did

if TYPE_CHECKING:  # pragma: no cover - import kept out of module load on purpose
    from app.modules.ledger.models import EventLog

__all__ = [
    "KEY_ROTATION_TYPE",
    "DidDocument",
    "KeyRotationEntry",
    "resolve_did_document",
    "router",
]

#: Record type whose log entries carry the key history.
KEY_ROTATION_TYPE = "key.rotation"

#: Router the package mounts under ``/v1`` (serves ``/v1/did/{did}``).
router = APIRouter(prefix="/did", tags=["did"])


class KeyRotationEntry(BaseModel):
    """One key rotation, as recorded by one ``key.rotation`` record.

    Field names are the endpoint's own (snake case); they mirror the
    record body's ``oldKey``/``newKey``/``effectiveAt``/``reason``.
    """

    model_config = ConfigDict(extra="forbid")

    #: The rotation record's id, resolvable via ``GET /v1/records/{cid}``.
    record_cid: str
    #: The record's position in the node's event log.
    seq: int
    #: The DID or public key rotated out (``null`` when the body omits it).
    old_key: Optional[str] = None
    #: The DID or public key that became active.
    new_key: Optional[str] = None
    #: When the rotation takes effect, as recorded (``null`` when absent).
    effective_at: Optional[str] = None
    #: Why the author rotated, as recorded (``null`` when absent).
    reason: Optional[str] = None


class DidDocument(BaseModel):
    """The DID document served by ``GET /v1/did/{did}``."""

    model_config = ConfigDict(extra="forbid")

    #: The resolved DID.
    did: str
    #: The key currently authorised to sign for the DID.
    active_key: str
    #: The account's trust tier; 0 for a DID that has never signed in.
    tier: int
    #: Every ``key.rotation`` record by this DID, oldest first.
    key_history: List[KeyRotationEntry]


def _invalid_did() -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package were imported before app.main the module
    # loader would then see `app.modules.identity` half-initialized with no
    # `router` attribute and silently skip mounting it.  (Same reason as the
    # challenge endpoint.)
    from app.errors import ProblemException

    # The offending value is deliberately not echoed back.
    return ProblemException(
        422,
        "'did' must be a canonical Ed25519 did:key identifier "
        "(for example did:key:z6Mk...).",
        type=INVALID_DID_TYPE,
    )


def _text(body: Mapping[str, Any], name: str) -> Optional[str]:
    """Return ``body[name]`` when it is a non-empty string, else ``None``.

    The log is append-only but not body-typed here: a history entry drops a
    value of the wrong shape rather than failing the whole resolution.
    """
    value = body.get(name)
    if isinstance(value, str) and value:
        return value
    return None


def _rotation_entry(row: EventLog) -> KeyRotationEntry:
    """Map one ``key.rotation`` log row onto its wire form."""
    body = row.body if isinstance(row.body, Mapping) else {}
    return KeyRotationEntry(
        record_cid=str(row.record_cid),
        seq=int(row.seq),
        old_key=_text(body, "oldKey"),
        new_key=_text(body, "newKey"),
        effective_at=_text(body, "effectiveAt"),
        reason=_text(body, "reason"),
    )


def resolve_did_document(did: str) -> DidDocument:
    """Assemble the DID document for ``did``.

    Raises:
        InvalidDid: ``did`` is not a canonical Ed25519 did:key.
    """
    validate_did(did)

    # Imported at call time, not module load: the ledger plugin is a sibling
    # under the module loader's scan, and this package must stay importable
    # no matter which plugin the loader reaches first (the same deferred
    # cross-plugin import the sanitizer uses for content blobs).
    from app.modules.ledger.models import EventLog
    from app.modules.ledger.models import ensure_table as ensure_event_log_table

    ensure_account_table()
    ensure_event_log_table()

    with db.SessionLocal() as session:
        account = session.get(Account, did)
        tier = int(account.tier) if account is not None else 0
        rows = (
            session.execute(
                select(EventLog)
                .where(EventLog.author_did == did)
                .where(EventLog.record_type == KEY_ROTATION_TYPE)
                .order_by(EventLog.seq)
            )
            .scalars()
            .all()
        )
        history = [_rotation_entry(row) for row in rows]

    # A did:key is its own genesis key; every recorded rotation that names a
    # new key supersedes the one before it, so the newest newKey wins.
    active_key = did
    for entry in history:
        if entry.new_key:
            active_key = entry.new_key

    return DidDocument(did=did, active_key=active_key, tier=tier, key_history=history)


@router.get(
    "/{did}",
    response_model=DidDocument,
    summary="Resolve a did:key to its DID document",
)
def get_did_document(did: str) -> DidDocument:
    """Return the DID document for ``did``: active key, key history and tier."""
    try:
        return resolve_did_document(did)
    except InvalidDid as exc:
        raise _invalid_did() from exc
