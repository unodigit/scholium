"""HTTP routes for the follows plugin (features 179 and 180).

The module loader mounts ``router`` under ``/v1``, so this package serves::

    GET    /v1/me/follows                -- the caller's followed categories (200)
    PUT    /v1/me/follows/{category}     -- follow a category (204)
    DELETE /v1/me/follows/{category}     -- unfollow a category (204)
    GET    /v1/papers?tab=following      -- listed papers in followed categories
    GET    /v1/me/saved-searches         -- the caller's saved searches (200)
    POST   /v1/me/saved-searches         -- save a search to re-run later (201)

``PUT`` and ``DELETE`` authenticate with the caller's access token; any trust
tier may manage its own follows.  Both are idempotent: repeating either is
``204``.  ``GET /v1/me/follows`` reads the same table back as
``{"categories": [...]}`` -- the list the dashboard and the follow toggle show.

``POST /v1/me/saved-searches`` (feature 180) saves the caller's search to the
``saved_searches`` table, and ``GET /v1/me/saved-searches`` reads the caller's
saves back as ``{"items": [...]}``, one row per save in the ``POST`` shape.
The body carries the search as
``{"query": {...}}`` -- the filters of ``GET /v1/search`` (feature 86), stored
in the canonical form :func:`app.modules.follows.service.normalise_query`
produces so the save can be re-run as entered.  Each save is its own row and
answers ``201`` with ``{"id": ..., "did": ..., "query": {...}}``; a query that
could never be re-run (unknown keys, a blank ``q``, no filter at all) is
``422`` problem details.

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

from typing import Any, Literal, Optional

from fastapi import (
    APIRouter,
    Body,
    Depends,
    Path,
    Query,
    Request,
    Response,
)
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.modules.catalog import listing as catalog_listing
from app.modules.catalog.router import (
    PaperListOut,
    _list_item_out,
    list_papers as catalog_list_papers,
)
from app.security import Principal, get_current_principal

from . import service
from .listing import list_following
from .models import SavedSearch

__all__ = [
    "PAPERS_PATH",
    "FollowsOut",
    "SavedSearchOut",
    "SavedSearchListOut",
    "list_follows",
    "list_papers",
    "list_saved_searches",
    "save_search",
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


class FollowsOut(BaseModel):
    """The caller's followed categories, as the client reads them back."""

    #: Every category the caller follows, in a stable (alphabetical) order.
    categories: list[str]


@_me_router.get(
    "/follows",
    response_model=FollowsOut,
    summary="List followed categories",
)
def list_follows(
    principal: Principal = Depends(get_current_principal),
) -> FollowsOut:
    """Return every category the caller follows, alphabetically.

    The dashboard and the follow toggle read this to say which categories are
    already followed; ``categories`` is empty when the caller follows none.
    """
    return FollowsOut(categories=service.followed_categories(principal.did))


class SavedSearchOut(BaseModel):
    """A saved search as the client reads it back."""

    #: The save's identifier (``ss_...``).
    id: str
    #: The reader who saved the search (the caller).
    did: str
    #: The search's filters in canonical form, re-runnable as entered.
    query: dict[str, Any]


@_me_router.post(
    "/saved-searches",
    status_code=201,
    response_model=SavedSearchOut,
    summary="Save a search",
)
def save_search(
    payload: Any = Body(
        default=None,
        examples=[
            {
                "query": {
                    "q": "pulsar timing",
                    "category": ["cs.CR"],
                    "status": ["reviewed"],
                    "has_code": True,
                    "from": "2026-03-02",
                    "to": "2026-04-01",
                }
            }
        ],
    ),
    principal: Principal = Depends(get_current_principal),
) -> SavedSearchOut:
    """Save the caller's search to the ``saved_searches`` table.

    The body is ``{"query": {...}}`` with the filters of ``GET /v1/search``;
    the response is ``201`` with the stored search, ``query`` in canonical
    form.  A body without a ``query`` object, or a query this node could not
    re-run, is ``422`` problem details.
    """
    query = payload.get("query") if isinstance(payload, dict) else None
    if query is None:
        raise _problem(422, "query is required.")
    try:
        search: SavedSearch = service.save_search(principal.did, query)
    except service.InvalidSearchQuery as exc:
        raise _problem(422, str(exc)) from None
    return SavedSearchOut(id=search.id, did=search.did, query=search.query)


class SavedSearchListOut(BaseModel):
    """The caller's saved searches, as the client reads them back."""

    #: Every search the caller saved, in a stable (by id) order.
    items: list[SavedSearchOut]


@_me_router.get(
    "/saved-searches",
    response_model=SavedSearchListOut,
    summary="List saved searches",
)
def list_saved_searches(
    principal: Principal = Depends(get_current_principal),
) -> SavedSearchListOut:
    """Return every search the caller saved, each in the ``POST`` shape.

    ``items`` is empty when the caller has saved no search; each row carries
    the stored ``query`` in canonical form, re-runnable as entered.
    """
    searches = service.saved_searches(principal.did)
    return SavedSearchListOut(
        items=[
            SavedSearchOut(id=search.id, did=search.did, query=search.query)
            for search in searches
        ]
    )


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
