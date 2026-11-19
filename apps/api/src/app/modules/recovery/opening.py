"""Opening a recovery request (plugin: recovery).

Feature 38: an account holder who has lost their key asks their guardians to
recover the account.  They cannot sign in -- that is the point -- so the request
is identified by the one thing they still have, their ORCID iD, together with
the public key the account should move to::

    POST /v1/recovery/requests
    {"orcid": "0000-0002-1825-0097", "new_public_key": "did:key:z6Mk..."}

    201 Created
    {"request_id": "rec_...", "status": "pending", "guardians_notified": 5}

Opening a request:

1. checks the body (:func:`normalize_orcid`, :func:`~.rotation.validate_new_key`)
   and reports every fault at once;
2. finds the account the ORCID iD is linked to (:func:`find_account_by_orcid`),
   through the ORCID ownership credential the orcid plugin issued it;
3. requires that account to have its full set of guardians, since nobody else
   can approve the recovery;
4. saves the request to ``recovery_requests`` -- ``pending``, no approvals yet,
   no contest window -- and only then
5. notifies each guardian (``kind`` :data:`NOTIFICATION_KIND`) with what they
   need to recognise the person asking and approve.

Several requests for one account may be open at once, and each is approved on
its own.  That is deliberate: if opening a second one were refused, anyone who
knows an ORCID iD (they are public) could squat on the account's recovery by
opening a bogus request first.  Guardians see the new key in the notification
and approve only the one they trust.

The endpoint is open to anyone, so it answers as little as it can: the account's
DID and guardians are never returned, and the ORCID iD is not echoed in errors.
Abuse is bounded by the app-wide anonymous write throttle.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from sqlalchemy import Column, MetaData, Table, Text, func, inspect, select

from app import db
from app.modules.notifications import notify

from .approvals import CONTEST_WINDOW
from .models import REQUEST_PENDING, RecoveryRequest, ensure_requests_table
from .rotation import InvalidNewKey, validate_new_key
from .service import GUARDIAN_COUNT, get_guardians

__all__ = [
    "NOTIFICATION_KIND",
    "InvalidOrcid",
    "InvalidRecoveryRequest",
    "NoGuardians",
    "OpenedRequest",
    "UnknownAccount",
    "find_account_by_orcid",
    "normalize_orcid",
    "open_recovery_request",
]

logger = logging.getLogger(__name__)

#: The ``kind`` of the notification each guardian and the account itself receives.
NOTIFICATION_KIND = "recovery.request"

#: The safety window's length in whole hours, for the notice the owner receives.
SAFETY_WINDOW_HOURS = int(CONTEST_WINDOW.total_seconds() // 3600)

#: A bare ORCID iD: four groups of four digits, the last character being the
#: MOD 11-2 checksum, which may be ``X``.  The checksum itself is not verified:
#: the iD only has to match one the node issued a credential for.
_ORCID = re.compile(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]")

#: ``https://orcid.org/<id>`` (any scheme, host or sandbox) is how ORCID itself
#: writes an iD; accept it and reduce it to the bare form.
_ORCID_URL_PREFIX = re.compile(r"^(?:https?://)?(?:www\.|sandbox\.)?orcid\.org/", re.IGNORECASE)

#: Credential statuses that no longer vouch for the link between an iD and a DID.
_WITHDRAWN_STATUSES = frozenset({"revoked", "suspended"})

# The ``credentials`` table belongs to the orcid plugin.  Mirrored here, read
# only, into a private MetaData (the same approach the profiles plugin takes) so
# this plugin neither depends on that one being importable nor collides with its
# declarative model.
_foreign_metadata = MetaData()
_credentials = Table(
    "credentials",
    _foreign_metadata,
    Column("id", Text, primary_key=True),
    Column("did", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("vc", Text, nullable=False),
    Column("status", Text, nullable=False),
)


class InvalidOrcid(ValueError):
    """The text is not an ORCID iD."""


class InvalidRecoveryRequest(ValueError):
    """The request body is not well formed; :attr:`problems` lists every fault.

    Each problem is a FastAPI-style error entry: ``loc``, ``msg`` and ``type``.
    """

    def __init__(self, problems: Sequence[dict[str, Any]]) -> None:
        self.problems = list(problems)
        super().__init__("; ".join(problem["msg"] for problem in self.problems))


class UnknownAccount(LookupError):
    """No account is linked to the ORCID iD."""


class NoGuardians(RuntimeError):
    """The account has no complete guardian set, so nobody could approve a recovery."""


@dataclass(frozen=True)
class OpenedRequest:
    """A recovery request as saved.

    ``did`` is the account being recovered.  It is for the server's own use
    (the router never returns it): the endpoint is open, so it must not turn
    an ORCID iD into a DID for whoever asks.
    """

    request_id: str
    did: str
    new_public_key: str
    status: str
    guardians_notified: int


def normalize_orcid(value: Any) -> str:
    """Return ``value`` as a bare ORCID iD (``0000-0002-1825-0097``).

    Surrounding whitespace, an ``https://orcid.org/`` prefix and a lowercase
    check ``x`` are all accepted.  Raises :class:`InvalidOrcid` for anything
    that is not an iD.
    """
    if not isinstance(value, str):
        raise InvalidOrcid("'orcid' must be a string.")
    text = _ORCID_URL_PREFIX.sub("", value.strip()).upper()
    if not _ORCID.fullmatch(text):
        raise InvalidOrcid("'orcid' must be an ORCID iD such as 0000-0002-1825-0097.")
    return text


def _decode_vc(cell: Any) -> Optional[dict[str, Any]]:
    """The credential document in a ``vc`` cell, or ``None`` if it holds none.

    One malformed credential must not stop another account being found, so
    anything undecodable reads as "no document".
    """
    if isinstance(cell, (bytes, bytearray)):
        cell = bytes(cell).decode("utf-8", "replace")
    try:
        document = json.loads(cell) if isinstance(cell, str) else cell
        if isinstance(document, str):  # double-encoded JSON
            document = json.loads(document)
    except ValueError:
        return None
    return document if isinstance(document, dict) else None


def find_account_by_orcid(orcid: str) -> Optional[str]:
    """Return the DID the ORCID iD ``orcid`` is linked to, or ``None``.

    The link is the ORCID ownership credential the node issued for the DID
    (``credentials`` table, ``kind`` ``orcid``) whose subject carries the iD.
    Withdrawn credentials (``revoked``, ``suspended``) and ones that bind the
    iD to a different DID than their row's are ignored.

    Nothing yet limits an iD to one account, so when several carry it the most
    recently issued credential wins, and of two issued in the same second the
    one stored later.
    """
    if not inspect(db.engine).has_table(_credentials.name):
        return None

    # The iD is digits, hyphens and maybe an X: nothing LIKE treats specially.
    # LIKE ignores ASCII case on SQLite and not on PostgreSQL, so both sides are
    # lowered: the check character is accepted as ``x`` or ``X`` below, and the
    # candidates this narrows to must not depend on the dialect. The exact
    # comparison is the one after the decode.
    query = select(_credentials.c.did, _credentials.c.vc, _credentials.c.status).where(
        func.lower(_credentials.c.kind).contains("orcid"),
        func.lower(_credentials.c.vc).contains(orcid.lower()),
    )
    with db.engine.connect() as conn:
        rows = list(conn.execute(query))

    best: Optional[tuple[str, str]] = None  # (issuance date, did)
    for did, vc, status in rows:
        if isinstance(status, str) and status.strip().lower() in _WITHDRAWN_STATUSES:
            continue
        document = _decode_vc(vc)
        subject = document.get("credentialSubject") if document else None
        if not isinstance(subject, dict):
            continue
        try:
            linked = normalize_orcid(subject.get("orcid"))
        except InvalidOrcid:
            continue
        subject_did = subject.get("id")
        if linked != orcid or (isinstance(subject_did, str) and subject_did != did):
            continue
        issued = document.get("issuanceDate")
        candidate = (issued if isinstance(issued, str) else "", did)
        # ``>=``: rows come back in storage order, so a tie goes to the later row.
        if best is None or candidate[0] >= best[0]:
            best = candidate
    return None if best is None else best[1]


def _validate_body(orcid: Any, new_public_key: Any) -> tuple[str, str]:
    """Return the normalized ORCID iD and the new key, or raise naming every fault."""
    problems: list[dict[str, Any]] = []
    normalized = ""
    try:
        normalized = normalize_orcid(orcid)
    except InvalidOrcid as exc:
        problems.append({"loc": ["body", "orcid"], "msg": str(exc), "type": "invalid_orcid"})
    try:
        key = validate_new_key(new_public_key)
    except InvalidNewKey as exc:
        key = ""
        message = str(exc).replace("'newKey'", "'new_public_key'")
        problems.append({"loc": ["body", "new_public_key"], "msg": message, "type": "invalid_new_key"})
    if problems:
        raise InvalidRecoveryRequest(problems)
    return normalized, key


def _account_profile(did: str) -> tuple[Any, Optional[str]]:
    """Return ``(name, verified_email)`` for ``did``'s profile, best-effort.

    The email is returned only when the profile's address has been verified, so
    an unverified address never receives a recovery notice.
    """
    name = None
    email = None
    try:
        from app.modules.profiles import email_verified, read_profile

        profile = read_profile(did)
        if profile is not None:
            name = getattr(profile, "name", None)
            if email_verified(did):
                raw = getattr(profile, "email", None)
                if isinstance(raw, str) and raw.strip():
                    email = raw.strip()
    except Exception:
        name = None
        email = None
    return name, email


def _notify_account_owner(
    did: str, request_id: str, orcid: str, new_public_key: str
) -> None:
    """Tell the account itself that a recovery was started.

    The owner may still hold their device, so this is the only way they learn
    about a recovery they did not start within the safety window.  A failure
    here is logged and never undoes the request or the guardian notifications.
    """
    account_name, account_email = _account_profile(did)
    payload = {
        "request_id": request_id,
        "account_did": did,
        "account_name": account_name,
        "name": account_name,
        "orcid": orcid,
        "new_public_key": new_public_key,
        "requested_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "approvals_path": f"/v1/recovery/requests/{request_id}/approvals",
        "security_path": "/me/security",
        "cancel_path": "/me/security",
        # The window opens when the third guardian approves, so its end cannot
        # be named here; the owner is told how long it will last instead.
        "safety_window_hours": SAFETY_WINDOW_HOURS,
        "link": "/me/security",
    }
    if account_email is not None:
        payload["email"] = account_email
    try:
        notify(did, NOTIFICATION_KIND, payload)
    except Exception:
        logger.exception("could not notify account %s of recovery request %s", did, request_id)


def _notify_guardians(
    guardians: Sequence[str], request_id: str, did: str, orcid: str, new_public_key: str
) -> int:
    """Notify every guardian of the request; return how many were notified.

    The request is already saved and the person asking is locked out, so one
    guardian's notification failing must neither undo it nor stop the others
    being told.
    """
    account_name, _account_email = _account_profile(did)
    payload = {
        "request_id": request_id,
        "account_did": did,
        "account_name": account_name,
        "name": account_name,
        "orcid": orcid,
        "new_public_key": new_public_key,
        "requested_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "approvals_path": f"/v1/recovery/requests/{request_id}/approvals",
    }
    notified = 0
    for guardian in guardians:
        try:
            notify(guardian, NOTIFICATION_KIND, payload)
        except Exception:
            logger.exception("could not notify guardian %s of recovery request %s", guardian, request_id)
        else:
            notified += 1
    return notified


def open_recovery_request(orcid: Any, new_public_key: Any) -> OpenedRequest:
    """Open a request to recover the account linked to ``orcid`` onto ``new_public_key``.

    Raises :class:`InvalidRecoveryRequest` (a field is malformed),
    :class:`UnknownAccount` (no account is linked to the iD) or
    :class:`NoGuardians` (the account never set its guardians); in each case
    nothing is saved and nobody is notified.
    """
    orcid, new_public_key = _validate_body(orcid, new_public_key)

    did = find_account_by_orcid(orcid)
    if did is None:
        raise UnknownAccount(orcid)
    guardians = get_guardians(did)
    if len(guardians) != GUARDIAN_COUNT:
        raise NoGuardians(did)

    request_id = f"rec_{uuid.uuid4().hex}"
    ensure_requests_table()
    with db.SessionLocal() as session:
        session.add(
            RecoveryRequest(
                id=request_id,
                did=did,
                new_public_key=new_public_key,
                approvals=[],
                contest_until=None,
                status=REQUEST_PENDING,
            )
        )
        session.commit()

    notified = _notify_guardians(guardians, request_id, did, orcid, new_public_key)
    _notify_account_owner(did, request_id, orcid, new_public_key)
    return OpenedRequest(
        request_id=request_id,
        did=did,
        new_public_key=new_public_key,
        status=REQUEST_PENDING,
        guardians_notified=notified,
    )
