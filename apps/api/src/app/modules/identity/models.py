"""SQLAlchemy model for the ``auth_challenges`` table.

Table shape (``app_spec.xml``, ``database_schema/auth_challenges``)::

    auth_challenges(nonce TEXT PRIMARY KEY,
                    did TEXT NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    used BOOLEAN DEFAULT FALSE)

One row per sign-in challenge issued by ``POST /v1/auth/challenge``: ``nonce``
is the unguessable value the client must sign, ``did`` the did:key it was
issued to, ``expires_at`` the instant (naive UTC, like every other timestamp
column in this app) after which it is no longer accepted, and ``used`` flips to
true when a sign-in consumes it.

``used`` is declared ``NOT NULL`` here, a deliberate tightening of the spec's
bare ``DEFAULT FALSE``: a ``NULL`` would match neither ``used = false`` nor
``used = true`` and so could slip past a single-use check written either way.

The model is declared on the application's shared declarative base so that
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, Text, false, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["AuthChallenge", "ensure_table"]


class AuthChallenge(db.Base):
    """One single-use sign-in nonce issued to a did:key."""

    __tablename__ = "auth_challenges"

    nonce = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, nullable=False, default=False, server_default=false())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        # The nonce is a bearer secret until it is used or expires: keep it out
        # of logs and tracebacks.
        return (
            f"<AuthChallenge did={self.did!r} expires_at={self.expires_at} "
            f"used={self.used}>"
        )


# ``main.create_app`` calls ``db.Base.metadata.create_all`` after loading the
# modules, which covers the normal path.  The service may also be used from
# tests/scripts that never build the app, so make sure the table exists before
# the first write (the same self-healing pattern as the ledger and content
# modules).
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create the ``auth_challenges`` table if it does not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is not db.engine:
            try:
                AuthChallenge.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table between the
                # existence check and the DDL.  That is success, not failure.
                if not inspect(db.engine).has_table(AuthChallenge.__tablename__):
                    raise
            _table_engine = db.engine
