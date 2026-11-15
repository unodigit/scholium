"""SQLAlchemy engine, session and declarative base."""

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import declarative_base, sessionmaker

from .settings import settings

_DATABASE_URL = settings.DATABASE_URL
_connect_args = {}
if _DATABASE_URL.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}

engine = create_engine(_DATABASE_URL, connect_args=_connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def create_all() -> None:
    """Create every registered table.

    ``checkfirst`` is not atomic: another process sharing the database (a second
    worker or test runner) may create a table between the existence check and
    the CREATE. A second pass sees that table and is a no-op.
    """
    try:
        Base.metadata.create_all(bind=engine)
    except OperationalError as exc:
        if "already exists" not in str(exc):
            raise
        Base.metadata.create_all(bind=engine)