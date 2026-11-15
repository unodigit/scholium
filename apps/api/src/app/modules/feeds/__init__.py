"""Category feeds plugin (features 88 and 89).

The module loader imports every package under ``app.modules`` and mounts the
``router`` it finds under ``/v1``; exposing it here is the only wiring this
plugin needs.

Features 88 and 89 are implemented here:

* ``GET /v1/feeds/{category}`` -- an Atom feed of the newest papers listed in a
  category, each entry carrying the paper's ``sch:`` id (as the entry ``<id>``)
  and its status (as ``<sch:status>``).
* ``GET /v1/feeds/{category}?format=json`` -- the same papers as a JSON Feed
  1.1 document, each item carrying the paper's ``sch:`` id (as ``id``) and its
  status and version (in the ``_scholium`` extension object).

The papers come from the catalog's own listing
(:func:`app.modules.catalog.listing.list_papers`), so a feed shows exactly the
papers -- and the versions of them -- that ``GET /v1/papers?category=...``
does.  See :mod:`app.modules.feeds.router` for the HTTP surface,
:mod:`app.modules.feeds.atom` and :mod:`app.modules.feeds.jsonfeed` for the
two documents.
"""

from __future__ import annotations

from .router import router

__all__ = ["router"]
