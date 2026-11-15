"""Tombstoning content (plugin: moderation, feature 73).

A ``moderation.decision`` with ``action: tombstone`` takes content down for
legal reasons -- policy clause MOD-05 -- without breaking history.  Applying
one does two things to the *bytes* and nothing to the *record*:

* the cid is saved to the ``denylist`` table, with the decision that put it
  there.  The content plugin reads that table to answer ``451`` and to refuse
  to serve, run or export the bytes;
* the bytes are deleted from the blob directory.

The signed envelopes, the ``event_log`` entries (including the decision's own)
and the ``blobs`` row are left exactly as they were.  The hash-chained log and
the records' signatures never covered the bytes -- a manifest names a file by
the hash of its content -- so every ``prev`` link, signature and consent still
checks out, and ``scholium_record_core.verify_paper`` still passes (reporting
the paper ``tombstoned`` for an authority's tombstone, which is a notice and
never a verification failure).  The ``blobs`` row stays so a manifest that
lists the file is still a manifest this node can show.

What a tombstone names
----------------------

``body.target`` is one of (the same three ``verify_paper`` recognises):

==============  ===============================================================
a file          a well-formed file cid (``bafkrei...``).  That one file is
                tombstoned; no version changes state.  The node need not hold
                the file -- denylisting a cid it was never sent keeps it out
==============  ===============================================================
a version       every file its manifest lists is tombstoned, and the version
                leaves the catalog (``rejected``) when its state allows
a paper         the same for every version of the paper
==============  ===============================================================

Anything else is :class:`~.errors.UnknownDecisionTarget` (``422``).

Safe to repeat
--------------

Every step is idempotent and ordered so a failure part-way is repaired by
running it again: the denylist row is saved *before* the bytes are deleted
(so nothing is ever served once a tombstone has begun), a file that is
already gone is not an error, and the first decision to tombstone a cid stays
the one on record.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from scholium_record_core import parse_file_cid
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import content, ledger, submissions

from .errors import UnknownDecisionTarget
from .models import Denylist, ensure_tables

__all__ = [
    "TOMBSTONE",
    "TOMBSTONED",
    "Tombstone",
    "TombstoneScope",
    "get_denylist_entry",
    "resolve_scope",
    "tombstone_cid",
    "tombstone_target",
]

#: The ``moderation.decision`` action that takes content down.
TOMBSTONE = "tombstone"

#: The state a tombstone decision reports to ingest (it is not a version state).
TOMBSTONED = "tombstoned"

_EXPECTED = "a paper, a paper version this node holds, or a file id"


@dataclass(frozen=True)
class Tombstone:
    """The outcome of tombstoning one cid."""

    cid: str
    #: The decision on record for this cid -- the first one to tombstone it.
    decision_cid: str
    #: Whether bytes were on disk and have now been deleted.
    bytes_deleted: bool


@dataclass(frozen=True)
class TombstoneScope:
    """What a tombstone's ``target`` stands for."""

    #: The versions that leave the catalog, in version order; empty for a file.
    version_cids: tuple[str, ...]
    #: Every file cid whose bytes go, in a stable order without repeats.
    file_cids: tuple[str, ...]


# --------------------------------------------------------------------------- #
# The denylist
# --------------------------------------------------------------------------- #


def get_denylist_entry(cid: object) -> Optional[Denylist]:
    """The ``denylist`` row for ``cid``, or ``None`` when it is not tombstoned."""
    if not isinstance(cid, str) or not cid:
        return None
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Denylist, cid)
        if row is not None:
            session.expunge(row)
        return row


def _delete_bytes(cid: str) -> bool:
    """Remove the stored bytes of ``cid``; ``False`` when there were none."""
    try:
        content.blob_path(cid).unlink()
    except FileNotFoundError:
        return False
    return True


def tombstone_cid(cid: str, decision_cid: str) -> Tombstone:
    """Save ``cid`` to the ``denylist`` table and delete its bytes.

    The row goes in first: from then on the content plugin refuses the cid
    whether or not the delete below succeeds.  A cid that is already
    denylisted keeps the decision that first put it there, and its bytes are
    deleted again -- so a retry after a failed delete finishes the job, and
    bytes uploaded again since (the upload path does not consult the denylist)
    are removed on the next tombstone of the cid.

    Raises:
        ValueError: ``cid`` is not a canonical file id.  Nothing is changed.
        OSError: the bytes exist but could not be deleted.  The cid is
            already denylisted; repeat the call to retry the delete.
    """
    parse_file_cid(cid)
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Denylist, cid)
        if row is None:
            session.add(Denylist(cid=cid, decision_cid=decision_cid))
            try:
                session.commit()
            except IntegrityError:
                # Another writer denylisted the cid between the read and now;
                # its row is the one on record.
                session.rollback()
                row = session.get(Denylist, cid)
                if row is None:
                    raise
                recorded = str(row.decision_cid)
            else:
                recorded = decision_cid
        else:
            recorded = str(row.decision_cid)

    return Tombstone(cid=cid, decision_cid=recorded, bytes_deleted=_delete_bytes(cid))


# --------------------------------------------------------------------------- #
# What a target stands for
# --------------------------------------------------------------------------- #


def _manifest_file_cids(manifest_cid: object) -> list[str]:
    """The file cids the ``manifest`` record ``manifest_cid`` lists, in order."""
    if not isinstance(manifest_cid, str) or not manifest_cid:
        return []
    entry = ledger.entry_by_cid(manifest_cid)
    body: Any = getattr(entry, "body", None)
    files = body.get("files") if isinstance(body, dict) else None
    if not isinstance(files, list):
        return []
    return [
        item["cid"]
        for item in files
        if isinstance(item, dict) and isinstance(item.get("cid"), str) and item["cid"]
    ]


def resolve_scope(target: object) -> TombstoneScope:
    """What tombstoning ``target`` takes down.

    ``target`` is looked up as a version, then a paper, then a file id; the
    cids of the three never overlap (a file id is the raw codec, a record id
    the DAG-CBOR one).  Nothing is read from the disk and nothing is changed.

    Raises:
        UnknownDecisionTarget: ``target`` is none of the three.
    """
    if not isinstance(target, str) or not target:
        raise UnknownDecisionTarget(target, _EXPECTED)

    version = submissions.get_version(target)
    if version is not None:
        versions = [version]
    elif submissions.get_paper(target) is not None:
        versions = list(submissions.versions_for_paper(target))
    else:
        try:
            parse_file_cid(target)
        except ValueError:
            raise UnknownDecisionTarget(target, _EXPECTED) from None
        return TombstoneScope(version_cids=(), file_cids=(target,))

    files: list[str] = []
    for item in versions:
        files.extend(_manifest_file_cids(item.manifest_cid))
    return TombstoneScope(
        version_cids=tuple(str(item.version_cid) for item in versions),
        file_cids=tuple(dict.fromkeys(files)),
    )


# --------------------------------------------------------------------------- #
# Applying a tombstone decision
# --------------------------------------------------------------------------- #


def tombstone_target(
    target: str,
    decision_cid: str,
    *,
    actor: str,
    reason: Optional[str] = None,
) -> list[Tombstone]:
    """Tombstone everything ``target`` stands for, on behalf of a decision.

    Files go first, then the versions leave the catalog: a version is moved to
    ``rejected`` unless it already is, or the natural state graph has no edge
    to it (a ``draft`` is not in the catalog to begin with).  A takedown is
    never refused for the state a version happens to be in -- unlike ``list``
    or ``hold``, it must work on content that is still ``scanning``.

    Returns the tombstone of each file, in the order :func:`resolve_scope`
    gives them.

    Raises:
        UnknownDecisionTarget: see :func:`resolve_scope`.
        OSError: a file's bytes could not be deleted; see :func:`tombstone_cid`.
    """
    scope = resolve_scope(target)
    outcome = [tombstone_cid(cid, decision_cid) for cid in scope.file_cids]

    for version_cid in scope.version_cids:
        version = submissions.get_version(version_cid)
        if version is None:
            continue
        current = str(version.state)
        if current != submissions.REJECTED and submissions.can_transition(
            current, submissions.REJECTED
        ):
            submissions.transition_version(
                version_cid, submissions.REJECTED, actor=actor, reason=reason
            )
    return outcome
