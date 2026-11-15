"""SQLAlchemy models for the submissions plugin.

``papers`` (``app_spec.xml``, ``database_schema/papers``)::

    papers(paper_cid TEXT PRIMARY KEY,
           short_id TEXT NOT NULL UNIQUE,
           categories JSON NOT NULL,
           licence TEXT NOT NULL,
           status TEXT NOT NULL,
           latest_version_cid TEXT,
           listed_at TIMESTAMP,
           claimed BOOLEAN DEFAULT TRUE)

One row per paper.  ``paper_cid`` is the cid of the paper's ``paper.genesis``
record, so the row is keyed by the signed record that created it and replaying
that record can never create a second paper.  ``short_id`` is the ``sch:`` id
derived from that cid.  ``latest_version_cid`` and ``listed_at`` stay NULL until
a version of the paper is accepted and listed; ``claimed`` is false only for a
paper imported on its authors' behalf and not yet claimed by one of them.

``paper_versions`` (``database_schema/paper_versions``)::

    paper_versions(version_cid TEXT PRIMARY KEY,
                   paper_cid TEXT NOT NULL,
                   n INTEGER NOT NULL,
                   title TEXT NOT NULL,
                   abstract TEXT NOT NULL,
                   manifest_cid TEXT NOT NULL,
                   licence TEXT NOT NULL,
                   prev_cid TEXT,
                   state TEXT NOT NULL,
                   change_note TEXT,
                   listed_at TIMESTAMP)

One row per accepted ``paper.version`` record.  ``version_cid`` is the record's
content id, so replaying the same record can never add a second version.
``licence`` holds the licence the signed version names: feature 50 requires the
version to keep its licence, and while the spec's abbreviated column list for
this table omits it a version may change licence, so the signed value is stored
next to the rest of the version metadata.  ``(paper_cid, n)`` is UNIQUE: a
paper has one version per number, which is what makes the version chain
(``prev_cid`` of version *n* is version *n-1*, and the first version's
``prev_cid`` is the genesis cid) an invariant the database enforces rather than
a convention a reader has to trust.  ``change_note`` is NULL when the record
names none; ``listed_at`` is NULL until the version is listed.

``authorship`` (``database_schema/authorship``)::

    authorship(version_cid TEXT NOT NULL,
               author_did TEXT NOT NULL,
               position INTEGER NOT NULL,
               credit_roles JSON,
               consent_cid TEXT,
               consent_decision TEXT)

One row per author listed on a version.  ``(version_cid, author_did)`` is the
primary key, so a version lists an author once.  ``position`` is the byline
order (1-based) and ``credit_roles`` the CRediT roles the record names, or NULL
when it names none.  ``consent_cid``/``consent_decision`` stay NULL until the
author signs a ``coauthor.consent`` (the consents plugin).

``notices`` (``database_schema/notices``)::

    notices(record_cid TEXT PRIMARY KEY,
            paper_cid TEXT NOT NULL,
            kind TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL)

One row per accepted ``withdrawal``, ``correction`` or ``retraction`` record.
``record_cid`` is the notice record's own cid, so replaying the same record can
never add a second notice.  The row is keyed to the *paper*, not to a version:
a notice that names a version still belongs to the whole paper, which is what
makes every version show it.  ``kind`` is the record type, ``reason`` the text
readers are shown and ``created_at`` the instant the signer's record is dated
(UTC), so the table is a pure projection of the signed records.  The notice's
target and any ``replacement`` stay in the record itself, which the ledger
serves by ``record_cid``.

The models are declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers them in one pass.
:func:`ensure_tables` covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Integer,
    Text,
    UniqueConstraint,
    inspect,
    true,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "DEFAULT_LICENCE",
    "INITIAL_STATUS",
    "Authorship",
    "Notice",
    "Paper",
    "PaperVersion",
    "ensure_tables",
]

#: The licence a paper is stored under when its genesis names none: CC BY 4.0,
#: spelled the way the signed records and the submit UI spell it (SPDX-style).
DEFAULT_LICENCE = "CC-BY-4.0"

#: The status of a paper nothing has happened to yet.  It is the status the
#: ``status`` plugin computes for a paper with no review, notice or moderation
#: record, so a freshly accepted genesis already agrees with a recompute.
INITIAL_STATUS = "preprint"


class Paper(db.Base):
    """One paper, created by its accepted ``paper.genesis`` record."""

    __tablename__ = "papers"

    paper_cid = Column(Text, primary_key=True)
    short_id = Column(Text, nullable=False, unique=True)
    categories = Column(JSON, nullable=False)
    licence = Column(
        Text, nullable=False, default=DEFAULT_LICENCE, server_default=DEFAULT_LICENCE
    )
    status = Column(Text, nullable=False, default=INITIAL_STATUS)
    latest_version_cid = Column(Text, nullable=True)
    listed_at = Column(DateTime, nullable=True)
    claimed = Column(Boolean, nullable=False, default=True, server_default=true())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Paper paper_cid={self.paper_cid!r} short_id={self.short_id!r} "
            f"status={self.status!r}>"
        )


class PaperVersion(db.Base):
    """One version of a paper, created by its accepted ``paper.version`` record."""

    __tablename__ = "paper_versions"
    __table_args__ = (
        # A paper has exactly one version per number.  Together with the
        # handler's chain check this makes a branched or replayed version a
        # database error rather than a row two readers disagree about.
        UniqueConstraint("paper_cid", "n", name="uq_paper_versions_paper_n"),
    )

    version_cid = Column(Text, primary_key=True)
    paper_cid = Column(Text, nullable=False)
    n = Column(Integer, nullable=False)
    title = Column(Text, nullable=False)
    abstract = Column(Text, nullable=False)
    manifest_cid = Column(Text, nullable=False)
    #: The licence the signed version names.  Feature 50 stores it per version
    #: ("keeping ... licence"); the abbreviated column list in the spec's
    #: ``database_schema`` omits it, but a version can change licence and the
    #: signed record's value must not be lost.
    licence = Column(Text, nullable=False)
    prev_cid = Column(Text, nullable=True)
    state = Column(Text, nullable=False)
    change_note = Column(Text, nullable=True)
    listed_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<PaperVersion version_cid={self.version_cid!r} "
            f"paper_cid={self.paper_cid!r} n={self.n} state={self.state!r}>"
        )


class Authorship(db.Base):
    """One author listed on one version, in byline order."""

    __tablename__ = "authorship"

    #: The version this row belongs to.
    version_cid = Column(Text, primary_key=True)
    #: The author's ``did:`` identifier.
    author_did = Column(Text, primary_key=True)
    #: 1-based byline position.
    position = Column(Integer, nullable=False)
    #: CRediT roles the record names, or NULL when it names none.
    credit_roles = Column(JSON, nullable=True)
    #: cid of the author's ``coauthor.consent`` record, once signed.
    consent_cid = Column(Text, nullable=True)
    #: ``accept`` or ``decline`` once the author has decided.
    consent_decision = Column(Text, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Authorship version_cid={self.version_cid!r} "
            f"author_did={self.author_did!r} position={self.position}>"
        )


class Notice(db.Base):
    """One withdrawal, correction or retraction notice, shown on every version."""

    __tablename__ = "notices"

    #: cid of the notice record.
    record_cid = Column(Text, primary_key=True)
    #: cid of the paper's ``paper.genesis`` record, whichever version the
    #: notice named.  Readers look notices up by paper.
    paper_cid = Column(Text, nullable=False, index=True)
    #: ``withdrawal``, ``correction`` or ``retraction`` (the record type).
    kind = Column(Text, nullable=False)
    #: The reason readers are shown.
    reason = Column(Text, nullable=False)
    #: The instant the record is dated, in UTC (naive, like every timestamp here).
    created_at = Column(DateTime, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Notice record_cid={self.record_cid!r} paper_cid={self.paper_cid!r} "
            f"kind={self.kind!r}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their tables on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the ``papers``, ``paper_versions``, ``authorship`` and ``notices`` tables if needed."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        for table in (
            Paper.__table__,
            PaperVersion.__table__,
            Authorship.__table__,
            Notice.__table__,
        ):
            try:
                table.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table in between.
                if not inspect(db.engine).has_table(table.name):
                    raise
        _table_engine = db.engine
