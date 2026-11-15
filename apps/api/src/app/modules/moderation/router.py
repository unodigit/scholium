"""HTTP routes for the moderation plugin.

The module loader mounts this router under ``/v1``, so the routes below serve
``GET /v1/moderation/policies`` and ``GET /v1/moderation/queue``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends

from app import db
from app.modules import checks, content, ledger, sanitizer, submissions
from app.modules.identity.models import Account, ensure_account_table
from app.security import Principal, require_tier

from .policies import PolicyClause, get_clauses

router = APIRouter(prefix="/moderation", tags=["moderation"])


@router.get("/policies", response_model=list[PolicyClause])
def list_policies() -> list[PolicyClause]:
    """Return every moderation policy clause from policies.yaml.

    The response is the public clause list: ``[{id, title, text}, ...]``
    in file order. A broken or missing policies file surfaces as a 500
    problem-details response via the app-wide error handlers.
    """
    return get_clauses()


_NEW_ACCOUNT_MAX_AGE = timedelta(days=90)


def _now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _age_hours(received_at: Any) -> float:
    if received_at is None:
        return 0.0
    if getattr(received_at, "tzinfo", None) is not None:
        received_at = received_at.replace(tzinfo=None)
    now = _now_naive()
    delta = now - received_at
    seconds = delta.total_seconds()
    if seconds < 0:
        seconds = 0.0
    return seconds / 3600.0



def _scan_result_for(manifest_cid: Any) -> str:
    """Derive a version's scan verdict from its manifest and stored reports."""
    try:
        entry = ledger.entry_by_cid(manifest_cid) if isinstance(manifest_cid, str) else None
    except Exception:
        entry = None
    file_cids: list[str] = []
    if entry is not None:
        body = getattr(entry, "body", None)
        if isinstance(body, dict):
            files = body.get("files")
            if isinstance(files, list):
                for f in files:
                    if isinstance(f, dict) and isinstance(f.get("cid"), str):
                        file_cids.append(f["cid"])
            # manifest record body may nest files under "body"? already handled
            if not file_cids:
                manifest_body = body.get("body") if isinstance(body.get("body"), dict) else None
                if isinstance(manifest_body, dict):
                    files = manifest_body.get("files")
                    if isinstance(files, list):
                        for f in files:
                            if isinstance(f, dict) and isinstance(f.get("cid"), str):
                                file_cids.append(f["cid"])
    if not file_cids:
        return "passed"
    passed = True
    for cid in file_cids:
        reports = sanitizer.reports_for(cid)
        if any(getattr(r, "result", None) != sanitizer.RESULT_PASSED for r in reports):
            # only a 'failed' report fails it; an empty report list is not a failure
            if any(getattr(r, "result", None) == sanitizer.RESULT_FAILED for r in reports):
                passed = False
                break
        blob = content.get_blob(cid)
        if blob is not None and getattr(blob, "scan_status", None) not in (None, content.SCAN_PASSED):
            passed = False
            break
    return "passed" if passed else "failed"

def _build_queue() -> list[dict[str, Any]]:
    submissions.ensure_tables()
    checks.ensure_check_results_table()
    ensure_account_table()
    ledger.ensure_table()

    from app.modules.submissions.models import PaperVersion

    with db.SessionLocal() as session:
        session.expire_on_commit = False
        versions = (
            session.query(PaperVersion)
            .filter(PaperVersion.state == "moderation")
            .all()
        )
        for v in versions:
            session.expunge(v)

    now = _now_naive()
    result: list[dict[str, Any]] = []
    for version in versions:
        paper = submissions.get_paper(version.paper_cid)
        categories = list(paper.categories) if paper is not None and paper.categories else []
        short_id = paper.short_id if paper is not None else None

        ledger_entry = ledger.entry_by_cid(version.version_cid)
        received_at = getattr(ledger_entry, "received_at", None) if ledger_entry is not None else None
        age_hours = _age_hours(received_at)

        check_result = checks.get_check_result(version.version_cid)
        similarity_pct = getattr(check_result, "similarity_pct", None) if check_result is not None else None
        references_unresolved = (
            getattr(check_result, "references_unresolved", None) if check_result is not None else None
        )

        authors = submissions.authorship_for(version.version_cid)
        did = authors[0].author_did if authors else None
        new_account = True
        if did:
            with db.SessionLocal() as session:
                account = session.get(Account, did)
                if account is not None and account.created_at is not None:
                    created = account.created_at
                    if getattr(created, "tzinfo", None) is not None:
                        created = created.replace(tzinfo=None)
                    new_account = (now - created) < _NEW_ACCOUNT_MAX_AGE

        scan_result = _scan_result_for(version.manifest_cid)
        entry: dict[str, Any] = {
            "version_cid": version.version_cid,
            "cid": version.version_cid,
            "paper_cid": version.paper_cid,
            "short_id": short_id,
            "title": version.title,
            "category": (categories[0] if categories else None),
            "categories": categories,
            "age_hours": age_hours,
            "similarity_pct": similarity_pct,
            "references_unresolved": references_unresolved,
            "scan_result": scan_result,
            "scan_status": scan_result,
            "scan": scan_result,
            "new_account": new_account,
            "is_new_account": new_account,
        }
        result.append(entry)

    return result


@router.get("/queue")
def list_queue(
    principal: Principal = Depends(require_tier(4)),
) -> list[dict[str, Any]]:
    """Return versions currently waiting in ``moderation`` state.

    Each entry carries the automated signals a moderator decides with: the
    paper's category, the version's age in hours, the similarity percentage
    and unresolved reference count saved by the automated checks, the file
    scan result and whether the submitting account is new.
    """
    return _build_queue()
