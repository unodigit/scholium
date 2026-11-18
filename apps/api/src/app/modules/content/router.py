"""Serve stored bytes: ``GET /v1/content/{cid}`` (plugin: content).

The module loader mounts this router under ``/v1``, so the single route
below serves ``GET /v1/content/{cid}`` -- the bytes of a file already in
the content store.

The bytes are streamed from the app-wide ObjectStore
(:func:`app.modules.content.store.open_range`), never from a path, so the
route serves every storage backend the same way.  A single-range
``Range`` request is answered with ``206 Partial Content`` and a
``Content-Range``; the headers an unranged ``GET`` carries -- the
security headers below, the manifest's ``Content-Type`` and
``Content-Disposition`` -- are the same on a ``206``.  A range that starts
past the last byte answers ``416`` with ``Content-Range: bytes */size``;
any other ``Range`` a browser never sends (several ranges, another unit, a
malformed span) is ignored and answered with the whole object, which RFC
9110 permits and is never a wrong byte.

Serving is deliberately strict, because these are untrusted uploads:

* a blob a ``paper.version`` references through its manifest is public only
  once at least one referencing version is ``listed``.  While every
  referencing version is unlisted -- in ``moderation``, say -- the bytes are
  pre-listing content (tech_architect threat 15) and are served only to
  that version's authors and to moderators (tier 4); everyone else,
  anonymous callers included, gets the same ``404`` as for a cid nothing is
  stored for, so the answer never reveals that unlisted content exists.
  The rule lives in :mod:`app.modules.content.visibility`;
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

An ``Authorization: Bearer`` access token is optional: it is read only to
widen access to unlisted bytes (the caller's authorship or moderator tier).
A token that is missing or unusable simply leaves the caller anonymous.

Errors are RFC 9457 problem details, rendered by the app-wide handlers.

Tombstoning lives in the moderation plugin (feature 73), which records the
cid in the shared ``denylist`` table and deletes the bytes.  The check here
is intentionally by table name rather than by importing moderation's
model, so this feature keeps working whether or not that plugin is
installed.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import BinaryIO, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict
from scholium_record_core import parse_file_cid
from starlette.responses import PlainTextResponse, Response, StreamingResponse

from app.security import InvalidAccessToken, Principal, decode_access_token

from . import references, service
from .models import SCAN_PASSED, SCAN_SCANNING
from .store import CHUNK_SIZE, blob_size, open_range
from .visibility import may_read

__all__ = [
    "CONTENT_SECURITY_POLICY",
    "ContentVersionOut",
    "ContentVersionsOut",
    "NOSNIFF",
    "content_disposition",
    "router",
    "safe_file_name",
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


#: Bearer credentials, read only to widen access to unlisted bytes.
_bearer = HTTPBearer(auto_error=False)


def _optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``.

    Reading stored bytes is public; a token matters only for bytes whose
    referencing versions are all unlisted, where it carries the caller's
    authorship or moderator tier.  A token that is present but unusable is
    ignored rather than turning a readable page into a ``401`` (the same
    courtesy ``discussion.router`` pays its readers).
    """
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None


class ContentVersionOut(BaseModel):
    """One listed version whose manifest names a blob."""

    model_config = ConfigDict(extra="forbid")

    #: Canonical paper id (``sch:xxxx-xxxx-xxxx``).
    paper: str
    #: Alias of ``paper``.
    shortId: str
    #: cid of the paper's ``paper.genesis`` record.
    paperCid: str
    #: cid of the ``paper.version`` record.
    versionCid: str
    #: Version number (1-based).
    n: int
    #: Alias of ``n``.
    version: int
    #: The version's title.
    title: str
    #: The file's signed path inside the bundle.
    path: str
    #: The last path segment: what the file is saved as.
    fileName: str
    #: Alias of ``fileName`` under snake_case.
    file_name: str
    #: What the file is for: ``manuscript``, ``source``, ``code``, ``data``…
    role: str


class ContentVersionsOut(BaseModel):
    """The response body of ``GET /v1/content/{cid}/versions``."""

    model_config = ConfigDict(extra="forbid")

    #: The blob the versions describe.
    cid: str
    #: The public listed versions naming it, listed versions first.
    versions: list[ContentVersionOut]


def _safe_ascii(value: str) -> str:
    """The ASCII fallback of a file name: printable, never a header break."""
    return "".join(
        character if character.isascii() and character.isprintable() else "_"
        for character in value
    )


def safe_file_name(path: str) -> str:
    """A file name safe to send in ``Content-Disposition``.

    Only the last path segment is used, so a manifest path can never escape
    the browser's download directory.  Control characters, quotes and
    backslashes -- the characters that could break the header -- become
    underscores; ``.`` and ``..`` are not names at all.
    """
    name = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    name = "".join(
        "_" if ord(character) < 32 or ord(character) == 127 or character in '"\\' else character
        for character in name
    ).strip()
    if name in ("", ".", ".."):
        return "download"
    return name


def content_disposition(file_name: str, *, attachment: bool) -> str:
    """An RFC 6266 ``Content-Disposition`` value for ``file_name``.

    ``attachment`` selects a save dialog; otherwise the browser shows the
    file inline.  The header always carries an ASCII ``filename`` and, when
    the name is not ASCII, a percent-encoded ``filename*`` as well, so every
    browser and every non-ASCII name gets a usable file name.
    """
    disposition = "attachment" if attachment else "inline"
    name = safe_file_name(file_name)
    fallback = _safe_ascii(name) or "download"
    value = f'{disposition}; filename="{fallback}"'
    if fallback != name:
        value += "; filename*=UTF-8''" + quote(name, safe="")
    return value


@router.get("/{cid}/versions")
def get_content_versions(
    cid: str,
    principal: Optional[Principal] = Depends(_optional_principal),
) -> "ContentVersionsOut":
    """Return the public listed versions whose manifest names ``cid``.

    This is what ``/verify`` uses to name a file a reader dropped in: the
    caller has the bytes but not the paper.  Only *listed* versions are
    returned; a blob whose every referencing version is unlisted answers the
    same ``404`` as a content read, so the endpoint never reveals pre-listing
    content.  A well-formed cid no manifest names answers an empty list.
    """
    try:
        parse_file_cid(cid)
    except ValueError:
        raise _not_found(cid) from None
    if (
        service.get_blob(cid) is None
        or service.is_tombstoned(cid)
        or not may_read(cid, principal)
    ):
        raise _not_found(cid)
    return ContentVersionsOut(
        cid=cid,
        versions=[
            ContentVersionOut(
                paper=row.paper_short_id,
                shortId=row.paper_short_id,
                paperCid=row.paper_cid,
                versionCid=row.version_cid,
                n=row.n,
                version=row.n,
                title=row.title,
                fileName=row.file_name,
                file_name=row.file_name,
                path=row.path,
                role=row.role,
            )
            for row in references.listed_versions(cid)
        ],
    )


#: One ``bytes`` range: ``bytes=0-99``, ``bytes=100-`` (to the end) or
#: ``bytes=-100`` (the last 100).  Anything else -- several ranges, another
#: unit, a malformed span -- is not a range we serve and is ignored.
_RANGE_SPAN = re.compile(r"\Abytes=(\d*)-(\d*)\Z")


class _RangeNotSatisfiable(Exception):
    """The range starts at or past the end of the stored bytes (RFC 9110 416)."""

    def __init__(self, size: int) -> None:
        self.size = size


def _range_span(header: str, size: int) -> "Optional[tuple[int, int]]":
    """The ``(start, end)`` span -- ``end`` exclusive -- ``header`` asks for.

    ``None`` when the header does not name a single byte span this route
    serves; then the whole object is the answer, exactly as without a
    ``Range`` (RFC 9110 lets a server ignore the header, and the full object
    is never a wrong byte).

    Raises:
        _RangeNotSatisfiable: the span is real but starts past the last byte.
    """
    match = _RANGE_SPAN.fullmatch(header.strip())
    if match is None:
        return None
    first, last = match.group(1), match.group(2)
    if first == "" and last == "":
        return None  # "bytes=-": no span at all
    if first == "":
        # A suffix: the final N bytes, or all of them when N exceeds the size.
        length = int(last)
        if size == 0 or length == 0:
            raise _RangeNotSatisfiable(size)
        start = size - min(length, size)
        return start, size
    start = int(first)
    if start >= size:
        raise _RangeNotSatisfiable(size)
    if last == "":
        return start, size
    end = min(int(last), size - 1)  # inclusive, clamped to the last byte
    if end < start:
        return None  # "bytes=5-2" names no bytes; ignore it
    return start, end + 1


def _stream_bytes(source: BinaryIO, length: int) -> Iterator[bytes]:
    """Yield up to ``length`` bytes from the already-open ``source``, then close it.

    The caller opens the object *before* the response starts, so a blob that
    has vanished is answered with a clean status rather than discovered
    after a ``200`` has gone out.
    """
    with source:
        remaining = length
        while remaining > 0:
            chunk = source.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break  # the bytes shrank mid-response; stop there
            remaining -= len(chunk)
            yield chunk


def _range_applies(if_range: Optional[str], etag: str) -> bool:
    """Whether a ``Range`` request may be honoured given its ``If-Range`` (RFC 9110 13.1.5).

    Without ``If-Range`` the range always applies.  With it, the range applies
    only if the validator is exactly our (strong) ``ETag``: a stale tag -- an
    old copy of the file -- or an HTTP-date (this route sends no
    ``Last-Modified``, so a date can never match) means the client's partial
    copy may not line up with these bytes, so it gets the whole object.
    """
    return if_range is None or if_range.strip() == etag


@router.get("/{cid}")
def get_content(
    cid: str,
    download: bool = Query(
        default=False,
        description="save as an attachment named by the version manifest, not inline",
    ),
    range_header: Optional[str] = Header(default=None, alias="Range"),
    if_range: Optional[str] = Header(default=None, alias="If-Range"),
    principal: Optional[Principal] = Depends(_optional_principal),
) -> Response:
    """Return the stored bytes for ``cid`` when (and only when) they are safe.

    The signed manifest names the file: its ``path`` supplies the download
    name, its ``mediaType`` the response media type, and a manifest entry is
    what makes the response carry a ``Content-Disposition`` at all (``inline``
    by default, ``attachment`` with ``?download=1``).  A blob no manifest
    names still serves, typed by the uploader's hint or ``octet-stream``.

    The body is streamed from the object store, so it never sits in memory
    and no storage backend is special-cased.  A single-range ``Range``
    request gets ``206`` and a ``Content-Range`` with all other headers
    unchanged; every response says ``Accept-Ranges: bytes`` and carries the
    cid as its ``ETag`` (the bytes are content-addressed, so the id *is* the
    tag).
    """
    try:
        parse_file_cid(cid)
    except ValueError:
        # Not a canonical raw-codec file id: nothing can be stored under it,
        # and treating it as "not found" avoids reflecting it anywhere.
        raise _not_found(cid) from None

    if service.is_tombstoned(cid):
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: it has been removed by moderation.",
        )

    blob = service.get_blob(cid)
    if blob is None:
        raise _not_found(cid)

    if not may_read(blob.cid, principal):
        # Pre-listing content the caller may not see.  The answer is the
        # unknown-cid 404, and it comes before the scan gates so an
        # unauthenticated caller cannot even learn that unlisted bytes exist
        # (a 423 would tell them).
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
        size = blob_size(cid)
    except FileNotFoundError:
        # A passed row whose bytes are gone is a takedown (or corruption);
        # either way the content is not available.
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: its bytes have been removed.",
        ) from None

    # The version manifest is the source of truth for what the file is; the
    # store's media type is only the uploader's hint, and is often absent.
    reference = references.download_reference(cid)
    media_type = (
        (reference.media_type if reference is not None else None)
        or blob.media_type
        or DEFAULT_MEDIA_TYPE
    )
    headers = dict(SECURITY_HEADERS)
    headers["Accept-Ranges"] = "bytes"
    headers["ETag"] = f'"{cid}"'
    if reference is not None:
        headers["Content-Disposition"] = content_disposition(
            reference.file_name, attachment=download
        )

    status_code = 200
    start, end = 0, size
    if range_header is not None and _range_applies(if_range, headers["ETag"]):
        try:
            span = _range_span(range_header, size)
        except _RangeNotSatisfiable as unsatisfiable:
            return PlainTextResponse(
                "requested range not satisfiable",
                status_code=416,
                headers={
                    **SECURITY_HEADERS,
                    "Content-Range": f"bytes */{unsatisfiable.size}",
                },
            )
        if span is not None:
            start, end = span
            status_code = 206
            headers["Content-Range"] = f"bytes {start}-{end - 1}/{size}"

    try:
        source = open_range(cid, offset=start, length=end - start)
    except FileNotFoundError:
        # Taken down between the size check above and now.
        raise _problem(
            451,
            f"Content {cid!r} is unavailable: its bytes have been removed.",
        ) from None

    # The length is known exactly, so say it: a download can show progress.
    headers["Content-Length"] = str(end - start)
    return StreamingResponse(
        _stream_bytes(source, end - start),
        status_code=status_code,
        media_type=media_type,
        headers=headers,
    )
