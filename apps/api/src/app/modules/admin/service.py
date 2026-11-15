"""Change an account's trust tier (plugin: admin).

This module deliberately does not import ``app.modules.identity``: that
package pulls in the ``scholium_record_core`` workspace package, which a plain
``uv run python -m app.modules.admin`` (no ``--all-packages``) does not install.
Instead it carries a small mirror of the ``accounts`` table and of the did:key
check, and the tests pin both to the identity plugin's versions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from multiformats import multibase
from sqlalchemy import Column, DateTime, Integer, MetaData, Table, Text, inspect, insert, select, update
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError

from app import db
from app.security import Tier

__all__ = ["InvalidDid", "TierChange", "parse_tier", "set_tier", "validate_did"]

_ED25519_MULTICODEC = b"\xed\x01"
_ED25519_KEY_LENGTH = 32
_DID_KEY_PREFIX = "did:key:"

# Mirrors identity.models.Account; a separate MetaData so it never collides with
# the identity plugin's declarative model when both are loaded in one process.
_metadata = MetaData()
accounts = Table(
    "accounts",
    _metadata,
    Column("did", Text, primary_key=True),
    Column("tier", Integer, nullable=False, default=0, server_default="0"),
    Column("created_at", DateTime, nullable=False),
)


class InvalidDid(ValueError):
    """The value is not a canonical Ed25519 did:key identifier."""


@dataclass(frozen=True)
class TierChange:
    """The outcome of :func:`set_tier`."""

    did: str
    #: The tier the account had before, or ``None`` if the DID had no account
    #: row yet and one was created.
    previous_tier: Optional[int]
    tier: int

    @property
    def created(self) -> bool:
        return self.previous_tier is None


def validate_did(did: object) -> str:
    """Return ``did`` if it is a canonical Ed25519 did:key, else raise ``InvalidDid``."""
    if not isinstance(did, str):
        raise InvalidDid("a did:key identifier must be a string")
    if not did.startswith(_DID_KEY_PREFIX + "z"):
        raise InvalidDid("not a valid Ed25519 did:key identifier")
    try:
        decoded = multibase.decode(did[len(_DID_KEY_PREFIX) :])
    except Exception:  # multibase raises several exception types for bad input
        raise InvalidDid("not a valid Ed25519 did:key identifier") from None
    if len(decoded) != len(_ED25519_MULTICODEC) + _ED25519_KEY_LENGTH or not decoded.startswith(
        _ED25519_MULTICODEC
    ):
        raise InvalidDid("not a valid Ed25519 did:key identifier")
    if _DID_KEY_PREFIX + multibase.encode(decoded, "base58btc") != did:
        raise InvalidDid("not a canonical Ed25519 did:key identifier")
    return did


def parse_tier(value: object) -> int:
    """Return the trust tier named by ``value``.

    Accepts the integer 0-4 (as an int or a string of digits) or a tier name
    such as ``moderator`` (case-insensitive). Raises ``ValueError`` otherwise.
    """
    text = str(value).strip()
    try:
        return int(Tier(int(text)))
    except ValueError:
        pass
    try:
        return int(Tier[text.upper()])
    except KeyError:
        pass
    names = ", ".join(t.name.lower() for t in Tier)
    raise ValueError(
        f"not a trust tier: {value!r} (use {int(min(Tier))}-{int(max(Tier))} or one of: {names})"
    )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ensure_accounts_table() -> None:
    try:
        accounts.create(bind=db.engine, checkfirst=True)
    except (OperationalError, ProgrammingError):
        # Lost a creation race with another process; fine if the table is there now.
        if not inspect(db.engine).has_table(accounts.name):
            raise


def _apply(did: str, tier: int) -> TierChange:
    with db.engine.begin() as conn:
        row = conn.execute(select(accounts.c.tier).where(accounts.c.did == did)).first()
        if row is None:
            conn.execute(insert(accounts).values(did=did, tier=tier, created_at=_utcnow()))
            return TierChange(did=did, previous_tier=None, tier=tier)
        conn.execute(update(accounts).where(accounts.c.did == did).values(tier=tier))
        return TierChange(did=did, previous_tier=int(row.tier), tier=tier)


def set_tier(did: str, tier: object) -> TierChange:
    """Set the trust tier of the account for ``did`` and return what changed.

    ``did`` must be a canonical Ed25519 did:key (:class:`InvalidDid` otherwise)
    and ``tier`` a value :func:`parse_tier` accepts (``ValueError`` otherwise);
    nothing is written when either is rejected.

    A DID that has not signed in yet gets its account row created at the
    requested tier, so a first moderator can be appointed before they sign in;
    sign-in keeps an existing row's tier. The change reaches a user's access
    tokens when their next one is issued (see ``app.security``).
    """
    did = validate_did(did)
    tier = parse_tier(tier)
    _ensure_accounts_table()
    try:
        return _apply(did, tier)
    except IntegrityError:
        # A concurrent first sign-in created the row between our read and
        # insert; it exists now, so the retry takes the update path.
        return _apply(did, tier)
