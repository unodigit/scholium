"""Hiding flagged records from public reads (plugin: moderation).

A ``moderation.decision`` with ``action: hide`` withdraws a flagged record that
is not a paper version -- a discussion post, an inline annotation or a revealed
review -- from the surfaces readers see, *without* touching the signed record
itself:

* the envelope, its signature and its ``event_log`` entry stay exactly as they
  were, so history still verifies and the decision itself is public
  (``GET /v1/records/{cid}``);
* the record's cid is saved to the ``moderation_hidden`` table, which the read
  paths consult (:func:`is_hidden`, :func:`hidden_record`) to serve a
  "hidden by moderation" placeholder with the decision's reason instead of the
  record's body;
* unlike a tombstone nothing is deleted, so the hiding is reversible: a
  ``release`` decision -- what an overturned appeal appends -- removes the row
  (:func:`unhide_target`) and the record reads as it did before.

This is the split a *hide* makes: the log keeps the content (moderation must be
auditable and appealable), the public reads keep moderation's ruling.  It is
deliberately the mirror image of :mod:`app.modules.moderation.tombstones`,
which removes bytes for legal reasons and is final.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import delete

from app import db

from .models import ModerationHidden, ensure_tables

__all__ = [
    "HIDDEN",
    "HiddenRecord",
    "get_hidden_entry",
    "hidden_placeholder",
    "hidden_record",
    "hide_target",
    "is_hidden",
    "unhide_target",
]

#: The state a ``hide`` decision reports (it is not a version state).
HIDDEN = "hidden"

#: The placeholder sentence a public read serves instead of a hidden record's
#: body.  The decision's reason is appended wherever it can be read.
PLACEHOLDER = "This content is hidden by moderation."


@dataclass(frozen=True)
class HiddenRecord:
    """What the read paths need to serve a hidden record's placeholder."""

    #: The hidden record's cid.
    cid: str
    #: The ``hide`` decision that hid it -- the first one stays on record.
    decision_cid: str
    #: That decision's reason, when its signed record is still readable.
    reason: Optional[str] = None
    #: The policy clause that decision cited, when readable.
    clause: Optional[str] = None
    #: When the decision was signed (ISO 8601), when readable.
    hidden_at: Optional[str] = None


def get_hidden_entry(cid: object) -> Optional[ModerationHidden]:
    """The ``moderation_hidden`` row for ``cid``, or ``None`` when it is not hidden."""
    if not isinstance(cid, str) or not cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(ModerationHidden, cid)
        if row is not None:
            session.expunge(row)
        return row


def is_hidden(cid: object) -> bool:
    """Whether a ``hide`` decision has withdrawn ``cid`` from public reads."""
    return get_hidden_entry(cid) is not None


def hidden_record(cid: object) -> Optional[HiddenRecord]:
    """The hidden state of ``cid`` with its decision's reason, or ``None``.

    The reason and clause are read from the decision's own signed record in the
    log -- they are public, that is the point of a signed decision -- so a read
    path can serve ``hidden_placeholder(record)`` without a second lookup.
    A decision record that can no longer be decoded still hides the record;
    only the reason is lost.
    """
    row = get_hidden_entry(cid)
    if row is None:
        return None

    from app.modules import ledger

    reason: Optional[str] = None
    clause: Optional[str] = None
    entry = ledger.entry_by_cid(row.decision_cid)
    body = getattr(entry, "body", None)
    if isinstance(body, dict):
        value = body.get("reason")
        reason = value if isinstance(value, str) and value.strip() else None
        value = body.get("clause")
        clause = value if isinstance(value, str) and value.strip() else None
    hidden_at: Optional[str] = None
    if entry is not None:
        try:
            hidden_at = ledger.stored_envelope(entry).created
        except Exception:  # pragma: no cover - the append-only log should decode
            hidden_at = None
    return HiddenRecord(
        cid=row.cid,
        decision_cid=str(row.decision_cid),
        reason=reason,
        clause=clause,
        hidden_at=hidden_at,
    )


def hidden_placeholder(hidden: HiddenRecord) -> str:
    """The sentence served instead of a hidden record's body.

    ``PLACEHOLDER`` plus the decision's reason, when it could be read: the
    person whose record was hidden is told why, in the moderator's own words.
    """
    if hidden.reason:
        return f"{PLACEHOLDER} {hidden.reason}"
    return PLACEHOLDER


def hide_target(cid: str, decision_cid: str) -> ModerationHidden:
    """Save ``cid`` to ``moderation_hidden`` on behalf of a decision.

    Idempotent per cid: a record that is already hidden keeps the decision that
    first hid it (the row is returned as it stands), like the denylist does.
    Nothing is deleted and no bytes are touched -- the signed record stays.

    Raises:
        ValueError: ``cid`` or ``decision_cid`` is empty.
    """
    if not isinstance(cid, str) or not cid:
        raise ValueError("a hide needs the cid of the record it hides")
    if not isinstance(decision_cid, str) or not decision_cid:
        raise ValueError("a hide needs the cid of the decision that made it")
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(ModerationHidden, cid)
        if row is None:
            session.add(ModerationHidden(cid=cid, decision_cid=decision_cid))
            try:
                session.commit()
            except Exception:
                # Another writer hid the same record between the read and now;
                # its row is the one on record.
                session.rollback()
                row = session.get(ModerationHidden, cid)
                if row is None:
                    raise
            else:
                row = session.get(ModerationHidden, cid)
        if row is not None:
            session.expunge(row)
        assert row is not None
        return row


def unhide_target(cid: str) -> bool:
    """Remove ``cid`` from ``moderation_hidden``; return whether it was hidden.

    This is what a ``release`` decision does (an overturned appeal putting a
    hidden record back): the row goes, and the record reads as it did before.
    """
    if not isinstance(cid, str) or not cid:
        return False
    ensure_tables()
    with db.SessionLocal() as session:
        result = session.execute(delete(ModerationHidden).where(ModerationHidden.cid == cid))
        session.commit()
    return bool(result.rowcount)
