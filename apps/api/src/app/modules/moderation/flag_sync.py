"""Close flags when a moderation decision is made (plugin: moderation + flags).

A member's flag names a target (``POST /v1/flags``); a moderator's decision
names a target too (``POST /v1/moderation/decisions``).  When a decision has
been applied, this module marks every *open* flag on its target decided, links
the decision's cid, and lets the flags plugin tell each reporter -- so a flag
stops being moderators' open work the moment someone has ruled on it.

Which flags a decision settles
------------------------------
* flags filed against the decision's ``target`` -- a version, a flagged
  record (a post, an annotation, a revealed review), or, for a ``tombstone``,
  a paper or a file id;
* for a decision on a **version**, flags filed against that version's
  **paper**: a reader flags "the paper" while a moderator holds one of its
  versions, and that decision is the answer to the report.

A flag that already has a decision keeps it (the move is a compare-and-set in
:func:`app.modules.flags.decide_flags_for_target`), so repeating the sync, or
a later decision on the same target, neither changes it nor notifies twice.

Wiring
------
:func:`persist_flags_entry` subscribes to the ledger for ``moderation.decision``
when this module is imported (the flags package imports it), after this
package's own subscriber has applied the decision.  It does not rely on that
order: it applies the decision itself first -- :func:`apply_decision` is
idempotent -- and settles flags only once that succeeded, so a decision that
could not be applied never closes a flag.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from app.modules import ledger, submissions
from app.modules.flags.service import decide_flags_for_target
from app.modules.flags.models import Flag

from .decisions import DECISION_TYPE, apply_decision

__all__ = [
    "flag_targets",
    "install_ledger_subscriber",
    "persist_flags_entry",
    "sync_flags_for_decision",
]

logger = logging.getLogger(__name__)


def flag_targets(target: str) -> tuple[str, ...]:
    """The cids whose flags a decision on ``target`` answers, ``target`` first.

    A version also answers its paper's flags.  An unknown cid (a paper, a file
    id, a post) answers only itself.
    """
    targets = [target]
    version = submissions.get_version(target)
    paper_cid = getattr(version, "paper_cid", None) if version is not None else None
    if isinstance(paper_cid, str) and paper_cid and paper_cid != target:
        targets.append(paper_cid)
    return tuple(targets)


def sync_flags_for_decision(record: Mapping[str, Any]) -> list[Flag]:
    """Apply a ``moderation.decision`` record, then decide the open flags it answers.

    Returns the flags this call decided (empty when none were open).  Raises
    whatever :func:`apply_decision` raises for a decision that cannot be
    applied, and then decides nothing.
    """
    decision = apply_decision(record)
    decided: list[Flag] = []
    for target in flag_targets(decision.target_cid):
        decided.extend(decide_flags_for_target(target, decision.decision_cid))
    return decided


def persist_flags_entry(entry: Any) -> None:
    """Ledger subscriber: settle the flags of every ``moderation.decision`` in the log.

    Failures are logged by the ledger and do not undo the append.
    """
    if getattr(entry, "record_type", None) != DECISION_TYPE:
        return
    sync_flags_for_decision(ledger.stored_envelope(entry).model_dump())


def install_ledger_subscriber() -> None:
    """Subscribe :func:`persist_flags_entry` to ``moderation.decision`` records."""
    ledger.subscribe(DECISION_TYPE, persist_flags_entry)


install_ledger_subscriber()
