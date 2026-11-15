"""The ingest pipeline behind ``POST /v1/records`` (plugin: ingest).

Every write on this API is a client-signed record envelope::

    {"v": 1, "type": ..., "author": did, "created": ..., "prev": ...,
     "body": {...}, "proofs": [...], "id": cid, "sig": signature}

:func:`ingest` takes one such envelope through the pipeline, in this order:

1. **Envelope shape.**  ``v``, ``type``, ``author``, ``created``, ``prev``,
   ``body`` and ``proofs`` are checked by
   :func:`scholium_record_core.canonical_envelope` (an ``InvalidRecord``,
   422, when they are missing or of the wrong type), and ``id`` must be a
   non-empty string.
2. **Type.**  :func:`app.modules.ingest.registry.lookup` resolves the type's
   handler; a type no module registered is :class:`UnknownRecordType` (422).
3. **Body schema.**  For a Phase 1 type the body is validated against the
   schema shipped by the record core (``InvalidRecord``, 422, with one
   field error per violation).  A type registered by a module but not known
   to the record core is left to its handler to validate.
4. **CID.**  The record id is recomputed over the canonical content bytes and
   compared with the submitted ``id``; a mismatch is :class:`RecordIdMismatch`
   (422).  ``id`` is never part of the hash, so a valid signature can
   accompany a wrong id -- the id is checked on its own.
5. **Signature.**  ``sig`` is verified over those same bytes against the
   author's *active* signing key (:func:`active_signing_key`); a signature
   made by any other key is :class:`InvalidRecordSignature` (401).
6. **Duplicate.**  A cid already in the event log is :class:`DuplicateRecord`
   (409), checked before the handler runs so a repeat cannot make the handler
   act twice.
7. **Handler.**  The registered handler runs with a copy of the validated
   envelope before anything is persisted, so it can still refuse the record by
   raising a ``ProblemException``.  See below for what it may return.
8. **Ledger.**  The record is appended to the event log
   (:func:`app.modules.ledger.append`), which notifies ledger subscribers.
   The ledger's UNIQUE constraint covers two submissions racing each other,
   and is reported as :class:`DuplicateRecord` too.

The handler contract
--------------------

The registry records handlers but deliberately does not define how they are
called; this pipeline does.  A handler is called as ``handler(record)``, where
``record`` is the validated envelope mapping (including ``id`` and ``sig``),
and it may return:

* ``None`` -- no state to report;
* a state string such as ``"accepted"`` -- reported back to the client;
* a mapping with a ``"state"`` string (any other keys are ignored).

A record-owning module that needs to react *after* the record is stored should
use :func:`app.modules.ledger.subscribe` instead: subscribers run once the row
is committed, while the handler runs before it.

The active signing key
----------------------

A ``did:key`` is its own genesis key, so an author who never rotated verifies
against the key the identifier encodes.  When the identity plugin provides an
active-key resolver (``resolve_active_key``, feature 27, fed by
``key.rotation`` records), the signature is checked against the key that is
active now instead -- which is what makes ingest reject records signed by a
key that was rotated out before the record arrived.  The lookup is imported
lazily so this package stays importable on its own and a node without that
plugin still verifies the common case.

What is returned
----------------

:class:`IngestResult` carries what the endpoint answers:

* ``record_id`` -- the record's CID (the recomputed one, equal to the
  submitted ``id``);
* ``short_id`` -- the ``sch:`` id of the paper the record belongs to, for
  ``paper.genesis`` (``sch:xxxx-xxxx-xxxx``) and ``paper.version``
  (``sch:xxxx-xxxx-xxxx/vN``) records; ``None`` for every other type, since
  only papers have a short id;
* ``state`` -- the state the handler reported, or ``"accepted"``;
* ``anchor`` -- always ``"pending"`` (this node does not anchor its log
  on-chain, and reports that state rather than an error).
"""

from __future__ import annotations

import base64
import binascii
import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from scholium_record_core import (
    ED25519_PUBLIC_KEY_LENGTH,
    canonical_envelope,
    compute_record_id,
    derive_short_id,
    format_version_id,
    has_schema,
    validate_body,
    verify_envelope,
)

from .errors import (
    DuplicateRecord,
    InvalidRecord,
    InvalidRecordSignature,
    RecordIdMismatch,
)
from .registry import HandlerRegistration, lookup

__all__ = [
    "ANCHOR_PENDING",
    "DEFAULT_STATE",
    "IngestResult",
    "PAPER_GENESIS_TYPE",
    "PAPER_VERSION_TYPE",
    "active_signing_key",
    "ingest",
    "record_short_id",
]

#: Anchor status of every accepted record until the node anchors on-chain.
ANCHOR_PENDING = "pending"

#: State reported when the type handler does not name one.
DEFAULT_STATE = "accepted"

#: Record types whose record carries a paper short id.
PAPER_GENESIS_TYPE = "paper.genesis"
PAPER_VERSION_TYPE = "paper.version"


@dataclass(frozen=True)
class IngestResult:
    """What the ``POST /v1/records`` pipeline produced for one accepted record."""

    #: The record's cid -- recomputed from its content, equal to the submitted id.
    record_id: str
    #: The paper's ``sch:`` id, or ``None`` when the record is not a paper record.
    short_id: Optional[str]
    #: The state the handler reported, or :data:`DEFAULT_STATE`.
    state: str
    #: Public-timestamp status; always ``"pending"`` until anchoring exists.
    anchor: str = ANCHOR_PENDING


# --------------------------------------------------------------------------- #
# Active key
# --------------------------------------------------------------------------- #


def active_signing_key(did: str) -> str:
    """Return the key currently authorised to sign for ``did``.

    A ``did:key`` is self-certifying, so without a rotation the answer is the
    DID itself.  When the identity plugin offers ``resolve_active_key`` (its
    ``account_keys`` table, feature 27), that resolver decides instead.  The
    import happens at call time so this module does not depend on identity
    being present or on module-load order; a resolver that cannot read the
    DID falls back to the DID rather than failing the request, and the
    signature check then decides.
    """
    try:
        from app.modules.identity import resolve_active_key
    except (ImportError, AttributeError):
        return did
    try:
        key = resolve_active_key(did)
    except (LookupError, TypeError, ValueError):
        return did
    return key if isinstance(key, str) and key else did


def _verification_key(key: str) -> str | bytes:
    """Turn a resolved active key into something :func:`verify_envelope` takes.

    A key.rotation's ``newKey`` may name "the DID or public key becoming
    active", so the resolver can hand back either a ``did:key`` (passed
    straight through) or a raw Ed25519 public key as hex or base64 text (which
    the verifier takes as 32 raw bytes).  Anything else is passed through
    unchanged; the verifier then refuses it and the record is a 401.
    """
    if key.startswith("did:"):
        return key
    text = key.strip()
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        raw = b""
    if len(raw) != ED25519_PUBLIC_KEY_LENGTH:
        for decode in (base64.urlsafe_b64decode, base64.b64decode):
            try:
                candidate = decode(text + "=" * (-len(text) % 4))
            except (binascii.Error, ValueError):
                continue
            if len(candidate) == ED25519_PUBLIC_KEY_LENGTH:
                raw = candidate
                break
    return raw if len(raw) == ED25519_PUBLIC_KEY_LENGTH else key


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #


def _check_shape(record: Mapping[str, Any]) -> None:
    """Validate the seven id-relevant envelope fields (422 problem details)."""
    try:
        canonical_envelope(record)
    except ValueError as exc:
        raise InvalidRecord([str(exc)], detail=f"The record envelope is invalid: {exc}") from exc

    record_id = record.get("id")
    if not isinstance(record_id, str) or not record_id:
        message = "The record must carry its cid as a non-empty string in 'id'."
        raise InvalidRecord(
            [{"loc": ["body", "id"], "msg": message, "type": "missing_record_id", "input": None}],
            detail=message,
        )


def _check_body(record: Mapping[str, Any], registration: HandlerRegistration) -> None:
    """Validate the body against its Phase 1 schema when there is one (422)."""
    record_type = registration.record_type
    if not has_schema(record_type):
        # Registered by a module but unknown to the record core: the handler's
        # contract, not the shipped schemas, says what a valid body is.
        return
    errors = validate_body(record_type, record["body"])
    if errors:
        raise InvalidRecord(
            errors,
            detail=f"The {record_type} body is invalid: {errors[0]}",
        )


def _recomputed_id(record: Mapping[str, Any]) -> str:
    """Recompute the record cid and make sure it is the one submitted (422)."""
    try:
        recomputed = compute_record_id(record)
    except (KeyError, TypeError, ValueError) as exc:
        # _check_shape already validated the content fields; this is belt and
        # braces for a value DAG-CBOR cannot encode.
        raise InvalidRecord([str(exc)], detail=f"The record cannot be hashed: {exc}") from exc
    if recomputed != record["id"]:
        raise RecordIdMismatch(record["id"], recomputed)
    return recomputed


def _check_signature(record: Mapping[str, Any]) -> None:
    """Verify ``sig`` against the author's active key (401 problem details)."""
    author = record["author"]
    signature = record.get("sig")
    if not isinstance(signature, str) or not signature:
        raise InvalidRecordSignature(author)
    key = _verification_key(active_signing_key(author))
    if not verify_envelope(record, signature, did_key=key):
        raise InvalidRecordSignature(author)


def _check_not_stored(record_id: str) -> None:
    """Refuse a cid that is already in the log (409 problem details).

    Checked before the handler runs, so a repeated submission cannot make a
    handler act twice; the ledger's UNIQUE constraint still guards the race
    between two simultaneous submissions (see :func:`_append`).
    """
    from app.modules import ledger

    if ledger.entry_by_cid(record_id) is not None:
        raise DuplicateRecord(record_id)


# --------------------------------------------------------------------------- #
# Handler
# --------------------------------------------------------------------------- #


def _state_from(result: Any) -> Optional[str]:
    """Read a state string from whatever a handler returned."""
    if isinstance(result, str):
        return result or None
    if isinstance(result, Mapping):
        state = result.get("state")
        if isinstance(state, str) and state:
            return state
        return None
    state = getattr(result, "state", None)
    return state if isinstance(state, str) and state else None


# --------------------------------------------------------------------------- #
# Short ids
# --------------------------------------------------------------------------- #


def record_short_id(record_type: str, record_id: str, body: Mapping[str, Any]) -> Optional[str]:
    """Return the ``sch:`` id of the paper ``record`` belongs to, if any.

    * ``paper.genesis`` -- its own cid is the paper's genesis, so the short id
      derives from it.
    * ``paper.version`` -- ``body.paper`` names the genesis record; when
      ``body.n`` is a version number the result is the version id
      (``sch:xxxx-xxxx-xxxx/vN``), otherwise the paper id.
    * every other record type -- ``None``: the record core defines short ids
      for papers only.
    """
    if record_type == PAPER_GENESIS_TYPE:
        try:
            return derive_short_id(record_id)
        except ValueError:
            return None
    if record_type == PAPER_VERSION_TYPE:
        paper = body.get("paper")
        if not isinstance(paper, str):
            return None
        try:
            short = derive_short_id(paper)
        except ValueError:
            return None
        version = body.get("n")
        if isinstance(version, bool) or not isinstance(version, int):
            return short
        try:
            return format_version_id(short, version)
        except ValueError:
            return short
    return None


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


def ingest(record: Mapping[str, Any]) -> IngestResult:
    """Validate ``record`` and append it to the ledger; return what was stored.

    Raises :class:`InvalidRecord`, :class:`RecordIdMismatch` (422),
    :class:`UnknownRecordType` (422), :class:`InvalidRecordSignature` (401) or
    :class:`DuplicateRecord` (409).  Any error the handler raises propagates
    unchanged.  Nothing is appended unless every check before the ledger step
    passed.
    """
    if not isinstance(record, Mapping):
        raise InvalidRecord(
            [f"record must be a JSON object, got {type(record).__name__}"],
            detail="The record envelope must be a JSON object.",
        )

    _check_shape(record)
    registration = lookup(record["type"])
    _check_body(record, registration)
    record_id = _recomputed_id(record)
    _check_signature(record)
    _check_not_stored(record_id)

    # A handler gets its own copy: whatever it does with it cannot change the
    # bytes whose hash and signature were just verified (and which the ledger
    # will store under ``record_id``).
    state = _state_from(registration.handler(copy.deepcopy(record))) or DEFAULT_STATE
    _append(record)

    return IngestResult(
        record_id=record_id,
        short_id=record_short_id(record["type"], record_id, record["body"]),
        state=state,
        anchor=ANCHOR_PENDING,
    )


def _append(record: Mapping[str, Any]) -> Any:
    """Append ``record`` to the event log, mapping a duplicate cid to 409.

    The ledger is imported at call time: it is a sibling plugin, and whichever
    of the two the module loader reaches first must not depend on the other
    being importable during app assembly.
    """
    from sqlalchemy.exc import IntegrityError

    from app.modules import ledger

    try:
        return ledger.append(record)
    except IntegrityError as exc:
        raise DuplicateRecord(record.get("id")) from exc
