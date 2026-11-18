"""SQLAlchemy model for the appeals plugin.

``appeals`` (the saved projection of ``appeal`` records)::

    appeals(appeal_cid TEXT PRIMARY KEY,
            decision_cid TEXT NOT NULL UNIQUE,
            appellant_did TEXT NOT NULL,
            grounds TEXT NOT NULL,
            status TEXT NOT NULL,
            filed_at TIMESTAMP NOT NULL)

One row per accepted ``appeal`` record.  ``appeal_cid`` is the record's content
id -- the key the panel (``appeal_panels.appeal_cid``) and the panel's
``appeal.decision`` point at -- so replaying the same record can never add a
second row.  ``decision_cid`` is the ``moderation.decision`` being appealed and
carries a UNIQUE constraint: **a decision can be appealed once**, and the
database, not only the handler's check, is what makes that true when two
appeals race each other.

``appellant_did`` is the DID that signed the appeal, ``grounds`` the reason
the record gives, and ``status`` where the appeal stands (``pending`` until a
panel decides it).  ``filed_at`` is the instant the *record* is dated
(``created``, in UTC), not the instant this node received it, so the table is a
pure projection of the signed records.

``appeal_panels`` (the 3-member panel drawn for each appeal)::

    appeal_panels(appeal_cid TEXT NOT NULL,
                  member_did TEXT NOT NULL,
                  vote TEXT,
                  PRIMARY KEY (appeal_cid, member_did))

One row per seat: an appeal's panel is the three rows that share its
``appeal_cid``.  ``member_did`` is a tier-3 or tier-4 member who is neither the
deciding moderator nor an author of the paper (see
:mod:`app.modules.appeals.panel`), and ``vote`` stays NULL until that member
votes.  The composite primary key is what keeps a member from holding two seats
on one panel, even if the panel is drawn twice.

``appeal_vote_reasons`` (the reasons given with each vote, feature 76)::

    appeal_vote_reasons(appeal_cid TEXT NOT NULL,
                        member_did TEXT NOT NULL,
                        reasons JSON NOT NULL,
                        PRIMARY KEY (appeal_cid, member_did))

``appeal_panels`` has no column for the text a member votes with, and its
shape is fixed by feature 75, so the reasons a member gives live beside their
vote here.  One row per vote that carried reasons; the panel's
``appeal.decision`` gathers the agreed members' reasons from it.  Missing rows
simply mean no reasons were given.

The model is declared on the application's shared declarative base so
``main.create_app`` -- which creates tables after the module loader has
imported every module package -- registers it in one pass.
:func:`ensure_tables` covers callers that never build the app.
"""

from __future__ import annotations

import threading
from typing import Optional

from sqlalchemy import JSON, Column, DateTime, PrimaryKeyConstraint, Text, inspect
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db

__all__ = [
    "Appeal",
    "AppealPanelMember",
    "AppealVoteReasons",
    "ensure_table",
    "ensure_tables",
]


class Appeal(db.Base):
    """One accepted ``appeal`` record."""

    __tablename__ = "appeals"

    appeal_cid = Column(Text, primary_key=True)
    decision_cid = Column(Text, nullable=False, unique=True)
    appellant_did = Column(Text, nullable=False)
    grounds = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="pending")
    filed_at = Column(DateTime, nullable=False)
    panel_seed = Column(Text, nullable=True)
    seed = Column(Text, nullable=True)
    draw_seed = Column(Text, nullable=True)
    restoration_cid = Column(Text, nullable=True)
    restoration_record_cid = Column(Text, nullable=True)
    restoration_decision_cid = Column(Text, nullable=True)
    restoration_id = Column(Text, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<Appeal appeal_cid={self.appeal_cid!r} decision_cid={self.decision_cid!r} "
            f"appellant_did={self.appellant_did!r} status={self.status!r}>"
        )


class AppealPanelMember(db.Base):
    """One seat on an appeal's panel."""

    __tablename__ = "appeal_panels"
    __table_args__ = (PrimaryKeyConstraint("appeal_cid", "member_did"),)

    appeal_cid = Column(Text, nullable=False)
    member_did = Column(Text, nullable=False)
    #: The member's vote; ``None`` until they have voted.
    vote = Column(Text, nullable=True)
    #: When the member last cast (or changed) their vote, as naive UTC; ``None``
    #: until they have voted (and for a vote recorded before this column
    #: existed).  The appeal detail returns it so a reloaded card can still say
    #: "You voted to … on {date}" instead of asking the member to vote again.
    voted_at = Column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AppealPanelMember appeal_cid={self.appeal_cid!r} "
            f"member_did={self.member_did!r} vote={self.vote!r}>"
        )


class AppealVoteReasons(db.Base):
    """The reasons one seated member gave with their vote (feature 76)."""

    __tablename__ = "appeal_vote_reasons"
    __table_args__ = (PrimaryKeyConstraint("appeal_cid", "member_did"),)

    appeal_cid = Column(Text, nullable=False)
    member_did = Column(Text, nullable=False)
    #: The member's reasons, as a JSON list of non-blank strings.
    reasons = Column(JSON, nullable=False, default=list)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<AppealVoteReasons appeal_cid={self.appeal_cid!r} "
            f"member_did={self.member_did!r} reasons={self.reasons!r}>"
        )


# Self-healing table creation, mirroring the other modules: callers that never
# build the app (scripts, tests) still get their table on first use.
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
        for table in (Appeal.__table__, AppealPanelMember.__table__, AppealVoteReasons.__table__):
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
