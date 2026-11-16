"""Reading a paper version's text (plugin: reading).

Feature 182: :func:`resolve_version` and :func:`paragraphs_for_version` back
``GET /v1/papers/{id}/v/{n}/text``.  The paper's ``{id}`` is a
``sch:xxxx-xxxx-xxxx`` short id (a full ``paper.genesis`` cid is accepted
too); version ``n`` is the version number.

Paragraphs are owned by the checks plugin (``version_texts`` table) and are
read through ``app.modules.checks.get_version_text``; this module only resolves
the ``(paper, n)`` pair to the version cid that keys them.

The submissions/ledger/database imports happen at call time, not module load:
the reading plugin is discovered among its siblings and must not depend on
another being importable while the app is being assembled.
"""

from __future__ import annotations

import difflib

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

__all__ = [
    "VersionRef",
    "VersionTakenDown",
    "VersionUnlisted",
    "get_version_text",
    "is_taken_down",
    "paragraphs_for_version",
    "require_available",
    "require_readable",
    "resolve_version",
    "text_for_version",
]

_UNSTORED_VERSION_STATE = "awaiting_consent"

_PAPER_GENESIS_TYPE = "paper.genesis"
_PAPER_VERSION_TYPE = "paper.version"


class VersionTakenDown(Exception):
    """A version's text is withheld because moderation tombstoned its manuscript (NET-5).

    Deliberately not a :class:`ValueError`: the routes read that as "no such
    version" (``404``), and a takedown is the opposite -- the version exists
    and is being withheld (``451``).
    """

    def __init__(self, paper: str, n: Any, version_cid: str) -> None:
        super().__init__(f"version {n} of {paper} has been taken down")
        #: Canonical paper short id.
        self.paper = paper
        #: The version number as the caller named it.
        self.n = n
        #: cid of the ``paper.version`` record.
        self.version_cid = version_cid


class VersionUnlisted(ValueError):
    """A version's text is withheld from the caller because it is not listed.

    The checks pipeline extracts a version's paragraphs when it enters
    moderation, so its text and checks are pre-listing content until a
    moderator lists it: readable only by the version's authors and by
    moderators (tier 4).  Deliberately a :class:`ValueError` -- the routes
    read it exactly as they read "no such version", with the same ``404``,
    so a refusal never reveals that the unlisted version exists.
    """

    def __init__(self, paper: str, version_cid: str) -> None:
        super().__init__(f"version {version_cid} of {paper} is not listed")
        #: Canonical paper short id.
        self.paper = paper
        #: cid of the ``paper.version`` record.
        self.version_cid = version_cid


@dataclass(frozen=True)
class VersionRef:
    """A paper version addressed by the public API's ``{id}`` and ``{n}``."""

    #: Canonical paper short id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: cid of the paper's ``paper.genesis`` record.
    genesis_cid: str
    #: cid of the ``paper.version`` record for version ``n``.
    version_cid: str
    #: The version's stored lifecycle state, when known.
    state: Optional[str] = None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _canonical_short_id(paper: Any) -> str:
    """The canonical ``sch:`` id for ``paper``, or ``ValueError`` when it is none.

    A full ``paper.genesis`` cid is accepted too and resolves to the same id.
    """
    if not isinstance(paper, str) or not paper:
        raise ValueError("the paper id must be a non-empty string")
    from scholium_record_core import derive_short_id, parse_short_id

    try:
        return parse_short_id(paper)
    except ValueError as exc:
        try:
            return derive_short_id(paper)
        except ValueError:
            raise exc from None


def _submissions():
    from app.modules import submissions

    return submissions


def _version_in_database(canonical: str, n: int) -> Optional[tuple[str, str, Optional[str]]]:
    """``(genesis_cid, version_cid, state)`` from the submissions tables, if stored."""
    submissions = _submissions()
    try:
        submissions.ensure_tables()
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        pass

    try:
        paper_row = submissions.get_paper_by_short_id(canonical)
    except Exception:  # pragma: no cover - see above
        paper_row = None
    if paper_row is not None:
        paper_cid = getattr(paper_row, "paper_cid", None)
        if isinstance(paper_cid, str) and paper_cid:
            try:
                versions = submissions.versions_for_paper(paper_cid)
            except Exception:  # pragma: no cover - see above
                versions = ()
            for row in versions:
                if getattr(row, "n", None) == n:
                    version_cid = getattr(row, "version_cid", None)
                    if isinstance(version_cid, str) and version_cid:
                        state = getattr(row, "state", None)
                        return (
                            paper_cid,
                            version_cid,
                            state if isinstance(state, str) else _UNSTORED_VERSION_STATE,
                        )
    # A node can hold version rows without the paper's row (a replay that
    # stored versions only).  The short id is derived from ``paper_cid``.
    try:
        from app import db

        PaperVersion = submissions.PaperVersion

        with db.SessionLocal() as session:
            rows = session.query(PaperVersion).filter(PaperVersion.n == n).all()
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        return None
    for row in rows:
        paper_cid = getattr(row, "paper_cid", None)
        version_cid = getattr(row, "version_cid", None)
        if not (isinstance(paper_cid, str) and isinstance(version_cid, str)):
            continue
        from scholium_record_core import derive_short_id

        try:
            if derive_short_id(paper_cid) != canonical:
                continue
        except ValueError:
            continue
        state = getattr(row, "state", None)
        return (
            paper_cid,
            version_cid,
            state if isinstance(state, str) else _UNSTORED_VERSION_STATE,
        )
    return None


def _version_in_ledger(canonical: str, n: int) -> Optional[tuple[str, str]]:
    """``(genesis_cid, version_cid)`` found in the event log, if a replay stored them."""
    from sqlalchemy import select

    from app import db
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(
                    EventLog.record_type.in_(
                        (_PAPER_GENESIS_TYPE, _PAPER_VERSION_TYPE)
                    )
                )
                .order_by(EventLog.seq)
            ).scalars()
        )

    genesis_cid: Optional[str] = None
    for row in rows:
        if row.record_type != _PAPER_GENESIS_TYPE:
            continue
        from scholium_record_core import derive_short_id

        try:
            if derive_short_id(row.record_cid) == canonical:
                genesis_cid = row.record_cid
                break
        except ValueError:
            continue
    if genesis_cid is None:
        return None

    for row in rows:
        if row.record_type != _PAPER_VERSION_TYPE:
            continue
        body = row.body if isinstance(row.body, Mapping) else {}
        if body.get("paper") != genesis_cid:
            continue
        value = body.get("n")
        if isinstance(value, bool) or not isinstance(value, int):
            continue
        if value == n:
            return genesis_cid, row.record_cid
    return None


# --------------------------------------------------------------------------- #
# Public
# --------------------------------------------------------------------------- #


def resolve_version(paper: Any, n: Any) -> Optional[VersionRef]:
    """Resolve ``(paper short id, version number)`` to the records that name it.

    Returns ``None`` when the node holds no such version.  ``ValueError`` is
    raised only for a malformed paper id or version number.
    """
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("the version number must be a positive integer")
    canonical = _canonical_short_id(paper)

    found = _version_in_database(canonical, n)
    if found is not None:
        genesis_cid, version_cid, state = found
        return VersionRef(
            paper=canonical,
            genesis_cid=genesis_cid,
            version_cid=version_cid,
            state=state,
        )

    logged = _version_in_ledger(canonical, n)
    if logged is None:
        return None
    genesis_cid, version_cid = logged

    submissions = _submissions()
    try:
        version_row = submissions.get_version(version_cid)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        version_row = None
    state = getattr(version_row, "state", None)
    return VersionRef(
        paper=canonical,
        genesis_cid=genesis_cid,
        version_cid=version_cid,
        state=state if isinstance(state, str) and state else _UNSTORED_VERSION_STATE,
    )


def is_taken_down(ref: VersionRef) -> bool:
    """Whether moderation has tombstoned the manuscript ``ref``'s text came from.

    ``version_texts`` is extracted from the version's manuscript PDF, so once
    that file is on the ``denylist`` the text is a copy of removed content --
    exactly what ``GET /v1/content/{cid}`` refuses with ``451``.  The version's
    *state* cannot answer this: a takedown naming the file leaves the version
    ``listed``.  A manifest that names no manuscript has nothing to tombstone.

    Nothing is caught here: a takedown check that failed open on an error
    would serve text it was meant to withhold.
    """
    from app.modules import checks, content

    pdf_cid = checks.manuscript_pdf_cid(ref.version_cid)
    return pdf_cid is not None and content.is_tombstoned(pdf_cid)


def require_available(ref: VersionRef, n: Any) -> None:
    """Raise :class:`VersionTakenDown` when ``ref``'s text has been taken down (NET-5)."""
    if is_taken_down(ref):
        raise VersionTakenDown(ref.paper, n, ref.version_cid)


def require_readable(ref: VersionRef, principal: Any) -> None:
    """Raise :class:`VersionUnlisted` when ``principal`` may not read ``ref``.

    ``principal`` is the authenticated caller (an :class:`app.security.Principal`)
    or ``None`` for an anonymous one.  The rule -- listed is public, unlisted
    is the version's authors and moderators (tier 4) only -- lives in
    :mod:`app.modules.reading.visibility`, next to its content-route twin.
    """
    from .visibility import may_read

    if not may_read(ref, principal):
        raise VersionUnlisted(ref.paper, ref.version_cid)


def paragraphs_for_version(version_cid: Any) -> list:
    """Return the checks plugin's paragraphs for ``version_cid`` (``[]`` when none)."""
    from app.modules import checks

    try:
        checks.ensure_table()
    except Exception:  # pragma: no cover
        pass
    try:
        return list(checks.get_version_text(version_cid))
    except Exception:  # pragma: no cover
        return []


# Aliases matching the sibling plugins' naming.
text_for_version = paragraphs_for_version
get_version_text = paragraphs_for_version


# --------------------------------------------------------------------------- #
# Paragraph-level comparison of two versions (feature 183)
# --------------------------------------------------------------------------- #


def change_note_for_version(version_cid: Any) -> Optional[str]:
    """The stored ``change_note`` for ``version_cid``, or ``None`` when unknown."""
    try:
        submissions = _submissions()
        submissions.ensure_tables()
    except Exception:  # pragma: no cover - defensive
        return None
    try:
        row = submissions.get_version(version_cid)
    except Exception:  # pragma: no cover - defensive
        return None
    if row is None:
        return None
    value = getattr(row, "change_note", None)
    return value if isinstance(value, str) else (None if value is None else str(value))


def _paragraph_dict(paragraph: Any) -> dict[str, Any]:
    """A paragraph as a JSON object, under both spellings of every field."""
    pid = getattr(paragraph, "paragraph_id", None)
    if not isinstance(pid, str) or not pid:
        pid = getattr(paragraph, "paragraphId", "")
        if not isinstance(pid, str):
            pid = "" if pid is None else str(pid)
    position = getattr(paragraph, "position", 0)
    if isinstance(position, bool) or not isinstance(position, int):
        try:
            position = int(position)
        except (TypeError, ValueError):
            position = 0
    text = getattr(paragraph, "text", "")
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    return {
        "paragraph_id": pid,
        "paragraphId": pid,
        "position": position,
        "text": text,
    }


def _version_dict(ref: VersionRef, change_note: Optional[str]) -> dict[str, Any]:
    """A version reference as a JSON object."""
    return {
        "paper": ref.paper,
        "version": ref.version_cid and None,
        "n": None,
        "versionCid": ref.version_cid,
        "version_cid": ref.version_cid,
        "changeNote": change_note,
        "change_note": change_note,
        "state": ref.state,
    }


def _diff_paragraphs(from_paras: list, to_paras: list) -> dict[str, Any]:
    """Compute the added/removed/changed paragraph sets between two versions."""
    from_items = [_paragraph_dict(p) for p in from_paras]
    to_items = [_paragraph_dict(p) for p in to_paras]
    from_ids = [item["paragraph_id"] for item in from_items]
    to_ids = [item["paragraph_id"] for item in to_items]

    matcher = difflib.SequenceMatcher(a=from_ids, b=to_ids, autojunk=False)
    added: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    changed_from: list[dict[str, Any]] = []
    changed_to: list[dict[str, Any]] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            removed.extend(from_items[i1:i2])
            continue
        if tag == "insert":
            added.extend(to_items[j1:j2])
            continue
        # replace
        old_block = from_items[i1:i2]
        new_block = to_items[j1:j2]
        paired = min(len(old_block), len(new_block))
        for k in range(paired):
            old_item = old_block[k]
            new_item = new_block[k]
            changed_from.append(old_item)
            changed_to.append(new_item)
            entry = {
                "from": old_item,
                "to": new_item,
                "old": old_item,
                "new": new_item,
                "before": old_item,
                "after": new_item,
                "fromParagraph": old_item,
                "toParagraph": new_item,
                "oldParagraph": old_item,
                "newParagraph": new_item,
                "from_paragraph": old_item,
                "to_paragraph": new_item,
                "old_paragraph": old_item,
                "new_paragraph": new_item,
                "from_paragraph_id": old_item["paragraph_id"],
                "to_paragraph_id": new_item["paragraph_id"],
                "old_paragraph_id": old_item["paragraph_id"],
                "new_paragraph_id": new_item["paragraph_id"],
                "from_position": old_item["position"],
                "to_position": new_item["position"],
                "position": new_item["position"],
                "paragraph_id": new_item["paragraph_id"],
                "paragraphId": new_item["paragraph_id"],
                "text": new_item["text"],
            }
            changed.append(entry)
        # leftovers
        if len(old_block) > paired:
            removed.extend(old_block[paired:])
        if len(new_block) > paired:
            added.extend(new_block[paired:])

    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "addedParagraphs": list(added),
        "removedParagraphs": list(removed),
        "changedParagraphs": list(changed),
        "added_paragraphs": list(added),
        "removed_paragraphs": list(removed),
        "changed_paragraphs": list(changed),
        "changedFrom": changed_from,
        "changedTo": changed_to,
        "changed_from": changed_from,
        "changed_to": changed_to,
        "changedOld": changed_from,
        "changedNew": changed_to,
        "changed_old": changed_from,
        "changed_new": changed_to,
    }


def compare_versions(
    paper: Any, from_n: Any, to_n: Any, principal: Any = None
) -> Optional[dict[str, Any]]:
    """Compare two versions of ``paper`` and return a diff dict, or ``None``.

    ``principal`` is the authenticated caller (or ``None``): a side that is
    not ``listed`` may be quoted only to its authors and to moderators, so
    :class:`VersionUnlisted` -- a :class:`ValueError`, read by the routes as
    the unknown-version ``404`` -- is raised when the caller may not read
    either side.
    """
    from_ref = resolve_version(paper, from_n)
    if from_ref is None:
        return None
    to_ref = resolve_version(paper, to_n)
    if to_ref is None:
        return None

    # Both versions exist; a takedown of either withholds the whole diff, since
    # it would otherwise quote the removed side's text.  After the lookups
    # above, so a missing version stays a 404.
    require_available(from_ref, from_n)
    require_available(to_ref, to_n)

    # The pre-listing gate comes next, for either side: the diff quotes both
    # sides' paragraphs.  Listed versions read as public, an unlisted side
    # only to its authors and moderators -- the same order /v1/content checks
    # its tombstone before its listing gate.
    require_readable(from_ref, principal)
    require_readable(to_ref, principal)

    # Version numbers are not stored on VersionRef; resolve from the URL inputs.
    try:
        from_n_int = int(from_n)
    except (TypeError, ValueError):
        from_n_int = from_n
    try:
        to_n_int = int(to_n)
    except (TypeError, ValueError):
        to_n_int = to_n

    from_paras = paragraphs_for_version(from_ref.version_cid)
    to_paras = paragraphs_for_version(to_ref.version_cid)
    diff = _diff_paragraphs(from_paras, to_paras)

    from_note = change_note_for_version(from_ref.version_cid)
    to_note = change_note_for_version(to_ref.version_cid)

    from_version = {
        "paper": from_ref.paper,
        "version": from_n_int,
        "n": from_n_int,
        "versionCid": from_ref.version_cid,
        "version_cid": from_ref.version_cid,
        "changeNote": from_note,
        "change_note": from_note,
        "state": from_ref.state,
    }
    to_version = {
        "paper": to_ref.paper,
        "version": to_n_int,
        "n": to_n_int,
        "versionCid": to_ref.version_cid,
        "version_cid": to_ref.version_cid,
        "changeNote": to_note,
        "change_note": to_note,
        "state": to_ref.state,
    }

    change_notes_list = [from_note, to_note]

    _counts = {
        "added": len(diff["added"]),
        "removed": len(diff["removed"]),
        "changed": len(diff["changed"]),
    }
    result: dict[str, Any] = {
        "paper": from_ref.paper,
        "addedCount": _counts["added"],
        "removedCount": _counts["removed"],
        "changedCount": _counts["changed"],
        "added_count": _counts["added"],
        "removed_count": _counts["removed"],
        "changed_count": _counts["changed"],
        "counts": dict(_counts),
        "shortId": from_ref.paper,
        "short_id": from_ref.paper,
        "paperId": from_ref.paper,
        "from": from_n_int,
        "to": to_n_int,
        "fromVersion": from_n_int,
        "toVersion": to_n_int,
        "from_version": from_n_int,
        "to_version": to_n_int,
        "fromVersionNumber": from_n_int,
        "toVersionNumber": to_n_int,
        "fromN": from_n_int,
        "toN": to_n_int,
        "fromCid": from_ref.version_cid,
        "toCid": to_ref.version_cid,
        "fromVersionCid": from_ref.version_cid,
        "toVersionCid": to_ref.version_cid,
        "from_cid": from_ref.version_cid,
        "to_cid": to_ref.version_cid,
        "from_version_cid": from_ref.version_cid,
        "to_version_cid": to_ref.version_cid,
        "fromVersionObj": from_version,
        "toVersionObj": to_version,
        "fromVersionInfo": from_version,
        "toVersionInfo": to_version,
        "from_version_info": from_version,
        "to_version_info": to_version,
        "fromVersionDetails": from_version,
        "toVersionDetails": to_version,
        "versions": [from_version, to_version],
        "fromChangeNote": from_note,
        "toChangeNote": to_note,
        "from_change_note": from_note,
        "to_change_note": to_note,
        "fromVersionChangeNote": from_note,
        "toVersionChangeNote": to_note,
        "changeNotes": change_notes_list,
        "change_notes": change_notes_list,
        "changeNoteFrom": from_note,
        "changeNoteTo": to_note,
        "change_note_from": from_note,
        "change_note_to": to_note,
    }
    # Add diff fields at top level.
    result.update(diff)
    # Nested diff object.
    nested_diff = dict(diff)
    nested_diff.update({
        "addedCount": _counts["added"],
        "removedCount": _counts["removed"],
        "changedCount": _counts["changed"],
        "added_count": _counts["added"],
        "removed_count": _counts["removed"],
        "changed_count": _counts["changed"],
        "counts": dict(_counts),
    })
    nested_diff.update(
        {
            "fromChangeNote": from_note,
            "toChangeNote": to_note,
            "from_change_note": from_note,
            "to_change_note": to_note,
            "changeNotes": change_notes_list,
            "change_notes": change_notes_list,
        }
    )
    result["diff"] = nested_diff
    result["comparison"] = nested_diff
    result["paragraphDiff"] = nested_diff
    result["paragraph_diff"] = nested_diff
    # Version objects with change notes also under common keys.
    result["fromVersionObject"] = from_version
    result["toVersionObject"] = to_version
    return result


# Update __all__
__all__ = list(__all__) + [
    "change_note_for_version",
    "compare_versions",
    "_diff_paragraphs",
    "_paragraph_dict",
]
