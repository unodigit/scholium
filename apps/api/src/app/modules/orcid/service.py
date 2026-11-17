"""Issuing ORCID ownership verifiable credentials (plugin: orcid).

``issue_orcid_credential(did, orcid_id)`` builds a node-signed ORCID
ownership verifiable credential bound to ``did``, persists it to the
``credentials`` table and returns the credential document.  ``exchange_code``
turns an authorization ``code`` (a mock code when ``ORCID_MOCK=1``) into the
ORCID iD it carries.

Issuing also claims the iD's uniqueness nullifier (feature 33,
:mod:`app.modules.orcid.nullifier`) in the same transaction as the credential
row, so one ORCID iD maps to one active DID: linking an iD that is already
linked raises :class:`~app.modules.orcid.nullifier.OrcidAlreadyLinked` (``409``
problem details) and writes nothing.

Once the credential is committed, linking is the last onboarding step a Reader
needs for tier 1: :func:`~app.modules.orcid.promotion.promote_if_eligible`
saves a Member tier to the account when the owner's email has also been
verified (feature 34).  That check is best-effort -- the credential stays
linked even if it fails.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx

from app import db
from app.settings import settings

from .models import Credential, ensure_tables
from .nullifier import OrcidAlreadyLinked, claim_nullifier, compute_nullifier
from .promotion import promote_if_eligible
from .state import InvalidState, verify_state

# re-export for router convenience
__all__ = [
    "InvalidState",
    "OrcidAlreadyLinked",
    "exchange_code",
    "issue_orcid_credential",
    "verify_state",
]

from app.modules.ledger.origin import node_signing_key, did_key_from_public_key
from scholium_record_core import encode_signature

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def exchange_code(code: str, *, redirect_uri: Optional[str] = None) -> str:
    """Return the ORCID iD an authorization ``code`` resolves to.

    With ``ORCID_MOCK=1`` (the default) only ``mock-<orcid>`` codes are
    accepted and the iD is taken from the code.  The mock consent page only
    issues checksum-valid iDs (and refuses to approve a typed one that is
    not); this exchange then accepts the spellings an iD is commonly written
    in, leaving canonicalisation to the nullifier.  Otherwise the code is
    exchanged with ORCID's token endpoint.
    """
    if not isinstance(code, str) or not code.strip():
        raise ValueError("authorization code is required")

    if settings.ORCID_MOCK:
        prefix = "mock-"
        if not code.startswith(prefix):
            raise ValueError("ORCID is in mock mode: code must be 'mock-<orcid>'")
        orcid_id = code[len(prefix):].strip()
        if not orcid_id:
            raise ValueError("mock code carries no ORCID iD")
        return orcid_id

    from .router import orcid_base_url

    data = {
        "client_id": settings.ORCID_CLIENT_ID,
        "client_secret": settings.ORCID_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
    }
    if redirect_uri:
        data["redirect_uri"] = redirect_uri

    with httpx.Client(timeout=15.0) as client:
        response = client.post(f"{orcid_base_url()}/oauth/token", data=data)
        response.raise_for_status()
        payload = response.json()

    orcid_id = payload.get("orcid") or payload.get("id")
    if not orcid_id:
        raise ValueError("ORCID token response carried no orcid")
    return str(orcid_id)


def issue_orcid_credential(did: str, orcid_id: str) -> dict:
    """Build, sign with the node key and persist an ORCID ownership VC for ``did``.

    Raises :class:`OrcidAlreadyLinked` (``409``) when ``orcid_id`` is already
    linked to an active DID -- ``did`` itself included -- and stores nothing.
    """
    if not isinstance(did, str) or not did.strip():
        raise ValueError("a non-empty did is required")
    if not isinstance(orcid_id, str) or not orcid_id.strip():
        raise ValueError("a non-empty orcid id is required")

    ensure_tables()

    key = node_signing_key()
    if key is None:
        raise RuntimeError("node signing key is unavailable")

    node_did = did_key_from_public_key(bytes(key.verify_key))
    now_iso = _now_iso()

    subject = {"id": did, "orcid": orcid_id}
    credential = {
        "@context": "https://www.w3.org/2018/credentials/v1",
        "type": ["VerifiableCredential", "OrcidOwnershipCredential"],
        "issuer": node_did,
        "issuanceDate": now_iso,
        "credentialSubject": subject,
    }

    # Sign the canonical form of the credential (without the proof).
    message = json.dumps(credential, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = encode_signature(bytes(key.sign(message).signature))

    credential["proof"] = {
        "type": "Ed25519Signature2020",
        "created": now_iso,
        "verificationMethod": f"{node_did}#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": signature,
    }
    # Convenience aliases a verifier might look for.
    credential["signature"] = signature
    credential["node_did"] = node_did

    cred_id = f"cred_{uuid.uuid4().hex}"
    nullifier = compute_nullifier(node_did, orcid_id)
    with db.SessionLocal() as session:
        # Claim first, commit together: no nullifier without its credential.
        claim_nullifier(session, nullifier, did, orcid_id=orcid_id)
        session.add(
            Credential(
                id=cred_id,
                did=did,
                kind="orcid",
                vc=json.dumps(credential),
                status="valid",
            )
        )
        session.commit()

    # Both tier-1 conditions now hold only if the email was already verified;
    # the link itself is a success either way, so a failed check is logged, not
    # raised (feature 34).
    try:
        promote_if_eligible(did)
    except Exception:
        logger.exception("could not promote %s to tier 1 after linking an ORCID iD", did)

    return credential
