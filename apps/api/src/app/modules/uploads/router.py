"""tus 1.0.0 upload creation endpoint (plugin: uploads).

``POST /v1/uploads`` is a tus *creation* extension endpoint: the client
declares the total size (``Upload-Length``) and, optionally, base64
metadata about the file, and the server answers ``201 Created`` with a
``Location`` header pointing at the freshly created upload resource
(``/v1/uploads/{id}``). The bytes themselves travel later, in
``PATCH`` requests, which is what makes the upload resumable.

The protocol rules implemented here come from the tus 1.0.0 core and
creation specs (https://tus.io/protocols/resumable-upload.html):

* every request carries ``Tus-Resumable: 1.0.0``; any other or missing
  version is a ``412 Precondition Failed`` answered with the versions
  we do support in ``Tus-Version``;
* creation needs a non-negative integer ``Upload-Length``, or
  ``Upload-Defer-Length: 1`` when the size is not yet known — sending
  both, or neither, is a ``400``;
* a size over the limit for the upload's kind is a ``413`` problem
  details document naming the limit.

Every error leaves this module as an ``HTTPException``, which the
app-wide RFC 9457 handlers render as ``application/problem+json``.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.exc import SQLAlchemyError

from app.db import SessionLocal
from app.security import InvalidAccessToken, decode_access_token

from . import limits, store

router = APIRouter(tags=["uploads"])

UPLOAD_TOO_LARGE_TYPE = "urn:scholium:problem:upload-too-large"


def _tus_headers(extra: Optional[dict[str, str]] = None) -> dict[str, str]:
    headers = {"Tus-Resumable": limits.TUS_VERSION}
    if extra:
        headers.update(extra)
    return headers


def _reject(status_code: int, detail: str, *, headers: Optional[dict[str, str]] = None) -> HTTPException:
    return HTTPException(status_code=status_code, detail=detail, headers=headers)


def _reject_too_large(kind: str, upload_length: int, limit: int) -> HTTPException:
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and if this package is imported before app.main the module
    # loader would then see `app.modules.uploads` half-initialized with no
    # `router` attribute and silently skip mounting it.
    from app.errors import ProblemException

    return ProblemException(
        413,
        f"{limits.limit_description(kind)} ({limit} bytes); "
        f"the declared Upload-Length is {upload_length} bytes.",
        type=UPLOAD_TOO_LARGE_TYPE,
        limit_bytes=limit,
        upload_length=upload_length,
        kind=kind,
        headers=_tus_headers({"Tus-Version": limits.TUS_VERSION}),
    )


def _require_tus_version(request: Request) -> None:
    """Enforce the tus version handshake, answering 412 for anything but 1.0.0."""
    version = request.headers.get("tus-resumable")
    if version is None or version.strip() != limits.TUS_VERSION:
        raise _reject(
            412,
            f"This endpoint speaks tus {limits.TUS_VERSION}: send a 'Tus-Resumable: {limits.TUS_VERSION}' header.",
            headers=_tus_headers({"Tus-Version": limits.TUS_VERSION}),
        )


def _parse_upload_length(request: Request) -> tuple[Optional[int], bool]:
    """Return ``(declared_length_or_None, defer_length)`` for a creation request."""
    raw_length = request.headers.get("upload-length")
    raw_defer = request.headers.get("upload-defer-length")
    defer_length = raw_defer is not None

    if defer_length and raw_defer.strip() != "1":
        raise _reject(400, "The Upload-Defer-Length header, when present, must be '1'.")

    length: Optional[int] = None
    if raw_length is not None:
        candidate = raw_length.strip()
        if not candidate.isdigit():
            raise _reject(400, f"The Upload-Length header must be a non-negative integer, got {raw_length!r}.")
        length = int(candidate)
        if defer_length:
            raise _reject(400, "Send either Upload-Length or Upload-Defer-Length: 1, not both.")

    if length is None and not defer_length:
        raise _reject(
            400,
            "Creation requires the total size: send an 'Upload-Length' header, "
            "or 'Upload-Defer-Length: 1' when it is not yet known.",
        )
    return length, defer_length


def _optional_owner_did(request: Request) -> Optional[str]:
    """The caller's DID when a valid access token came along, else ``None``.

    Creation itself is open: a missing or unusable token never blocks
    the upload, it only leaves the upload unowned.
    """
    authorization = request.headers.get("authorization", "")
    if not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    if not token:
        return None
    try:
        return decode_access_token(token).did
    except (InvalidAccessToken, ValueError):
        return None


@router.options("/uploads")
def upload_options() -> Response:
    """tus server discovery: which version and extensions we speak."""
    return Response(
        status_code=204,
        headers=_tus_headers(
            {
                "Tus-Version": limits.TUS_VERSION,
                "Tus-Extension": "creation",
                "Tus-Max-Size": str(limits.MAX_UPLOAD_BYTES),
            }
        ),
    )


@router.post("/uploads", status_code=201)
def create_upload(request: Request) -> Response:
    """Create an upload resource and point the client at it (tus creation)."""
    _require_tus_version(request)
    upload_length, defer_length = _parse_upload_length(request)

    metadata_header = request.headers.get("upload-metadata")
    metadata = limits.parse_upload_metadata(metadata_header)
    kind = limits.classify_upload(metadata, content_type=request.headers.get("content-type"))

    if upload_length is not None:
        exceeded = limits.check_upload_length(upload_length, kind)
        if exceeded is not None:
            raise _reject_too_large(kind, upload_length, exceeded)

    owner_did = _optional_owner_did(request)
    try:
        session = SessionLocal()
        try:
            upload = store.create_upload(
                session,
                upload_length=upload_length,
                defer_length=defer_length,
                upload_metadata=metadata_header or "",
                kind=kind,
                owner_did=owner_did,
            )
        finally:
            session.close()
    except SQLAlchemyError as exc:  # pragma: no cover - defensive: storage is down
        raise _reject(503, "Upload storage is unavailable; retry shortly.") from exc

    return Response(
        status_code=201,
        headers=_tus_headers({"Location": f"/v1/uploads/{upload.id}"}),
    )
