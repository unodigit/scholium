"""HTTP routes for the moderation plugin.

The module loader mounts this router under ``/v1``, so the route below
serves ``GET /v1/moderation/policies``.
"""

from __future__ import annotations

from fastapi import APIRouter

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
