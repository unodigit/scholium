"""tus 1.0.0 upload creation endpoint (plugin: uploads).

``POST /v1/uploads`` is a tus *creation* extension endpoint: the client
declares the total size (``Upload-Length``) and, optionally, base64
metadata about the file, and the server answers ``201 Created`` with a
``Location`` header pointing at the freshly created upload resource
(``/v1/uploads/{id}``). The bytes themselves travel later, in
``PATCH`` requests, which is what makes the upload resumable.

``PATCH /v1/uploads/{id}`` appends the request body to the upload at the
byte offset named by ``Upload-Offset`` and answers ``204 No Content`` with
the new ``Upload-Offset``. ``HEAD /v1/uploads/{id}`` reports how many bytes
the server has so far in its ``Upload-Offset`` header, which is how an
interrupted client finds where to continue. A ``PATCH`` whose offset is not
the server's current one is a ``409 Conflict`` carrying the current offset:
appending anywhere else would corrupt the file.

The protocol rules implemented here come from the tus 1.0.0 core and
creation specs (https://tus.io/protocols/resumable-upload.html):

* every request carries ``Tus-Resumable: 1.0.0``; any other or missing
  version is a ``412 Precondition Failed`` answered with the versions
  we do support in ``Tus-Version``;
* creation needs a non-negative integer ``Upload-Length``, or
  ``Upload-Defer-Length: 1`` when the size is not yet known — sending
  both, or neither, is a ``400``;
* a size over the limit for the upload's kind is a ``413`` problem
  details document naming the limit;
* a ``PATCH`` carries ``Content-Type: application/offset+octet-stream``
  (``415`` otherwise) and a non-negative integer ``Upload-Offset``
  (``400`` otherwise); an upload created with ``Upload-Defer-Length: 1``
  learns its size from an ``Upload-Length`` header on a ``PATCH``;
* a ``PATCH`` that would take the upload past its length is a ``413``
  and changes nothing.

The ``PATCH`` that delivers the last byte also moves the upload into the content
store (see :mod:`.finalize`) and answers ``204`` with ``Upload-Cid``: the raw-codec
CIDv1 of the whole file, under which it is now stored and recorded in ``blobs``.
Earlier ``PATCH`` responses carry no ``Upload-Cid``. If that response is lost, or
the move fails (``503``), the client repeats the ``PATCH`` with the same
``Upload-Offset`` and an empty body: a stored upload answers ``204`` with the same
``Upload-Cid`` and still refuses any bytes (``413``).

Beyond the protocol: bytes that arrive before a connection drops are kept
and counted, so the client resumes from where the server really is; two
requests appending to one upload at once cannot both write (the second is
answered ``423 Locked`` and should retry); and a failed ``PATCH`` never
leaves an offset the file does not back.

Who may do what: creating, inspecting (``HEAD``) and appending to or completing
(``PATCH``) an upload all need an access token of trust tier 1 (Member) or above
-- ``401`` without a usable one, ``403`` below tier 1. An upload belongs to the DID
that created it, and to nobody else: for any other caller (whatever their tier)
and for an unowned upload left by an older release it is a ``404``, exactly as if
the id did not exist, so ids cannot be probed and nobody else's CID is revealed.
Each DID may have only so many bytes in flight (:mod:`.config`): a creation that
would take it past that is a ``413`` ``upload-quota-exceeded`` problem. Each DID
also has a daily allowance covering bytes in flight and completed bytes that no
manifest references yet (2 GiB for accounts under 90 days, 20 GiB otherwise), so
a brand-new account cannot declare a 5 GiB upload; the 5 GiB bundle cap remains
for accounts old enough to be allowed it. Uploads nobody finishes are deleted
after a TTL by :mod:`.reaper`, as are completed uploads no manifest references
after the longer orphan TTL.

Every error leaves this module as an ``HTTPException``, which the
app-wide RFC 9457 handlers render as ``application/problem+json``.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from app.db import SessionLocal
from app.security import Principal, Tier, require_tier

from . import config, finalize, limits, references, store

router = APIRouter(tags=["uploads"])

UPLOAD_TOO_LARGE_TYPE = "urn:scholium:problem:upload-too-large"
UPLOAD_OFFSET_MISMATCH_TYPE = "urn:scholium:problem:upload-offset-mismatch"
UPLOAD_LOCKED_TYPE = "urn:scholium:problem:upload-locked"
UPLOAD_QUOTA_EXCEEDED_TYPE = "urn:scholium:problem:upload-quota-exceeded"

#: Uploads are for signed-in members: tier 1 and above.
_require_member = require_tier(Tier.MEMBER)

#: The media type tus 1.0.0 requires on a ``PATCH`` carrying bytes.
OFFSET_CONTENT_TYPE = "application/offset+octet-stream"

#: ``Upload-Offset``/``Upload-Length`` values longer than this are not sizes
#: any upload can have (the column is a signed 64-bit integer).
_MAX_INT_DIGITS = 19


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


def _reject_over_quota(exc: store.QuotaExceeded) -> HTTPException:
    # Imported at raise time for the reason given in _reject_too_large.
    from app.errors import ProblemException

    if exc.quota_kind == store.QUOTA_DAILY:
        detail = (
            f"You have finished {exc.completed_bytes} bytes of uploads that no manifest references and hold "
            f"{exc.in_flight_bytes} more in flight against a daily allowance of {exc.quota_bytes} bytes, and this "
            f"upload needs {exc.requested_bytes} more. Reference the finished uploads in a manifest, or wait for "
            "the daily allowance to free up, then try again."
        )
    else:
        detail = (
            f"You have {exc.in_flight_bytes} of your {exc.quota_bytes} bytes of unfinished uploads in flight, and "
            f"this upload needs {exc.requested_bytes} more. Finish the earlier ones, or wait until the server "
            "deletes the ones left unfinished, then try again."
        )
    return ProblemException(
        413,
        detail,
        type=UPLOAD_QUOTA_EXCEEDED_TYPE,
        quota_kind=exc.quota_kind,
        quota_bytes=exc.quota_bytes,
        in_flight_bytes=exc.in_flight_bytes,
        requested_bytes=exc.requested_bytes,
        completed_bytes=exc.completed_bytes,
        headers=_tus_headers(),
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


def _problem(
    status_code: int,
    detail: str,
    *,
    type: str,
    headers: Optional[dict[str, str]] = None,
) -> HTTPException:
    """A problem-details error carrying a machine-readable ``type`` (and the tus headers)."""
    # Imported at raise time for the reason given in _reject_too_large.
    from app.errors import ProblemException

    return ProblemException(status_code, detail, type=type, headers=_tus_headers(headers))


def _not_found() -> HTTPException:
    return _reject(404, "No such upload.", headers=_tus_headers())


def _header_int(request: Request, name: str, *, required: bool = False) -> Optional[int]:
    """A non-negative integer request header, ``None`` when absent and not ``required``."""
    raw = request.headers.get(name)
    if raw is None:
        if required:
            raise _reject(400, f"A PATCH needs an '{name.title()}' header.", headers=_tus_headers())
        return None
    candidate = raw.strip()
    # str.isdigit() alone also accepts digits like '²' that int() then refuses.
    if not (candidate.isascii() and candidate.isdigit()) or len(candidate) > _MAX_INT_DIGITS:
        raise _reject(
            400,
            f"The {name.title()} header must be a non-negative integer, got {raw!r}.",
            headers=_tus_headers(),
        )
    return int(candidate)


def _require_offset_content_type(request: Request) -> None:
    media_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    if media_type != OFFSET_CONTENT_TYPE:
        raise _reject(
            415,
            f"A PATCH must send 'Content-Type: {OFFSET_CONTENT_TYPE}', got {media_type or 'none'!r}.",
            headers=_tus_headers(),
        )


def _daily_allowance_for(upload: store.Upload) -> tuple[int, int, int]:
    """``(quota, completed unreferenced bytes, other in-flight bytes)`` for the upload's owner.

    Blocking database and record-log reads: call it from a worker thread.
    """
    now = datetime.now(timezone.utc)
    since = now.replace(tzinfo=None) - config.DAILY_WINDOW
    quota = config.daily_quota_bytes(store.account_created_at(upload.owner_did), now=now)
    referenced: set[str] = set()
    if store.has_completed_upload_since(upload.owner_did, since=since):
        referenced = references.referenced_cids() or set()
    completed, others = store.daily_usage_for(
        upload.owner_did,
        exclude_upload_id=upload.id,
        since=since,
        referenced=referenced,
    )
    return quota, completed, others


def _reject_daily_quota(*, quota: int, completed: int, others: int, requested: int) -> HTTPException:
    return _reject_over_quota(
        store.QuotaExceeded(
            quota_kind=store.QUOTA_DAILY,
            quota_bytes=quota,
            in_flight_bytes=others,
            requested_bytes=requested,
            completed_bytes=completed,
        )
    )


def _load_upload(upload_id: str) -> Optional[store.Upload]:
    """The upload as the database has it right now, or ``None`` if there is none."""
    session = SessionLocal()
    try:
        return store.get_upload(session, upload_id)
    finally:
        session.close()


def _load_owned_upload(upload_id: str, principal: Principal) -> Optional[store.Upload]:
    """The upload, but only if ``principal`` owns it: anyone else's is ``None``, as if it did not exist."""
    upload = _load_upload(upload_id)
    if upload is None or upload.owner_did is None or upload.owner_did != principal.did:
        return None
    return upload


def _commit_append(
    staged: Any,
    upload_id: str,
    *,
    start: int,
    written: int,
    upload_length: Optional[int],
    keep: bool,
) -> bool:
    """Make the ``written`` bytes after ``start`` count, or roll them back.

    The bytes are flushed to disk *before* the database learns of them, so the
    recorded offset never runs ahead of what the file holds. With ``keep``
    false the file is cut back to ``start`` and nothing is recorded. Returns
    ``False`` when the offset moved under us (which the file lock rules out,
    so it means someone bypassed it): the file is then cut back too.
    """
    if not keep:
        staged.truncate(start)
        staged.flush()
        return True
    if written == 0 and upload_length is None:
        return True
    staged.flush()
    os.fsync(staged.fileno())
    session = SessionLocal()
    try:
        advanced = store.advance_offset(
            session,
            upload_id,
            expected_offset=start,
            new_offset=start + written,
            upload_length=upload_length,
        )
    finally:
        session.close()
    if not advanced:
        staged.truncate(start)
        staged.flush()
    return advanced


async def _move_into_content_store(upload_id: str, upload: store.Upload, staged: Any) -> str:
    """Move the completed upload's staged bytes into the content store; return the raw CID.

    Once started it runs to the end even if the request is cancelled, so the CID
    is never left unrecorded with the staged file already deleted.
    """
    try:
        with anyio.CancelScope(shield=True):
            return await run_in_threadpool(
                finalize.move_into_content_store, upload_id, upload.upload_metadata, staged
            )
    except OSError as exc:
        # The upload is complete and its staged bytes are untouched: repeating
        # the final PATCH redoes the move.
        raise _reject(
            503,
            "The upload is complete but could not be moved into the content store; "
            "repeat the PATCH with the same Upload-Offset and an empty body.",
            headers=_tus_headers({"Retry-After": "1"}),
        ) from exc


async def _answer_stored_upload(request: Request, upload: store.Upload, too_large: HTTPException) -> Response:
    """Answer a ``PATCH`` to an upload already in the content store: its CID, and no bytes accepted."""
    async for chunk in request.stream():
        if chunk:
            raise too_large
    return Response(
        status_code=204,
        headers=_tus_headers({"Upload-Offset": str(upload.upload_offset), "Upload-Cid": str(upload.cid)}),
    )


@router.options("/uploads")
def upload_options() -> Response:
    """tus server discovery: which version and extensions we speak."""
    return Response(
        status_code=204,
        headers=_tus_headers(
            {
                "Tus-Version": limits.TUS_VERSION,
                "Tus-Extension": "creation,creation-defer-length",
                "Tus-Max-Size": str(limits.MAX_UPLOAD_BYTES),
            }
        ),
    )


@router.post("/uploads", status_code=201)
def create_upload(request: Request, principal: Principal = Depends(_require_member)) -> Response:
    """Create an upload resource, owned by the caller, and point the client at it (tus creation)."""
    _require_tus_version(request)
    upload_length, defer_length = _parse_upload_length(request)

    metadata_header = request.headers.get("upload-metadata")
    metadata = limits.parse_upload_metadata(metadata_header)
    kind = limits.classify_upload(metadata, content_type=request.headers.get("content-type"))

    if upload_length is not None:
        exceeded = limits.check_upload_length(upload_length, kind)
        if exceeded is not None:
            raise _reject_too_large(kind, upload_length, exceeded)

    try:
        # What the caller may add in a day depends on how old their account is:
        # a new account gets the strict Phase 1 allowance, which is what stops a
        # fresh tier-2 sign-up from declaring a 5 GiB upload. Unknown age is
        # treated as new, the strict end.
        now = datetime.now(timezone.utc)
        since = now.replace(tzinfo=None) - config.DAILY_WINDOW
        daily_quota = config.daily_quota_bytes(store.account_created_at(principal.did), now=now)
        # Finished bytes only count until a manifest names them; the scan reads
        # the (append-only) record log, and an unreadable log counts everything,
        # which can only refuse an upload, never store one unaccounted for.  A
        # caller with no completed upload today needs no scan at all.
        referenced: set[str] = set()
        if store.has_completed_upload_since(principal.did, since=since):
            referenced = references.referenced_cids() or set()
        completed = store.completed_unreferenced_bytes_for(
            principal.did,
            since=since,
            referenced=referenced,
        )
        session = SessionLocal()
        try:
            upload = store.create_upload(
                session,
                upload_length=upload_length,
                defer_length=defer_length,
                upload_metadata=metadata_header or "",
                kind=kind,
                owner_did=principal.did,
                quota_bytes=config.quota_bytes(),
                daily_quota_bytes=daily_quota,
                completed_bytes=completed,
            )
        finally:
            session.close()
    except store.QuotaExceeded as exc:
        raise _reject_over_quota(exc) from None
    except SQLAlchemyError as exc:  # pragma: no cover - defensive: storage is down
        raise _reject(503, "Upload storage is unavailable; retry shortly.") from exc

    return Response(
        status_code=201,
        headers=_tus_headers({"Location": f"/v1/uploads/{upload.id}"}),
    )


@router.head("/uploads/{upload_id}")
def head_upload(upload_id: str, request: Request, principal: Principal = Depends(_require_member)) -> Response:
    """Report how much of an upload the server has, so an interrupted client can resume."""
    _require_tus_version(request)
    try:
        upload = _load_owned_upload(upload_id, principal)
    except SQLAlchemyError as exc:  # pragma: no cover - defensive: storage is down
        raise _reject(503, "Upload storage is unavailable; retry shortly.") from exc
    if upload is None:
        raise _not_found()

    headers = {
        "Upload-Offset": str(upload.upload_offset),
        # tus: the offset changes with every PATCH, so no cache may answer for it.
        "Cache-Control": "no-store",
    }
    if upload.upload_length is not None:
        headers["Upload-Length"] = str(upload.upload_length)
    elif upload.defer_length:
        headers["Upload-Defer-Length"] = "1"
    if upload.upload_metadata:
        headers["Upload-Metadata"] = upload.upload_metadata
    return Response(status_code=200, headers=_tus_headers(headers))


@router.patch("/uploads/{upload_id}")
async def patch_upload(
    upload_id: str, request: Request, principal: Principal = Depends(_require_member)
) -> Response:
    """Append the request body to an upload at ``Upload-Offset`` (tus core PATCH)."""
    _require_tus_version(request)
    _require_offset_content_type(request)
    offset = _header_int(request, "upload-offset", required=True)
    declared_length = _header_int(request, "upload-length")
    body_length = _header_int(request, "content-length")
    assert offset is not None  # required=True

    try:
        # Answer 404 before touching the filesystem: an unknown id, or one that is
        # someone else's, gets no staged file and never takes the upload's lock.
        if await run_in_threadpool(_load_owned_upload, upload_id, principal) is None:
            raise _not_found()
        try:
            staged = await run_in_threadpool(store.open_staged, upload_id)
        except store.UploadBusy:
            raise _problem(
                423,
                "Another request is appending to this upload right now; retry shortly.",
                type=UPLOAD_LOCKED_TYPE,
            ) from None
        try:
            return await _append_body(
                request,
                upload_id,
                staged,
                offset=offset,
                declared_length=declared_length,
                body_length=body_length,
            )
        finally:
            staged.close()  # releases the lock
    except SQLAlchemyError as exc:  # pragma: no cover - defensive: storage is down
        raise _reject(503, "Upload storage is unavailable; retry shortly.") from exc


async def _append_body(
    request: Request,
    upload_id: str,
    staged: Any,
    *,
    offset: int,
    declared_length: Optional[int],
    body_length: Optional[int],
) -> Response:
    """Stream the body into ``staged`` after ``offset``; the caller holds the upload's lock."""
    # Read the offset only now that no one else can move it: a request that
    # waited on the lock must be judged against what the winner left behind.
    upload = await run_in_threadpool(_load_upload, upload_id)
    if upload is None:
        raise _not_found()
    if upload.cid is not None:
        # Its bytes are in the content store and nothing is staged. Taking the
        # lock just created an empty staging file, which must not outlive this
        # request whatever the answer to it turns out to be.
        await run_in_threadpool(store.discard_staged, upload_id)
    current = upload.upload_offset
    if offset != current:
        raise _problem(
            409,
            f"Upload-Offset {offset} does not match the {current} bytes the server has; "
            f"continue from offset {current}.",
            type=UPLOAD_OFFSET_MISMATCH_TYPE,
            headers={"Upload-Offset": str(current)},
        )

    # The total size, which a deferred-length upload learns from this request.
    length = upload.upload_length
    new_length: Optional[int] = None

    # A deferred-length upload has not spent any of the daily allowance yet
    # (it reserved nothing at creation), so its growth is checked here: as it
    # streams, and again if this request declares its total size.  A declared
    # length was already accounted for when it was created.
    daily_cap: Optional[int] = None
    daily_quota = daily_completed = daily_others = 0
    if length is None:
        daily_quota, daily_completed, daily_others = await run_in_threadpool(_daily_allowance_for, upload)
        daily_cap = daily_quota - daily_completed - daily_others

    if declared_length is not None:
        if length is not None:
            if declared_length != length:
                raise _reject(
                    400,
                    f"The Upload-Length is already {length} bytes and cannot change to {declared_length}.",
                    headers=_tus_headers(),
                )
        else:
            exceeded = limits.check_upload_length(declared_length, upload.kind)
            if exceeded is not None:
                raise _reject_too_large(upload.kind, declared_length, exceeded)
            if daily_cap is not None and declared_length > daily_cap:
                raise _reject_daily_quota(
                    quota=daily_quota,
                    completed=daily_completed,
                    others=daily_others,
                    requested=declared_length,
                )
            if declared_length < current:
                raise _reject(
                    400,
                    f"The Upload-Length {declared_length} is less than the {current} bytes already received.",
                    headers=_tus_headers(),
                )
            length = new_length = declared_length

    # How far this request may take the upload: its length, or until that is
    # known the largest size the API accepts for its kind -- and, while the
    # length is deferred, no more than the owner's remaining daily allowance.
    cap = length if length is not None else limits.limit_for(upload.kind)
    if daily_cap is not None:
        cap = min(cap, daily_cap)
        if daily_cap <= current:
            raise _reject_daily_quota(
                quota=daily_quota,
                completed=daily_completed,
                others=daily_others,
                requested=current + 1,
            )
    room = cap - current
    too_large = _problem(
        413,
        f"This request's body would take the upload ({current} bytes received) past "
        + (f"its declared length of {cap} bytes." if length is not None else f"the {cap}-byte limit for its kind."),
        type=UPLOAD_TOO_LARGE_TYPE,
    )
    if body_length is not None and body_length > room:
        raise too_large

    # Its bytes already moved into the content store, so there is no staged file
    # to append to (or to find missing): all that is left is to say where they are.
    if upload.cid is not None:
        return await _answer_stored_upload(request, upload, too_large)

    # The file may hold bytes past the offset the database recorded: an
    # earlier request wrote them and then died before recording them. They
    # were never acknowledged, so they are discarded. Fewer bytes than
    # recorded means acknowledged bytes are gone and the upload can't resume.
    if os.fstat(staged.fileno()).st_size < current:
        raise _reject(
            410,
            "The bytes received for this upload are missing from the server; start a new upload.",
            headers=_tus_headers(),
        )
    staged.seek(current)
    staged.truncate(current)

    written = 0
    overflow = interrupted = False
    try:
        try:
            async for chunk in request.stream():
                if written + len(chunk) > room:
                    overflow = True
                    break
                if chunk:
                    await run_in_threadpool(staged.write, chunk)
                    written += len(chunk)
        except ClientDisconnect:
            interrupted = True
    finally:
        # Whatever ended the body (completion, a dropped connection, the
        # request being cancelled) the bytes that did arrive must be counted
        # or rolled back, so this runs shielded from cancellation.
        with anyio.CancelScope(shield=True):
            recorded = await run_in_threadpool(
                _commit_append,
                staged,
                upload_id,
                start=current,
                written=written,
                upload_length=new_length,
                keep=not overflow,
            )

    if overflow:
        raise too_large
    if not recorded:
        raise _problem(
            409,
            "The upload changed while this request was being applied; ask for its Upload-Offset and retry.",
            type=UPLOAD_OFFSET_MISMATCH_TYPE,
        )

    # The last byte is in: the upload is finished, so file it under its CID. This
    # also runs when the connection dropped right after the final byte, so a
    # client that never retries still leaves a stored upload, not a stranded one.
    cid: Optional[str] = None
    if length is not None and current + written == length:
        cid = await _move_into_content_store(upload_id, upload, staged)

    if interrupted:
        raise _reject(
            400,
            f"The request body ended early; {written} bytes were kept. Ask for the Upload-Offset and continue.",
            headers=_tus_headers({"Upload-Offset": str(current + written)}),
        )
    headers = {"Upload-Offset": str(current + written)}
    if cid is not None:
        headers["Upload-Cid"] = cid
    return Response(status_code=204, headers=_tus_headers(headers))
