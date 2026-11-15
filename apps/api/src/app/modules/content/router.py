"""Serve stored bytes: ``GET /v1/content/{cid}`` (plugin: content).

The module loader mounts this router under ``/v1``, so the single route
below serves ``GET /v1/content/{cid}`` -- the bytes of a file already in
the content store.

Serving is deliberately strict, because these are untrusted uploads:

* bytes are handed out **only** for a blob whose ``scan_status`` is
  ``passed``; a blob still in ``scanning`` answers ``423 Locked`` and one
  the sanitizer rejected (or that moderation tombstoned) answers
  ``451 Unavailable For Legal Reasons``;
* a cid with no ``blobs`` row, or one that is not a canonical file id,
  answers ``404`` -- a malformed id is simply not content we have;
* every served byte response carries ``Content-Security-Policy: sandbox``
  so user content can never run script in the application's origin, and
  ``X-Content-Type-Options: nosniff`` so a declared ``text/plain`` can
  never be sniffed into HTML.  No ``Set-Cookie`` is emitted (the endpoint
  is cookie-less), so a served file cannot plant a session.

Errors are RFC 9457 problem details, rendered by the app-wide handlers.

Tombstoning lives in the moderation plugin (feature 73), which records the
cid in the shared ``denylist`` table and deletes the bytes.  The check here
is intentionally by table name rather than by importing moderation's
model, so this feature keeps working whether or not that plugin is
installed.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException
from starlette.responses import FileResponse

from . import service
from .models import SCAN_PASSED, SCAN_SCANNING
from .store import blob_path

__all__ = [
    "CONTENT_SECURITY_POLICY",
    "NOSNIFF",
    "router",
    "SECURITY_HEADERS",
]

#: CSP for served user content: an empty sandbox blocks scripts, forms,
#: popups and same-origin access.  It is the one directive the spec names.
CONTENT_SECURITY_POLICY = "sandbox"

#: Never let a browser second-guess the declared media type.
NOSNIFF = "nosniff"

#: Headers attached to every response that carries file bytes.
SECURITY_HEADERS = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": NOSNIFF,
}

#: Fallback when the uploader declared no media type.
DEFAULT_MEDIA_TYPE = "application/octet-stream"

router = APIRouter(prefix="/content", tags=["content"])


def _problem(status_code: int, detail: str) -> HTTPException:
    """An RFC 9457 problem response for this route.

    Imported at raise time, not module load: importing ``app.errors`` pulls in
    ``app.main``, and doing that while the module loader is importing packages
    would leave ``app.modules.content`` half-initialized without a ``router``
    attribute (the same care ``uploads.router`` takes).
    """
    from app.errors import ProblemException

    return ProblemException(status_code, detail)


def _not_found(cid: str) -> HTTPException:
    return _problem(404, f"No content is stored for cid {cid!r}.")


@router.get("/{cid}")
def get_content(cid: str) -> FileResponse:
    """Return the stored bytes for ``cid`` when (and only when) they are safe."""
    try:
        path = blob_path(cid)
    except ValueError:
        # Not a canonical raw-codec file id: nothing can be stored under it,
        # and treating it as "not found" avoids reflecting it in a path.
        raise _not_found(cid) from None

    if service.is_tombstoned(cid):
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: it has been removed by moderation.",
        )

    blob = service.get_blob(cid)
    if blob is None:
        raise _not_found(cid)

    if blob.scan_status == SCAN_SCANNING:
        raise _problem(
            423,
            f"Content {cid!r} is still being scanned; retry once scanning completes.",
        )
    if blob.scan_status != SCAN_PASSED:
        # A failed scan is permanent: the bytes must never be served.  Report
        # it like a tombstone rather than as a transient condition.
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: it did not pass safety scanning.",
        )

    try:
        stat_result = os.stat(path)
    except FileNotFoundError:
        # A passed row whose bytes are gone is a takedown (or corruption);
        # either way the content is not available.
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: its bytes have been removed.",
        ) from None

    return FileResponse(
        path,
        media_type=blob.media_type or DEFAULT_MEDIA_TYPE,
        headers=SECURITY_HEADERS,
        stat_result=stat_result,
    )
