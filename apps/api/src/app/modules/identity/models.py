"""SQLAlchemy models for the identity plugin.

Tables (``app_spec.xml``, ``database_schema``):

* ``auth_challenges`` -- single-use sign-in nonces (feature 23).
* ``accounts`` -- one row per DID that has signed in, with trust tier.
* ``refresh_tokens`` -- hashed rotating refresh tokens.
* ``account_keys`` -- the keys authorised to sign for a DID over time (feature 27).
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    PrimaryKeyConstraint,
    Text,
    false,
    inspect,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Account",
    "AccountKey",
    "AuthChallenge",
    "RefreshToken",
    "ensure_account_keys_table",
    "ensure_account_table",
    "ensure_refresh_tokens_table",
    "ensure_table",
]


class AuthChallenge(db.Base):
    """One single-use sign-in nonce issued to a did:key."""

    __tablename__ = "auth_challenges"

    nonce = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, nullable=False, default=False, server_default=false())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AuthChallenge did={self.did!r} expires_at={self.expires_at} "
            f"used={self.used}>"
        )


class Account(db.Base):
    """One account per DID that has signed in at least once."""

    __tablename__ = "accounts"

    did = Column(Text, primary_key=True)
    tier = Column(Integer, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Account did={self.did!r} tier={self.tier}>"


class RefreshToken(db.Base):
    """One hashed, rotating refresh token issued at sign-in."""

    __tablename__ = "refresh_tokens"

    token_hash = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    rotated = Column(Boolean, nullable=False, default=False, server_default=false())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<RefreshToken did={self.did!r} rotated={self.rotated}>"



class AccountKey(db.Base):
    """One key authorised to sign for a DID during a time window.

    ``active_from`` / ``active_until`` bound the window during which this key
    is the active signing key for ``did`` (``active_until`` is ``NULL`` for the
    currently active key).  Resolving the active key for a DID at a given
    instant reads this table (feature 27); a DID with no rows falls back to
    its own genesis key.
    """

    __tablename__ = "account_keys"

    did = Column(Text, nullable=False)
    public_key = Column(Text, nullable=False)
    active_from = Column(DateTime, nullable=False)
    active_until = Column(DateTime, nullable=True)

    __table_args__ = (
        PrimaryKeyConstraint("did", "active_from"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AccountKey did={self.did!r} public_key={self.public_key!r} "
            f"active_from={self.active_from} active_until={self.active_until}>"
        )


# Self-healing table creation, mirroring the other modules.
_table_lock = threading.Lock()
_table_engines: dict[str, Optional[Engine]] = {
    "auth_challenges": None,
    "accounts": None,
    "refresh_tokens": None,
    "account_keys": None,
}


def _create(model, name, engine):
    global _table_engines
    if _table_engines[name] is engine:
        return
    with _table_lock:
        if _table_engines[name] is not engine:
            try:
                model.__table__.create(bind=engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                if not inspect(engine).has_table(name):
                    raise
            _table_engines[name] = engine


def ensure_table() -> None:
    """Create the identity tables if they do not exist yet."""
    _create(AuthChallenge, "auth_challenges", db.engine)
    _create(Account, "accounts", db.engine)
    _create(RefreshToken, "refresh_tokens", db.engine)
    _create(AccountKey, "account_keys", db.engine)


def ensure_account_table() -> None:
    """Create the ``accounts`` table if it does not exist yet."""
    _create(Account, "accounts", db.engine)


def ensure_refresh_tokens_table() -> None:
    """Create the ``refresh_tokens`` table if it does not exist yet."""
    _create(RefreshToken, "refresh_tokens", db.engine)


def ensure_account_keys_table() -> None:
    """Create the ``account_keys`` table if it does not exist yet."""
    _create(AccountKey, "account_keys", db.engine)
