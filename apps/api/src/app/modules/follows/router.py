"""HTTP routes for the follows plugin (feature 179).

The module loader mounts ``router`` under ``/v1``, so this package serves::

    PUT    /v1/me/follows/{category}     -- follow a category (204)
    DELETE /v1/me/follows/{category}     -- unfollow a category (204)
    GET    /v1/papers?tab=following      -- listed papers in followed categories

``PUT`` and ``DELETE`` authenticate with the caller's access token; any trust
tier may manage its own follows.  Both are idempotent: repeating either is
``204``.

``GET /v1/papers?tab=following`` is the follows plugin's contribution to the
catalog listing (feature 82).  The catalog router is mounted before this one
and accepts only ``latest`` and ``reviewed``, so this package exposes the
``/papers`` route itself and places it ahead of the catalog's at assembly time
(see :func:`app.modules.follows.prioritise_papers_route`).  Every tab delegates
to the same catalog listing, so ``latest`` and ``reviewed`` behave exactly as
without this plugin; only ``following`` is new.  The Following tab requires an
access token because the list is the caller's own; the other tabs stay public.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import (
    APIRouter,
    Depends,
    Path,
    Query,
    Request,
    Response,
)
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.modules.catalog import listing as catalog_listing
from app.modules.catalog.router import (
    PaperListOut,
    _list_item_out,
    list_papers as catalog_list_papers,
)
from app.security import Principal, get_current_principal

from . import service
from .listing import list_following

__all__ = [
    "PAPERS_PATH",
    "list_papers",
    "router",
]

#: Router mounted under ``/v1`` by the module loader.
router = APIRouter(tags=["follows"])

#: The routes under ``/v1/me``.
_me_router = APIRouter(prefix="/me", tags=["follows"])

#: The catalog-listing route this plugin extends (full path under ``/v1``).
PAPERS_PATH = "/papers"

#: A follow route is addressed by a category, which the catalog bounds too.
_CATEGORY = Path(
    ...,
    min_length=1,
    max_length=service.MAX_CATEGORY_LENGTH,
    description="the category to follow, e.g. cs.AI",
)

_bearer = HTTPBearer(auto_error=False)


def _problem(status_code: int, detail: str):
    """An RFC 9457 problem response; imported lazily to avoid an import cycle."""
    from app.errors import ProblemException

    return ProblemException(status_code, detail)


def _following_principal(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """Authenticate the caller when the request asks for the Following tab.

    The catalog's other tabs are public, so a credential is not required for
    them (and one that is sent there is ignored, exactly as the catalog ignores
    it).  ``tab=following`` lists the caller's own feed and therefore requires a
    usable access token; :func:`~app.security.get_current_principal` answers the
    usual ``401`` problem details otherwise.
    """
    if request.query_params.get("tab") != "following":
        return None
    return get_current_principal(request, credentials)


@_me_router.put(
    "/follows/{category}",
    status_code=204,
    response_class=Response,
    summary="Follow a category",
)
def put_follow(
    category: str = _CATEGORY,
    principal: Principal = Depends(get_current_principal),
) -> Response:
    """Save that the caller follows ``category``; ``204`` even if already followed."""
    try:
        service.follow_category(principal.did, category)
    except service.InvalidCategory as exc:
        raise _problem(422, str(exc)) from None
    return Response(status_code=204)


@_me_router.delete(
    "/follows/{category}",
    status_code=204,
    response_class=Response,
    summary="Unfollow a category",
)
def delete_follow(
    category: str = _CATEGORY,
    principal: Principal = Depends(get_current_principal),
) -> Response:
    """Remove the caller's follow of ``category``; ``204`` even if not followed."""
    try:
        service.unfollow_category(principal.did, category)
    except service.InvalidCategory as exc:
        raise _problem(422, str(exc)) from None
    return Response(status_code=204)


router.include_router(_me_router)


@router.get(
    "/papers",
    response_model=PaperListOut,
    include_in_schema=False,
    summary="List the papers in the catalog (including the Following tab)",
)
def list_papers(
    tab: Literal["latest", "reviewed", "following"] = Query(
        default="latest",
        description=(
            "latest: every listed paper; reviewed: status reviewed; "
            "following: papers in the caller's followed categories"
        ),
    ),
    category: Optional[str] = Query(
        default=None,
        min_length=1,
        max_length=service.MAX_CATEGORY_LENGTH,
        description="keep papers in this category",
    ),
    sort: Literal["newest", "recently_reviewed", "recently_updated"] = Query(
        default="newest", description="the order of the list, newest first"
    ),
    cursor: Optional[str] = Query(
        default=None, max_length=512, description="the nextCursor of the previous page"
    ),
    limit: int = Query(
        default=catalog_listing.DEFAULT_LIMIT,
        ge=1,
        le=catalog_listing.MAX_LIMIT,
        description="the most papers on one page",
    ),
    caller: Optional[Principal] = Depends(_following_principal),
) -> PaperListOut:
    """Return one page of the listed papers, including the caller's follows."""
    if tab != "following":
        # Delegate unchanged: latest/reviewed keep the catalog's own semantics,
        # including its cursor rules and problem details for a bad cursor.
        return catalog_list_papers(
            tab=tab, category=category, sort=sort, cursor=cursor, limit=limit
        )

    if caller is None:  # pragma: no cover - the dependency rejects this tab
        raise _problem(401, "Authentication is required for the following tab.")
    try:
        page = list_following(
            caller.did,
            category=category,
            sort=sort,
            cursor=cursor,
            limit=limit,
        )
    except (catalog_listing.InvalidCursor, ValueError) as exc:
        raise _problem(422, str(exc)) from None
    return PaperListOut(
        items=[_list_item_out(entry) for entry in page.entries],
        nextCursor=page.next_cursor,
    )
