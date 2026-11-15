"""Resumable uploads over tus 1.0.0 (plugin: uploads).

Exposes :data:`router`, which the module loader mounts under ``/v1``:

* ``OPTIONS /v1/uploads`` — tus discovery (version, extensions, max size);
* ``POST /v1/uploads`` — tus creation: answers ``201 Created`` with a
  ``Location`` header naming the new upload resource, and ``413``
  problem details for a PDF over 50 MiB or a bundle over 5 GiB.

Upload state lives in the ``uploads`` table (:mod:`.store`) so later
features — byte-appending ``PATCH`` and ``HEAD`` offsets — can resume
what creation started. Importing :data:`router` (or :class:`.store.Upload`)
registers the model on ``db.Base`` before ``create_all`` runs.
"""

from . import limits, store
from .router import router
from .store import Upload

__all__ = ["Upload", "limits", "router", "store"]
