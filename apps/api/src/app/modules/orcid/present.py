"""``POST /v1/credentials/present``: verify a credential presentation.

Feature 35: a holder presents a verifiable credential (for example the ORCID
ownership credential this node issued in feature 32) and the node answers
whether it is genuine: ``200 {"verified": true}`` when every check passes, or
``422`` problem details naming the check that failed.

The request is deliberately tolerant about how the document is carried, because
presentations reach this node from wallets and from other Scholium nodes, not
only from our own client::

    POST /v1/credentials/present
    Content-Type: application/json

    <the credential document itself>
    {"credential": <vc>}                      # or {"vc": <vc>}
    {"verifiableCredential": <vc> | [<vc>]}   # a W3C VerifiablePresentation
    {"presentation": {"verifiableCredential": [<vc>], "proof": {...}}}

The checks, in order, are the ones the feature names:

``presentation signature``
    When the caller supplies a presentation proof (``proof``/``signature`` on
    the presentation, or a separate ``presentation`` object), that proof must
    verify as an Ed25519 signature by the presenter's ``did:key`` over the
    canonical JSON of the presentation without its ``proof``/``signature``
    members.  A presentation proof that is present but wrong is a refusal --
    silently ignoring it would accept a forgery with a valid inner credential.

``credential signature``
    The credential's own proof (``proof.proofValue``, ``signature`` or
    ``sig``) must verify as an Ed25519 signature by the issuer's key.  Node
    credentials are issued by :mod:`app.modules.orcid.service` as the
    canonical-JSON bytes of the document *before* the proof was attached, so
    that is the preimage tried first; the aliases the issuer adds afterwards
    (``signature``, ``node_did``) are not part of the signed bytes.

``credential status``
    The document's own status must be a current one (``valid``, ``active``,
    ...), it must not have expired, and -- when this node issued it -- the
    ``credentials`` row's status must still be current.  A credential from
    another node has no local row, which is not by itself a failure.

Every failure is RFC 9457 problem details (``application/problem+json``): the
exception carries the ``type``/``errors`` members the app's handler renders,
and the problem's ``errors`` entry names the failing check under ``check``
while ``detail`` names it in prose.
"""

from __future__ import annotations

import binascii
import json
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator, Mapping, Optional, Sequence

from fastapi import APIRouter, Body, HTTPException
from multiformats import multibase
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import BaseModel, ConfigDict
from scholium_record_core import decode_signature, public_key_from_did_key

from app import db
from sqlalchemy import inspect

__all__ = [
    "CREDENTIAL_PRESENTATION_INVALID",
    "CREDENTIAL_SIGNATURE_INVALID",
    "CREDENTIAL_STATUS_INVALID",
    "PRESENT_PATH",
    "InvalidCredentialPresentation",
    "InvalidCredentialSignature",
    "InvalidCredentialStatus",
    "PresentationVerified",
    "router",
    "verify_presentation",
]

#: Router the orcid module includes at ``/credentials`` (so ``/v1/credentials/present``).
router = APIRouter(prefix="/credentials", tags=["credentials"])

#: Absolute path this endpoint serves below the app root.
PRESENT_PATH = "/v1/credentials/present"

#: Problem type for a presentation that is not a credential presentation at all.
CREDENTIAL_PRESENTATION_INVALID = "urn:scholium:problem:credential-presentation-invalid"
#: Problem type for a credential or presentation whose signature does not verify.
CREDENTIAL_SIGNATURE_INVALID = "urn:scholium:problem:credential-signature-invalid"
#: Problem type for a credential whose status is not current.
CREDENTIAL_STATUS_INVALID = "urn:scholium:problem:credential-status-invalid"

#: Status values that mean "still good".  A credential with no status at all is
#: treated as valid: status is optional in the credential documents this node
#: issues, and absence means "no revocation information", not "revoked".
VALID_STATUSES = frozenset(
    {
        "active",
        "current",
        "good",
        "issued",
        "ok",
        "valid",
        "verified",
    }
)

#: Members a signature is never computed over, whichever helper made the doc.
_UNSIGNED_MEMBERS = ("proof", "signature", "sig", "node_did", "proofValue")

_MAX_ECHO = 64


def _show(value: object) -> str:
    """A short, safe rendering of a client-supplied value for a problem detail."""
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= _MAX_ECHO else text[: _MAX_ECHO - 3] + "..."


class _CredentialProblem(HTTPException, ValueError):
    """A ``422`` problem document naming the check that failed.

    It subclasses :class:`fastapi.HTTPException` and sets the members
    ``app.errors``' handler reads (``type``, ``title``, ``errors``), so the
    response is ``application/problem+json``.  ``app.errors`` is deliberately
    not imported here: importing it starts a circular import of ``app.main``
    that leaves the module unregistered when a caller imports this plugin
    before the application factory.
    """

    default_type = CREDENTIAL_PRESENTATION_INVALID
    check = "presentation"

    def __init__(self, message: str, *, check: Optional[str] = None, type_: Optional[str] = None) -> None:
        self.check = check or self.check
        super().__init__(status_code=422, detail=message)
        self.type = type_ or self.default_type
        self.title = "Unprocessable Content"
        self.errors = [
            {
                "loc": ["body"],
                "msg": message,
                "type": self.check,
                "check": self.check,
            }
        ]


class InvalidCredentialPresentation(_CredentialProblem):
    """The request does not carry a verifiable credential presentation: ``422``."""

    default_type = CREDENTIAL_PRESENTATION_INVALID
    check = "presentation"

    def __init__(self, message: str = "The request does not carry a credential presentation.") -> None:
        super().__init__(message)


class InvalidCredentialSignature(_CredentialProblem):
    """A signature does not verify: ``422`` problem details.

    ``check`` is ``"signature"`` for the credential's own proof and
    ``"presentation_signature"`` when it was the presentation's proof.
    """

    default_type = CREDENTIAL_SIGNATURE_INVALID
    check = "signature"

    def __init__(self, message: str, *, check: str = "signature") -> None:
        super().__init__(message, check=check)


class InvalidCredentialStatus(_CredentialProblem):
    """The credential is not current: ``422`` problem details."""

    default_type = CREDENTIAL_STATUS_INVALID
    check = "status"

    def __init__(self, message: str) -> None:
        super().__init__(message)


class PresentationVerified(BaseModel):
    """The ``200`` body of ``POST /v1/credentials/present``."""

    model_config = ConfigDict(extra="forbid")

    #: ``True``: every signature and status check passed.
    verified: bool = True


# --------------------------------------------------------------------------- #
# Extracting documents from the request
# --------------------------------------------------------------------------- #


def _as_mapping(value: Any) -> Optional[dict[str, Any]]:
    """Return ``value`` as a JSON object, parsing a JSON string if needed."""
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, (str, bytes, bytearray)):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return None
        return dict(parsed) if isinstance(parsed, Mapping) else None
    return None


def _types(document: Mapping[str, Any]) -> set[str]:
    value = document.get("type")
    if isinstance(value, str):
        return {value}
    if isinstance(value, (list, tuple, set)):
        return {item for item in value if isinstance(item, str)}
    return set()


def _is_presentation(document: Mapping[str, Any]) -> bool:
    return "VerifiablePresentation" in _types(document) or "verifiableCredential" in document


def _is_credential(document: Mapping[str, Any]) -> bool:
    return "credentialSubject" in document or "VerifiableCredential" in _types(document)


def _credential_values(value: Any) -> Iterator[dict[str, Any]]:
    """Yield credential objects from a single value, a list or a JSON string."""
    if isinstance(value, (list, tuple)):
        for item in value:
            document = _as_mapping(item)
            if document is not None:
                yield document
        return
    document = _as_mapping(value)
    if document is not None:
        yield document


def _extract(payload: Any) -> tuple[list[dict[str, Any]], Optional[dict[str, Any]]]:
    """Return ``(credentials, presentation)`` from any accepted request shape."""
    body = _as_mapping(payload)
    if body is None:
        if isinstance(payload, (list, tuple)):
            credentials = list(_credential_values(payload))
            if credentials:
                return credentials, None
        raise InvalidCredentialPresentation()

    presentation: Optional[dict[str, Any]] = None
    nested = _as_mapping(body.get("presentation"))
    if nested is not None:
        presentation = nested
    elif _is_presentation(body):
        presentation = body

    source = presentation if presentation is not None else body
    raw = source.get("verifiableCredential")
    if raw is None:
        raw = source.get("credential")
    if raw is None and source is not body:
        # A wrapper may put the credential next to the presentation object.
        raw = body.get("verifiableCredential", body.get("credential"))
    if raw is None:
        raw = body.get("vc")

    credentials = list(_credential_values(raw)) if raw is not None else []
    if not credentials and presentation is None and _is_credential(body):
        credentials = [body]

    if not credentials:
        raise InvalidCredentialPresentation(
            "The request does not carry a credential to verify. Send the credential "
            "document, or a presentation with 'verifiableCredential' or 'credential'."
        )
    return credentials, presentation


def _presentation_document(
    body: Any,
    presentation: Optional[dict[str, Any]],
    credentials: Sequence[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    """Return the document whose proof signs the presentation, if there is one.

    A presentation proof is *not* the credential's own proof: when the request
    is the credential itself, its ``proof`` belongs to the issuance and must be
    verified as such.  The presentation document is therefore the explicit
    ``presentation`` object, or the wrapper around a nested credential.
    """
    if presentation is not None:
        return presentation
    body_map = _as_mapping(body)
    if body_map is None:
        return None
    if credentials and not _is_credential(body_map) and (
        "proof" in body_map or "signature" in body_map
    ):
        return body_map
    return None


# --------------------------------------------------------------------------- #
# Signatures
# --------------------------------------------------------------------------- #


def _canonical(document: Mapping[str, Any], *, ensure_ascii: bool = True) -> bytes:
    """The canonical JSON bytes this node signs credentials with."""
    return json.dumps(
        document,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=ensure_ascii,
        default=str,
    ).encode("utf-8")


def _did_from_reference(reference: Any) -> Optional[str]:
    """Return the DID part of a verification-method reference (``did:key:z...#key-1``)."""
    if isinstance(reference, Mapping):
        reference = reference.get("id", reference.get("controller"))
    if not isinstance(reference, str):
        return None
    did = reference.split("#", 1)[0].strip()
    return did or None


def _did_value(value: Any) -> Optional[str]:
    """Return a DID from a string or an ``{"id": ...}`` object."""
    if isinstance(value, Mapping):
        value = value.get("id") or value.get("did")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _proofs(document: Mapping[str, Any]) -> list[dict[str, Any]]:
    proof = document.get("proof")
    if isinstance(proof, Mapping):
        return [dict(proof)]
    if isinstance(proof, (list, tuple)):
        return [dict(item) for item in proof if isinstance(item, Mapping)]
    return []


def _signature_texts(document: Mapping[str, Any], proof: Optional[Mapping[str, Any]] = None) -> list[str]:
    """Every signature spelling carried by ``document`` and an optional ``proof``."""
    values: list[str] = []
    for source in (proof or {}, document):
        for key in ("proofValue", "signatureValue", "jws", "signature", "sig"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                values.append(value.strip())
    return values


def _raw_signatures(value: str) -> Iterator[bytes]:
    """Decode a signature's accepted spellings into raw Ed25519 bytes."""
    candidates = [value]
    # A detached compact JWS is "header..signature"; the signature is the last part.
    if value.count(".") == 2:
        candidates.append(value.rsplit(".", 1)[-1])
    for candidate in candidates:
        try:
            yield decode_signature(candidate)
        except ValueError:
            pass
        if candidate.startswith("z"):
            try:
                raw = bytes(multibase.decode(candidate))
            except Exception:
                raw = b""
            if len(raw) == 64:
                yield raw
        if len(candidate) == 128:
            try:
                raw = bytes.fromhex(candidate)
            except (binascii.Error, ValueError):
                raw = b""
            if len(raw) == 64:
                yield raw


def _verifies(preimage: bytes, signature: str, dids: Iterable[str]) -> bool:
    """True when ``signature`` authenticates ``preimage`` under any of ``dids``."""
    for did in dids:
        try:
            public_key = public_key_from_did_key(did)
        except (ValueError, TypeError):
            continue
        for raw in _raw_signatures(signature):
            try:
                VerifyKey(public_key).verify(preimage, raw)
            except (BadSignatureError, ValueError):
                continue
            return True
    return False


#: Status-related members.  They are added to a credential *after* issuance, so
#: the issuer's signature does not cover them; they are checked separately by
#: :func:`_check_status` instead.
_STATUS_MEMBERS = (
    "status",
    "credentialStatus",
    "expirationDate",
    "expires",
    "validUntil",
    "revoked",
    "valid",
)


def _candidate_preimages(document: Mapping[str, Any]) -> Iterator[bytes]:
    """The byte strings a credential or presentation may have been signed over.

    The issuer signs the document before attaching the proof and before any
    status information, so the status members are stripped as well; the
    variants that keep them cover issuers that do sign their status.
    """
    base = {key: value for key, value in document.items() if key not in _UNSIGNED_MEMBERS}
    without_status = {
        key: value for key, value in base.items() if key not in _STATUS_MEMBERS
    }
    seen: set[bytes] = set()
    for encoding in (True, False):
        for candidate in (
            without_status,
            base,
            {key: value for key, value in document.items() if key not in ("proof", "signature")},
            {key: value for key, value in document.items() if key != "proof"},
        ):
            preimage = _canonical(candidate, ensure_ascii=encoding)
            if preimage not in seen:
                seen.add(preimage)
                yield preimage


def _presenter_dids(document: Mapping[str, Any], proofs: Sequence[Mapping[str, Any]]) -> list[str]:
    """The DIDs a presentation proof may be signed by, most specific first."""
    dids: list[str] = []
    for proof in proofs:
        for key in (
            "verificationMethod",
            "verification_method",
            "keyId",
            "controller",
            "signer",
            "holder",
            "did",
        ):
            did = _did_from_reference(proof.get(key))
            if did and did not in dids:
                dids.append(did)
    for key in ("holder", "presenter", "did", "subject"):
        did = _did_value(document.get(key))
        if did and did not in dids:
            dids.append(did)
    return dids


def _issuer_dids(credential: Mapping[str, Any], proofs: Sequence[Mapping[str, Any]]) -> list[str]:
    """The DIDs a credential proof may be signed by, most specific first."""
    dids: list[str] = []
    for proof in proofs:
        for key in ("verificationMethod", "verification_method", "keyId", "signer"):
            did = _did_from_reference(proof.get(key))
            if did and did not in dids:
                dids.append(did)
    for key in ("issuer", "node_did"):
        did = _did_value(credential.get(key))
        if did and did not in dids:
            dids.append(did)
    return dids


def _signature_groups(
    document: Mapping[str, Any],
    proofs: Sequence[Mapping[str, Any]],
) -> list[list[str]]:
    """Every signature spelling that must verify, grouped by its proof.

    A proof may carry more than one spelling (``proofValue`` and ``jws``, say),
    and the issuer also copies the value to a top-level ``signature`` alias;
    any spelling that is present must verify, so replacing one of them with
    garbage cannot hide behind another intact copy.
    """
    groups: list[list[str]] = []
    for proof in proofs:
        values = _signature_texts({}, proof)
        if values:
            groups.append(values)
    aliases = _signature_texts(document)
    if aliases:
        already = {value for group in groups for value in group}
        remaining = [value for value in aliases if value not in already]
        if remaining:
            groups.append(remaining)
    return groups


def _presentation_preimages(
    presentation: Mapping[str, Any],
    credentials: Sequence[Mapping[str, Any]],
) -> Iterator[bytes]:
    """The byte strings a presentation proof may authenticate.

    The presentation itself is tried first.  A signer that puts the credential
    next to a detached holder signature signs the credential document instead,
    so those are accepted too; and a proof of possession scoped to a
    ``challenge``/``nonce`` is allowed to sign that value.
    """
    yield from _candidate_preimages(presentation)
    for credential in credentials:
        yield from _candidate_preimages(credential)
    for key in ("challenge", "nonce"):
        challenge = presentation.get(key)
        if isinstance(challenge, str) and challenge:
            yield challenge.encode("utf-8")


def _verify_presentation_signature(
    presentation: Mapping[str, Any],
    credentials: Sequence[Mapping[str, Any]],
) -> None:
    """Refuse a presentation whose supplied proof does not verify."""
    proofs = _proofs(presentation)
    if not proofs and isinstance(presentation.get("signature"), str):
        proofs = [
            {
                "proofValue": presentation["signature"],
                "verificationMethod": presentation.get("holder") or presentation.get("did"),
            }
        ]
    if not proofs:
        return

    dids = _presenter_dids(presentation, proofs)
    if not dids:
        raise InvalidCredentialSignature(
            "The presentation proof names no did:key to verify it against.",
            check="presentation_signature",
        )

    groups = _signature_groups(presentation, proofs)
    if not groups:
        raise InvalidCredentialSignature(
            "The presentation carries no signature to verify.",
            check="presentation_signature",
        )

    preimages = list(_presentation_preimages(presentation, credentials))
    for group in groups:
        for signature in group:
            if not any(_verifies(preimage, signature, dids) for preimage in preimages):
                raise InvalidCredentialSignature(
                    "The presentation signature does not verify.",
                    check="presentation_signature",
                )


def _verify_credential_signature(credential: Mapping[str, Any]) -> None:
    """Refuse a credential whose proof does not verify against its issuer."""
    proofs = _proofs(credential)
    groups = _signature_groups(credential, proofs)
    if not groups:
        raise InvalidCredentialSignature("The credential carries no signature to verify.")

    dids = _issuer_dids(credential, proofs)
    if not dids:
        raise InvalidCredentialSignature(
            "The credential names no did:key issuer to verify its signature against."
        )

    preimages = list(_candidate_preimages(credential))
    for group in groups:
        for signature in group:
            if not any(_verifies(preimage, signature, dids) for preimage in preimages):
                raise InvalidCredentialSignature("The credential signature does not verify.")


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #


def _status_value(value: Any) -> Optional[str]:
    """Return a status string from a status member, or ``None`` if it says nothing."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        for key in ("status", "statusValue", "state"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        if value.get("revoked") is True:
            return "revoked"
        if value.get("valid") is False:
            return "invalid"
    if value is False:
        return "invalid"
    if value is True:
        return "valid"
    return None


def _declared_status(credential: Mapping[str, Any]) -> Optional[str]:
    """The status the document itself declares, if any."""
    for key in ("status", "credentialStatus"):
        if key in credential:
            status = _status_value(credential[key])
            if status is not None:
                return status
    if credential.get("revoked") is True:
        return "revoked"
    if credential.get("valid") is False:
        return "invalid"
    return None


def _parse_instant(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601 timestamp into an aware UTC datetime, if possible."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _expired(credential: Mapping[str, Any], now: Optional[datetime] = None) -> bool:
    """True when the credential declares an expiration instant that has passed."""
    moment = now or datetime.now(timezone.utc)
    for key in ("expirationDate", "expires", "validUntil"):
        expires = _parse_instant(credential.get(key))
        if expires is not None and expires <= moment:
            return True
    return False


def _subject_did(credential: Mapping[str, Any]) -> Optional[str]:
    subject = credential.get("credentialSubject")
    if isinstance(subject, Mapping):
        return _did_value(subject)
    return _did_value(subject)


def _matching_stored_status(credential: Mapping[str, Any]) -> Optional[str]:
    """The ``credentials`` row's status for ``credential``, when this node issued it.

    Issued credentials carry no ``id``, so rows are matched by subject DID and
    then by the credential's own signature (which is unique per issuance).  A
    missing table or row is not a failure: the credential may come from another
    node.
    """
    credential_id = credential.get("id")
    subject = _subject_did(credential)
    signatures = set(_signature_texts(credential, _proofs(credential)[0] if _proofs(credential) else None))

    try:
        if not inspect(db.engine).has_table("credentials"):
            return None
        from .models import Credential

        with db.SessionLocal() as session:
            query = session.query(Credential)
            if isinstance(credential_id, str) and credential_id.strip():
                row = query.filter(Credential.id == credential_id.strip()).first()
                if row is not None:
                    return row.status
            rows = query.all() if subject is None else query.filter(Credential.did == subject).all()
    except Exception:  # a database that cannot answer is not a bad credential
        return None

    for row in rows:
        try:
            stored = json.loads(row.vc)
        except (TypeError, ValueError):
            continue
        if not isinstance(stored, Mapping):
            continue
        if stored == dict(credential):
            return row.status
        if signatures and set(_signature_texts(stored)) & signatures:
            return row.status
    return None


def _check_status(credential: Mapping[str, Any]) -> None:
    """Refuse a credential that is revoked, expired or otherwise not current."""
    declared = _declared_status(credential)
    if declared is not None and declared.casefold() not in VALID_STATUSES:
        raise InvalidCredentialStatus(
            f"The credential status {_show(declared)!r} is not valid."
        )

    if _expired(credential):
        raise InvalidCredentialStatus("The credential has expired.")

    stored = _matching_stored_status(credential)
    if stored is not None and str(stored).strip().casefold() not in VALID_STATUSES:
        raise InvalidCredentialStatus(
            f"The credential status {_show(stored)!r} is not valid."
        )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def verify_presentation(payload: Any) -> bool:
    """Verify every credential in ``payload``; return ``True`` or raise ``422``.

    Raises :class:`InvalidCredentialPresentation`, :class:`InvalidCredentialSignature`
    or :class:`InvalidCredentialStatus` -- each a ``422`` HTTP exception carrying
    the problem members FastAPI's handler renders.
    """
    credentials, presentation = _extract(payload)
    presentation_document = _presentation_document(payload, presentation, credentials)

    if presentation_document is not None:
        _verify_presentation_signature(presentation_document, credentials)

    for credential in credentials:
        _verify_credential_signature(credential)
        _check_status(credential)
    return True


@router.post(
    "/present",
    response_model=PresentationVerified,
    summary="Verify a credential presentation's signatures and status",
)
def present_credential(
    payload: Any = Body(..., description="The credential presentation to verify."),
) -> PresentationVerified:
    """Return ``{"verified": true}``, or ``422`` problem details for the failing check."""
    verify_presentation(payload)
    return PresentationVerified()
