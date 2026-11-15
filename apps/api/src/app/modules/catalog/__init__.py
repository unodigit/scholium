"""Paper catalog plugin (features 79-82).

The module loader imports every package under ``app.modules`` and mounts the
``router`` it finds under ``/v1``; exposing it here is the only wiring this
plugin needs.

Feature 79 is implemented here:

* ``GET /v1/papers/{id}`` -- read one listed paper.  ``{id}`` is a paper
  ``sch:`` id (``sch:xxxx-xxxx-xxxx``), a version id
  (``sch:xxxx-xxxx-xxxx/vN``) or a version cid, and the response describes
  that version (the latest listed one for a paper id) with its title,
  abstract, authors, categories, licence, status, notices and version number.

Feature 80 is implemented here too:

* ``GET /v1/papers/{id}/versions`` -- the version timeline of a paper: each
  listed version's ``n``, ``cid``, ``change_note`` and ``listed_at`` (oldest
  first) with its ``anchor`` status, always ``pending`` until the node anchors
  its log on-chain.

Feature 81 is implemented here too:

* ``GET /v1/papers/{id}/v/{n}/manifest`` -- the files of one listed version:
  each file's ``path``, ``cid``, ``size``, ``mediaType`` and ``role`` from the
  signed ``manifest`` record, the version's ``licence`` and the file's live
  ``scanStatus`` from the content store.

An unlisted version -- a draft, one still awaiting co-author consent, one
rejected or held -- is invisible to anonymous readers and answers ``404``,
as does an id this node does not hold.  Reading is public, like reading a
record.

See :mod:`app.modules.catalog.service` for resolving an id to a paper and
version, and :mod:`app.modules.catalog.router` for the HTTP surface.
"""

from __future__ import annotations

from .router import router

__all__ = ["router"]
