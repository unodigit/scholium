"""SQLAlchemy models for the discussion plugin.

Tables (``app_spec.xml``, ``database_schema``)::

    discussion_posts(post_cid TEXT PRIMARY KEY,
                     paper_cid TEXT NOT NULL,
                     parent_cid TEXT,
                     anchor JSON,
                     author_did TEXT NOT NULL,
                     helpful INTEGER DEFAULT 0)

One row per accepted ``discussion.post`` record.  ``post_cid`` is the
record's content id, so a replay of the same record can never produce a
second row.  ``paper_cid`` is the paper (its genesis cid) the post belongs
to; ``parent_cid`` names the post being replied to, or is ``NULL`` for a
new thread; ``anchor`` is the record body's anchor (a version cid or a
paragraph anchor object); ``helpful`` counts the distinct members who
marked the post helpful.

Two small bookkeeping tables back the discussion surface but are not part of
the spec's schema:

``discussion_helpful_votes(post_cid, voter_did)``
    One row per member who marked a post helpful.  The composite primary key
    is what makes "once" enforceable: a repeat by the same member is a
    conflict, while a different member's vote still counts.

``discussion_mutes(muter_did, muted_did)``
    One row per mute.  ``GET /v1/papers/{id}/threads`` omits the posts of a
    DID the caller has muted.

The models are declared on the application's shared declarative base so
``main.create_app`` creates the tables after the module loader has imported
this package.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import Column, Integer, JSON, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "DiscussionPost",
    "HelpfulVote",
    "Mute",
    "ensure_table",
    "ensure_tables",
]


class DiscussionPost(db.Base):
    """One accepted ``discussion.post`` record."""

    __tablename__ = "discussion_posts"

    post_cid = Column(Text, primary_key=True)
    paper_cid = Column(Text, nullable=False)
    parent_cid = Column(Text, nullable=True)
    anchor = Column(JSON, nullable=True)
    author_did = Column(Text, nullable=False)
    helpful = Column(Integer, nullable=False, default=0, server_default="0")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<DiscussionPost post_cid={self.post_cid!r} "
            f"paper_cid={self.paper_cid!r} parent_cid={self.parent_cid!r} "
            f"author_did={self.author_did!r} helpful={self.helpful!r}>"
        )


class HelpfulVote(db.Base):
    """One member's "helpful" mark on one post."""

    __tablename__ = "discussion_helpful_votes"

    post_cid = Column(Text, primary_key=True)
    voter_did = Column(Text, primary_key=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<HelpfulVote post_cid={self.post_cid!r} voter_did={self.voter_did!r}>"


class Mute(db.Base):
    """One member's mute of another DID."""

    __tablename__ = "discussion_mutes"

    muter_did = Column(Text, primary_key=True)
    muted_did = Column(Text, primary_key=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Mute muter_did={self.muter_did!r} muted_did={self.muted_did!r}>"


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their tables on first use.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_tables() -> None:
    """Create the plugin's tables if they do not exist yet."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        for table in (
            DiscussionPost.__table__,
            HelpfulVote.__table__,
            Mute.__table__,
        ):
            try:
                table.create(bind=db.engine, checkfirst=True)
            except (OperationalError, ProgrammingError):
                # ``checkfirst`` is not atomic: another process (e.g. a second
                # pytest-xdist worker) may have created the table in between.
                if not inspect(db.engine).has_table(table.name):
                    raise
        _table_engine = db.engine


#: Alias matching sibling plugins that expose a singular ``ensure_table``.
ensure_table = ensure_tables
