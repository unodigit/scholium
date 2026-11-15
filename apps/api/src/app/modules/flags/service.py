"""Create and read user-submitted flags (plugin: flags).

A flag names a target (paper, post, review or version) and a reason
category.  :func:`create_flag` stores it in the ``flags`` table with status
``pending``; a moderator later acts on it and links a decision cid.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from sqlalchemy import select

from app import db

from .models import Flag, ensure_table, ensure_tables

__all__ = [
    "Flag",
    "create_flag",
    "get_flag",
    "list_flags",
    "save_flag",
]

def create_flag(
    *,
    target_cid: str,
    reporter_did: str,
    reason: str,
    flag_id: Optional[str] = None,
    status: str = "pending",
) -> Flag:
    """Insert a new flag row and return it detached."""
    ensure_table()
    fid = flag_id or str(uuid.uuid4())
    row = Flag(
        id=fid,
        target_cid=target_cid,
        reporter_did=reporter_did,
        reason=reason,
        status=status,
        decision_cid=None,
    )
    with db.SessionLocal() as session:
        session.add(row)
        session.commit()
        session.refresh(row)
        session.expunge(row)
    return row


def get_flag(flag_id: str) -> Optional[Flag]:
    """Return the flag with ``flag_id`` or ``None``."""
    ensure_table()
    with db.SessionLocal() as session:
        row = session.get(Flag, flag_id)
        if row is not None:
            session.expunge(row)
        return row


def list_flags(*, reporter_did: Optional[str] = None, target_cid: Optional[str] = None) -> list[Flag]:
    """Return flags, optionally filtered."""
    ensure_table()
    with db.SessionLocal() as session:
        stmt = select(Flag)
        if reporter_did is not None:
            stmt = stmt.where(Flag.reporter_did == reporter_did)
        if target_cid is not None:
            stmt = stmt.where(Flag.target_cid == target_cid)
        rows = list(session.execute(stmt).scalars().all())
        for row in rows:
            session.expunge(row)
        return rows
# Alias matching the naming used by sibling plugins (``save_paper``, ...).
save_flag = create_flag
