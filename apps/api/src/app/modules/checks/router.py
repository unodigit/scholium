"""HTTP route for a version's advisory checks report (bug: empty checks).

The module loader mounts :data:`router` under ``/v1``, so this package serves::

    GET /v1/papers/{paper_id}/v/{n}/checks

It returns the report the submit wizard's Checks step polls
(``apps/web/src/features/submit/checks.ts``): the version's file-safety rows
from the sanitizer, and the similarity, reference and metadata-match columns
the background extraction job saves to ``check_results``.

Reading follows the reading routes' rule, because the report quotes the
version's text and the pipeline runs for a version as soon as it enters
``moderation``: a ``listed`` version's checks are public, like reading a
record or a consent report, while an unlisted version's are pre-listing
content, served only to that version's authors and to moderators (tier 4).
Everyone else, anonymous callers included, gets the unknown-version
**404 problem+json** -- the same answer as for a version this node does not
hold, and the one the web client already treats as "checks pending".  The
rule lives in :mod:`app.modules.reading.visibility`, next to its
content-route twin; it comes before the pending check, so a caller who may
not read the version cannot even tell whether its checks have run.

An ``Authorization: Bearer`` access token is optional: it is read only to
widen access to an unlisted version (the caller's authorship or moderator
tier).  A token that is missing or unusable simply leaves the caller
anonymous.

The payload carries both the natural camelCase spelling and the flat
snake_case spellings of the ``check_results`` columns, because the web
normalizer accepts either.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.errors import ProblemException
from app.security import InvalidAccessToken, Principal, decode_access_token

from .models import ensure_check_results_table
from .pipeline import manifest_entries
from .results import get_check_result

__all__ = ["router"]

#: Router the module loader mounts under ``/v1``.
router = APIRouter(tags=["checks"])


def _not_found(paper_id: str, n: int) -> ProblemException:
    return ProblemException(
        404,
        f"No paper {paper_id!r} has a version {n} on this node.",
    )


def _checks_pending(version_cid: str) -> ProblemException:
    return ProblemException(
        404,
        f"The checks for version {version_cid!r} have not run yet.",
    )


def _resolve(paper_id: str, n: int):
    """Resolve ``(paper, n)`` to the reading plugin's :class:`VersionRef`."""
    from app.modules.reading import service as reading

    try:
        return reading.resolve_version(paper_id, n)
    except ValueError:
        return None


#: Bearer credentials, read only to widen access to an unlisted version.
_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``.

    The report is public for a listed version; a token matters only for a
    version that is not listed yet, where it carries the caller's authorship
    or moderator tier.  A token that is present but unusable is ignored
    rather than turning a readable report into a ``401`` (the same courtesy
    ``content.router`` pays its readers).
    """
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None


def _file_report(entry: dict[str, Any]) -> dict[str, Any]:
    """One manifest file with its sanitizer verdict, in the web's shape."""
    from app.modules import content, sanitizer

    cid = entry.get("cid")
    cid = cid if isinstance(cid, str) else ""
    path = entry.get("path")
    path = path if isinstance(path, str) and path else cid
    role = entry.get("role")
    role = role if isinstance(role, str) else None

    status = "pending"
    if cid:
        blob = content.get_blob(cid)
        if blob is not None and getattr(blob, "scan_status", None):
            status = str(blob.scan_status)

    failed: list[str] = []
    detail: Optional[str] = None
    if cid:
        for report in sanitizer.reports_for(cid):
            if getattr(report, "result", None) == sanitizer.RESULT_FAILED:
                failed.append(str(report.check_name))
                if detail is None:
                    detail = getattr(report, "detail", None)

    if failed:
        status = "failed"

    return {
        "path": path,
        "cid": cid,
        "role": role,
        "status": status,
        "failedChecks": failed,
        "detail": detail,
    }


def _signed_title(version_cid: str) -> Optional[str]:
    """The version's title from its signed record, when this node has it."""
    from app.modules import ledger

    try:
        entry = ledger.entry_by_cid(version_cid)
        body = getattr(entry, "body", None) if entry is not None else None
        title = body.get("title") if isinstance(body, dict) else None
    except Exception:  # pragma: no cover - a damaged log is not a normal path
        return None
    return title if isinstance(title, str) and title.strip() else None


@router.get(
    "/papers/{paper_id}/v/{n}/checks",
    summary="Return a paper version's advisory checks report",
)
def get_paper_checks(
    paper_id: str,
    n: int,
    principal: Optional[Principal] = Depends(_optional_principal),
) -> dict[str, Any]:
    """Return version ``n``'s checks report, or a 404 problem until checks ran."""
    from app.modules.reading import visibility

    ref = _resolve(paper_id, n)
    if ref is None:
        raise _not_found(paper_id, n)
    if not visibility.may_read(ref, principal):
        # Pre-listing report the caller may not see: the unknown-version 404,
        # ahead of the pending check so it never reveals whether the version
        # exists or whether its checks have run.
        raise _not_found(paper_id, n)

    ensure_check_results_table()
    result = get_check_result(ref.version_cid)
    if result is None:
        raise _checks_pending(ref.version_cid)

    similarity_pct = getattr(result, "similarity_pct", None)
    references_total = getattr(result, "references_total", None)
    references_unresolved = getattr(result, "references_unresolved", None)
    metadata_match = getattr(result, "metadata_match", None)
    signed_title = _signed_title(ref.version_cid)

    return {
        "paper": ref.paper,
        "version": n,
        "versionCid": ref.version_cid,
        "version_cid": ref.version_cid,
        "state": ref.state or "",
        "files": [_file_report(dict(entry)) for entry in manifest_entries(ref.version_cid)],
        "similarity": {"pct": similarity_pct},
        "similarityPct": similarity_pct,
        "similarity_pct": similarity_pct,
        "references": {
            "total": references_total,
            "unresolved": references_unresolved,
        },
        "referencesTotal": references_total,
        "referencesUnresolved": references_unresolved,
        "references_total": references_total,
        "references_unresolved": references_unresolved,
        "metadata": {"match": metadata_match, "signedTitle": signed_title},
        "metadataMatch": metadata_match,
        "metadata_match": metadata_match,
        "signedTitle": signed_title,
        "firstPageTitle": None,
        "checkedAt": None,
    }
