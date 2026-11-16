"""Resumable uploads over tus 1.0.0 (plugin: uploads).

Exposes :data:`router`, which the module loader mounts under ``/v1``. Every
route below except ``OPTIONS`` needs an access token of trust tier 1 or above
(``401``/``403`` otherwise), and an upload belongs to the DID that created it:
another caller's upload is a ``404``. A DID may have a limited number of bytes
in flight (``UPLOAD_QUOTA_BYTES``, ``413`` ``upload-quota-exceeded``), and an
upload left unfinished longer than ``UPLOAD_TTL_SECONDS`` (24 hours) is deleted
by the periodic ``uploads.reap`` job (:mod:`.reaper`).

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

import logging
from datetime import timedelta
from typing import Optional

from fastapi import FastAPI

from app import jobs
from app.db import engine

from . import config, finalize, limits, reaper, store
from .router import router
from .store import Upload

__all__ = ["Upload", "config", "finalize", "limits", "on_startup", "reaper", "router", "store"]

logger = logging.getLogger(__name__)


def on_startup(app: Optional[FastAPI] = None) -> None:
    """Module-loader hook: bring an ``uploads`` table from an older release up to date.

    Runs before ``create_all``, which builds the table whole when it is missing
    and never alters one that exists. When jobs run on the background worker it
    also queues the abandoned-upload reaper (once: a run already waiting is kept);
    in eager mode (``JOBS_EAGER=1``) no worker would ever pick it up, so nothing
    is queued. Failing to queue it is logged and never keeps the app from starting.
    """
    store.ensure_columns(engine)
    if not jobs.is_eager():
        try:
            reaper.schedule_reaper(delay=timedelta(0))
        except Exception:
            logger.exception("could not queue the abandoned-upload reaper")
