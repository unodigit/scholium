"""SQLAlchemy models for the identity plugin.

Tables (``app_spec.xml``, ``database_schema``):

* ``auth_challenges`` -- single-use sign-in nonces (feature 23).
* ``accounts`` -- one row per DID that has signed in, with trust tier.
* ``refresh_tokens`` -- hashed rotating refresh tokens.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    Text,
    false,
    inspect,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Account",
    "AuthChallenge",
    "RefreshToken",
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


# Self-healing table creation, mirroring the other modules.
_table_lock = threading.Lock()
_table_engines: dict[str, Optional[Engine]] = {
    "auth_challenges": None,
    "accounts": None,
    "refresh_tokens": None,
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


def ensure_account_table() -> None:
    """Create the ``accounts`` table if it does not exist yet."""
    _create(Account, "accounts", db.engine)


def ensure_refresh_tokens_table() -> None:
    """Create the ``refresh_tokens`` table if it does not exist yet."""
    _create(RefreshToken, "refresh_tokens", db.engine)
