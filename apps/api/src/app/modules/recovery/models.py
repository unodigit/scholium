"""SQLAlchemy models for the recovery plugin.

Tables (``app_spec.xml``, ``database_schema``):

* ``guardians`` -- the five recovery guardians each account has chosen. One row
  per guardian: ``did`` is the account that chose them, ``guardian_did`` the
  guardian, ``position`` the guardian's index (0-4) in the list the account
  submitted.

``(did, position)`` is the primary key, so an account can never hold more than
five guardians, and ``(did, guardian_did)`` is unique, so it can never name the
same guardian twice.

* ``recovery_requests`` -- one row per request to recover an account whose key
  is lost. ``id`` is the ``request_id`` handed back to the requester, ``did`` the
  account being recovered, ``new_public_key`` the key it should end up with,
  ``approvals`` a JSON list of the guardian approvals gathered so far (empty
  when opened), ``contest_until`` the end of the contest window (``NULL`` until
  enough guardians have approved), ``status`` where the request is in its
  life (one of :data:`REQUEST_STATUSES`) and ``closed_at`` when it was
  cancelled or finalized (``NULL`` while it is open, and for a request that
  closed before the column existed).
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Integer,
    PrimaryKeyConstraint,
    Text,
    UniqueConstraint,
    inspect,
    text,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "REQUEST_PENDING",
    "REQUEST_STATUSES",
    "Guardian",
    "RecoveryRequest",
    "ensure_requests_table",
    "ensure_table",
    "mark_closed",
]

#: A freshly opened request, still gathering guardian approvals.
REQUEST_PENDING = "pending"

#: Every status a request can be in. Only ``pending`` is entered here; the
#: approval, finalize and cancel steps move a request on to the others.
REQUEST_STATUSES = (REQUEST_PENDING, "contest", "finalized", "cancelled")


class Guardian(db.Base):
    """One recovery guardian chosen by one account."""

    __tablename__ = "guardians"

    did = Column(Text, nullable=False)
    guardian_did = Column(Text, nullable=False)
    position = Column(Integer, nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("did", "position"),
        UniqueConstraint("did", "guardian_did", name="uq_guardians_did_guardian_did"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Guardian did={self.did!r} position={self.position} guardian_did={self.guardian_did!r}>"


class RecoveryRequest(db.Base):
    """One request to recover the account ``did`` onto ``new_public_key``."""

    __tablename__ = "recovery_requests"

    id = Column(Text, primary_key=True)
    did = Column(Text, nullable=False)
    new_public_key = Column(Text, nullable=False)
    approvals = Column(JSON, nullable=False)
    contest_until = Column(DateTime)
    status = Column(Text, nullable=False)
    #: When the request was cancelled or finalized: UTC, to the second, stored
    #: the way ``contest_until`` is.  ``NULL`` while it is open.
    closed_at = Column(DateTime)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<RecoveryRequest id={self.id!r} did={self.did!r} status={self.status!r}>"


def mark_closed(row: RecoveryRequest) -> datetime:
    """Record on ``row`` when it closed, unless it already says; return the time on record.

    A request closes once.  Cancelling a cancelled request again (or a closure
    recorded twice) keeps the first time, so what the guardians were told and
    what the request says never drift apart.
    """
    if row.closed_at is None:
        row.closed_at = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
    return row.closed_at


# Self-healing table creation, mirroring the other modules: each table is
# created on first use against whichever engine is current.
_table_lock = threading.Lock()
_table_engines: dict[str, Engine] = {}

#: Columns added to a table after it first shipped, by table name.  Every one is
#: nullable, since the rows that exist already get NULL.  ``Table.create`` skips
#: a table that exists, so :func:`_ensure` adds what an older database lacks.
_ADDED_COLUMNS = {"recovery_requests": ("closed_at",)}


def _add_missing_columns(model: type, engine: Engine) -> None:
    """Add any :data:`_ADDED_COLUMNS` that ``model``'s existing table lacks.

    The DDL type comes from the model for whichever dialect runs (SQLite's
    ``DATETIME`` is not a PostgreSQL type).  Existing rows are untouched.
    """
    name = model.__tablename__
    wanted = _ADDED_COLUMNS.get(name, ())
    if not wanted:
        return
    present = {column["name"] for column in inspect(engine).get_columns(name)}
    for column in wanted:
        if column in present:
            continue
        ddl_type = model.__table__.c[column].type.compile(dialect=engine.dialect)
        try:
            with engine.begin() as connection:
                connection.execute(text(f"ALTER TABLE {name} ADD COLUMN {column} {ddl_type}"))
        except (OperationalError, ProgrammingError):
            # Another worker sharing the database may have added it between our
            # inspection and the ALTER; only re-raise if it is still absent.
            if column not in {c["name"] for c in inspect(engine).get_columns(name)}:
                raise


def _ensure(model: type) -> None:
    """Create ``model``'s table if it does not exist yet on the current engine.

    A table an older release created gains the columns added since, in place.
    """
    name = model.__tablename__
    engine = db.engine
    if _table_engines.get(name) is engine:
        return
    with _table_lock:
        if _table_engines.get(name) is not engine:
            try:
                model.__table__.create(bind=engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # Another worker may have created it between the check and the create.
                if not inspect(engine).has_table(name):
                    raise
            _add_missing_columns(model, engine)
            _table_engines[name] = engine


def ensure_table() -> None:
    """Create the ``guardians`` table if it does not exist yet."""
    _ensure(Guardian)


def ensure_requests_table() -> None:
    """Create the ``recovery_requests`` table if it does not exist yet."""
    _ensure(RecoveryRequest)
