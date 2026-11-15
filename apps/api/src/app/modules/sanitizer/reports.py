"""Reading and writing the ``scan_reports`` table (plugin: sanitizer).

Every check that finds something wrong records a ``failed`` row for the file
it inspected::

    from app.modules import sanitizer

    sanitizer.record_report(cid, "javascript", detail="...")
    sanitizer.reports_for(cid)          # rows, ordered by check name
    sanitizer.has_failure(cid)          # True
    sanitizer.first_failure(cid)        # the first failed row, or None

Writes are upserts keyed by ``(cid, check_name)``: scanning the same content
twice leaves one current verdict per check rather than duplicate findings,
and a later passing verdict replaces an earlier failure for that same check.
Rows are returned detached from any session, with every attribute loaded.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy.exc import IntegrityError

from app import db

from .errors import InvalidScanReport
from .models import RESULT_FAILED, RESULTS, ScanReport, ensure_table

__all__ = [
    "delete_reports",
    "first_failure",
    "has_failure",
    "record_finding",
    "record_report",
    "reports_for",
]

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidScanReport(
            f"{field} must be a non-empty string, got {_show(value)}"
        )
    return value


def record_report(
    cid: str,
    check_name: str,
    *,
    result: str = RESULT_FAILED,
    detail: Optional[str] = None,
) -> ScanReport:
    """Insert or update the verdict of ``check_name`` for file ``cid``.

    Args:
        cid: the scanned file's id.
        check_name: the check that produced this verdict (for example
            ``"javascript"``).
        result: :data:`~.models.RESULT_FAILED` (the default) or
            :data:`~.models.RESULT_PASSED`.
        detail: a human-readable explanation; ``None`` when there is none.

    Raises:
        InvalidScanReport: if any required field is empty or ``result`` is
            not one of :data:`~.models.RESULTS`.
    """
    cid = _text(cid, "cid")
    check_name = _text(check_name, "check_name")
    if result not in RESULTS:
        raise InvalidScanReport(
            f"result {_show(result)} must be one of {', '.join(RESULTS)}"
        )
    if detail is not None and not isinstance(detail, str):
        raise InvalidScanReport(
            f"detail must be a string or None, got {type(detail).__name__}"
        )
    if detail == "":
        detail = None

    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        report = _upsert(session, cid, check_name, result, detail)
        session.expunge(report)
        return report


def record_finding(
    cid: str,
    check_name: str,
    detail: Optional[str] = None,
) -> ScanReport:
    """Record a ``failed`` finding for ``cid``; shorthand for :func:`record_report`."""
    return record_report(cid, check_name, result=RESULT_FAILED, detail=detail)


def _upsert(
    session,
    cid: str,
    check_name: str,
    result: str,
    detail: Optional[str],
) -> ScanReport:
    report = session.get(ScanReport, (cid, check_name))
    if report is None:
        report = ScanReport(
            cid=cid, check_name=check_name, result=result, detail=detail
        )
        session.add(report)
        try:
            session.commit()
            return report
        except IntegrityError:
            # A concurrent scan inserted the same (cid, check_name) first;
            # fall through and update theirs rather than failing the scan.
            session.rollback()
            report = session.get(ScanReport, (cid, check_name))
            if report is None:  # pragma: no cover - conflict row vanished
                raise
    report.result = result
    report.detail = detail
    session.commit()
    return report


def reports_for(cid: str) -> list[ScanReport]:
    """Every scan report for ``cid``, ordered by check name.

    A ``cid`` that is not a string has no reports, so it gives ``[]``.
    """
    if not isinstance(cid, str):
        return []
    ensure_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        rows = (
            session.query(ScanReport)
            .filter(ScanReport.cid == cid)
            .order_by(ScanReport.check_name)
            .all()
        )
        for row in rows:
            session.expunge(row)
        return rows


def delete_reports(cid: str) -> int:
    """Delete every report for ``cid`` and return how many rows were removed."""
    if not isinstance(cid, str):
        return 0
    ensure_table()
    with db.SessionLocal() as session:
        removed = (
            session.query(ScanReport)
            .filter(ScanReport.cid == cid)
            .delete(synchronize_session=False)
        )
        session.commit()
        return removed


def has_failure(cid: str) -> bool:
    """Whether any recorded check for ``cid`` failed."""
    return first_failure(cid) is not None


def first_failure(cid: str) -> Optional[ScanReport]:
    """The first ``failed`` report for ``cid`` in check-name order, or ``None``."""
    for report in reports_for(cid):
        if report.result == RESULT_FAILED:
            return report
    return None
