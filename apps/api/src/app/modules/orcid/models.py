"""SQLAlchemy models for the orcid plugin.

Tables (``app_spec.xml``, ``database_schema``)::

    credentials(id TEXT PRIMARY KEY,
                did TEXT NOT NULL,
                kind TEXT NOT NULL,
                vc JSON NOT NULL,
                status TEXT NOT NULL)

    nullifiers(nullifier TEXT PRIMARY KEY,
               did TEXT NOT NULL)

The ``credentials`` table holds verifiable credentials issued by this node,
including ORCID ownership credentials.  The ``nullifiers`` table holds one row
per ORCID iD this node has linked (feature 33): the primary key is the
nullifier ``H(issuer || orcid || domain)`` (see :mod:`app.modules.orcid.nullifier`)
and ``did`` is the DID the iD is linked to, so one ORCID maps to one DID.

The models are declared on a *private* declarative base so they do not
auto-register on the shared base: the tables are created lazily by
:func:`ensure_tables` (called when a credential is issued), which keeps tests
and deployments that expect to manage the tables themselves working.
Declaring them here still gives callers ORM models to import.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import declarative_base

from app import db

__all__ = ["Credential", "Nullifier", "ensure_tables"]

#: Private declarative base: keeps this model off ``app.db.Base.metadata`` so
#: ``create_all`` does not create the table at app startup.
_Base = declarative_base()


class Credential(_Base):
    """One issued verifiable credential."""

    __tablename__ = "credentials"

    id = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)
    kind = Column(Text, nullable=False)
    vc = Column(Text, nullable=False)
    status = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Credential id={self.id!r} did={self.did!r} kind={self.kind!r}>"


class Nullifier(_Base):
    """One linked ORCID iD, identified by its nullifier, and the DID holding it."""

    __tablename__ = "nullifiers"

    #: Lower-case hex SHA-256 of ``issuer || orcid || domain``.  The primary
    #: key is what makes a second link of the same iD impossible, even for two
    #: requests racing each other.
    nullifier = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Nullifier did={self.did!r}>"


_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        for model in (Credential, Nullifier):
            try:
                model.__table__.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # Another worker may have created the table between the
                # ``checkfirst`` probe and the CREATE; that is fine.
                if not inspect(db.engine).has_table(model.__tablename__):
                    raise
        _table_engine = db.engine