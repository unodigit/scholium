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

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

__all__ = [
    "VersionRef",
    "get_version_text",
    "paragraphs_for_version",
    "resolve_version",
    "text_for_version",
]

_UNSTORED_VERSION_STATE = "awaiting_consent"

_PAPER_GENESIS_TYPE = "paper.genesis"
_PAPER_VERSION_TYPE = "paper.version"


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
