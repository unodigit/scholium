"""Resumable uploads over tus 1.0.0 (plugin: uploads).

Exposes :data:`router`, which the module loader mounts under ``/v1``:

* ``OPTIONS /v1/uploads`` — tus discovery (version, extensions, max size);
* ``POST /v1/uploads`` — tus creation: answers ``201 Created`` with a
  ``Location`` header naming the new upload resource, and ``413``
  problem details for a PDF over 50 MiB or a bundle over 5 GiB;
* ``PATCH /v1/uploads/{id}`` — appends the body at ``Upload-Offset`` and
  answers ``204`` with the new offset, or ``409`` when that is not the
  offset the server is at. The ``PATCH`` that completes the upload moves it
  into the content store and also answers with ``Upload-Cid``, its raw CID;
* ``HEAD /v1/uploads/{id}`` — reports the received ``Upload-Offset`` so an
  interrupted client knows where to resume.

Upload state lives in the ``uploads`` table (:mod:`.store`): the offset
recorded there is the truth about what has been received. The bytes
themselves are staged under ``CONTENT_DIR/.uploads/{id}`` until the upload
completes, when :mod:`.finalize` hands them to the content plugin and deletes
the staged copy. Importing :data:`router` (or :class:`.store.Upload`)
registers the model on ``db.Base`` before ``create_all`` runs.
"""

from typing import Optional

from fastapi import FastAPI

from app.db import engine

from . import finalize, limits, store
from .router import router
from .store import Upload

__all__ = ["Upload", "finalize", "limits", "on_startup", "router", "store"]


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Module-loader hook: bring an ``uploads`` table from an older release up to date.

    Runs before ``create_all``, which builds the table whole when it is missing
    and never alters one that exists.
    """
    store.ensure_columns(engine)
