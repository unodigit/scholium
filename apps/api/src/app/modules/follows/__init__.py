"""Follows plugin: follow categories, the Following feed and saved searches.

The module loader imports every package under ``app.modules`` and mounts the
``router`` it finds under ``/v1``.  This package serves:

* ``PUT /v1/me/follows/{category}`` -- save that the caller follows a category
  (``204``), idempotently, in the ``follows`` table;
* ``DELETE /v1/me/follows/{category}`` -- remove that follow (``204``), for the
  follow toggle;
* ``POST /v1/me/saved-searches`` -- save a search to re-run later (``201``),
  one row per save, in the ``saved_searches`` table;
* ``GET /v1/papers?tab=following`` -- the listed papers filed under any
  category the caller follows, in the catalog's usual shape, sorts and cursor.

The catalog plugin (feature 82) mounted before this one serves
``GET /v1/papers`` for ``latest`` and ``reviewed`` but not ``following``, and
the module loader offers no way to extend another plugin's route.  So this
package exposes the ``/papers`` route itself, delegating the two catalog tabs
unchanged, and its startup hook moves its mounted router ahead of the catalog's
in the assembled app (see :func:`prioritise_papers_route`).  That is the only
wiring seam the loader provides and it keeps the change inside this plugin.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI

from .models import Follow, SavedSearch, ensure_table, ensure_tables
from .router import PAPERS_PATH, router
from .service import (
    MAX_CATEGORY_LENGTH,
    MAX_QUERY_CHARS,
    InvalidCategory,
    InvalidSearchQuery,
    follow_category,
    followed_categories,
    is_following,
    normalise_category,
    normalise_query,
    save_search,
    unfollow_category,
)

__all__ = [
    "Follow",
    "InvalidCategory",
    "InvalidSearchQuery",
    "MAX_CATEGORY_LENGTH",
    "MAX_QUERY_CHARS",
    "PAPERS_PATH",
    "SavedSearch",
    "ensure_table",
    "ensure_tables",
    "follow_category",
    "followed_categories",
    "is_following",
    "normalise_category",
    "normalise_query",
    "on_startup",
    "prioritise_papers_route",
    "router",
    "save_search",
    "unfollow_category",
]


def _catalog_router() -> Any:
    from app.modules.catalog.router import router as catalog_router

    return catalog_router


def prioritise_papers_route(app: FastAPI) -> None:
    """Place this plugin's ``/papers`` route ahead of the catalog's.

    The module loader mounts one router per package in import (alphabetical)
    order, so ``catalog`` would otherwise answer ``GET /v1/papers`` first and
    reject ``tab=following`` as an unknown tab.  FastAPI matches routes in
    order, so moving this plugin's mounted router before the catalog's lets the
    Following tab through; every other tab is delegated to the catalog verbatim.

    The function is idempotent so a test that assembles an app again does not
    keep moving routes.
    """
    from app.modules.catalog.router import list_papers as catalog_endpoint

    from .router import list_papers as follows_endpoint
    from .router import router as follows_router

    routes = getattr(getattr(app, "router", None), "routes", None)
    if not routes:
        return

    catalog_router = _catalog_router()
    full_path = "/v1" + PAPERS_PATH
    wrapped = any(getattr(route, "original_router", None) is not None for route in routes)

    ours: Optional[int] = None
    catalog: Optional[int] = None
    for index, route in enumerate(routes):
        if wrapped:
            # FastAPI 0.16x keeps each included router as a wrapper rather than
            # copying its routes into the app's flat list.
            original = getattr(route, "original_router", None)
            if original is follows_router:
                ours = index
            elif original is catalog_router and catalog is None:
                catalog = index
        else:
            if getattr(route, "path", None) != full_path:
                continue
            endpoint = getattr(route, "endpoint", None)
            if endpoint is follows_endpoint:
                ours = index
            elif endpoint is catalog_endpoint and catalog is None:
                catalog = index

    if ours is None or catalog is None or ours < catalog:
        return
    routes.insert(catalog, routes.pop(ours))


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Move this plugin's ``/papers`` route ahead of the catalog's (see above)."""
    if app is not None:
        prioritise_papers_route(app)
