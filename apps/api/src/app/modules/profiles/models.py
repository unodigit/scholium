"""SQLAlchemy models for the profiles plugin.

Tables (``app_spec.xml``, ``database_schema``)::

    profile(did TEXT PRIMARY KEY,
            enc_blob BLOB NOT NULL,      -- name, affiliation, email, encrypted
            key_ref TEXT NOT NULL)       -- which profile_keys row opens it

    profile_keys(key_ref TEXT PRIMARY KEY,
                 key BLOB NOT NULL)      -- the per-object key

    profile_email_verification(did TEXT PRIMARY KEY,
                               email_fingerprint TEXT NOT NULL,
                               verified_at TIMESTAMP)  -- NULL while pending

Personal data lives only in ``profile.enc_blob``.  The key sits in a separate
table on purpose: erasure deletes the ``profile_keys`` row, which shreds the
blob (and any copy of it in a backup) without touching the records that
reference the DID.  There is deliberately no foreign key from ``profile`` to
``profile_keys`` so that deletion is never blocked or cascaded.

``profile_email_verification`` holds no address either: ``email_fingerprint``
is an HMAC over the DID and the address (see
:mod:`app.modules.profiles.verification`), which is enough to notice that the
address changed without storing personal data outside the encrypted blob.
Erasure deletes this row along with the key, so a later save starts out
unverified.

The models are declared on the shared declarative base so ``main.create_app``
creates the tables after the module loader has imported this package.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, DateTime, LargeBinary, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = ["Profile", "ProfileEmailVerification", "ProfileKey", "ensure_tables"]


class Profile(db.Base):
    """One encrypted profile per DID."""

    __tablename__ = "profile"

    did = Column(Text, primary_key=True)
    enc_blob = Column(LargeBinary, nullable=False)
    key_ref = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid; never show the blob
        return f"<Profile did={self.did!r} key_ref={self.key_ref!r}>"


class ProfileKey(db.Base):
    """The per-object encryption key for one profile."""

    __tablename__ = "profile_keys"

    key_ref = Column(Text, primary_key=True)
    key = Column(LargeBinary, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid; never show the key
        return f"<ProfileKey key_ref={self.key_ref!r}>"


class ProfileEmailVerification(db.Base):
    """Whether ``did``'s stored address has been proven (feature 178).

    ``email_fingerprint`` binds this row to the address currently in the
    encrypted profile.  ``verified_at`` is ``NULL`` between a save and the
    owner redeeming their link; a save with a different address rewrites the
    fingerprint and clears ``verified_at``.
    """

    __tablename__ = "profile_email_verification"

    did = Column(Text, primary_key=True)
    email_fingerprint = Column(Text, nullable=False)
    verified_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<ProfileEmailVerification did={self.did!r} "
            f"verified={self.verified_at is not None}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their tables on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create this plugin's tables if they do not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        for model in (Profile, ProfileKey, ProfileEmailVerification):
            try:
                model.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table in between.
                if not inspect(db.engine).has_table(model.__tablename__):
                    raise
        _table_engine = db.engine
