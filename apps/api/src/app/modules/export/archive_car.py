"""``GET /v1/export/archive.car`` -- the whole public archive (feature 93).

The module loader mounts this package's ``router`` under ``/v1``, so anyone
can download the node's complete public archive with::

    GET /v1/export/archive.car

    200 OK
    Content-Type: application/vnd.ipld.car
    Content-Disposition: attachment; filename="archive.car"

    <CARv1 bytes>

The archive is rooted at the node-signed log head (the document
``GET /v1/sync/head`` serves) and holds every log entry up to it, every
record, and the bytes of every file a record names -- except tombstoned bytes
and the bytes of a paper the caller may not read under the content route's
rule (an anonymous caller therefore never receives pre-listing bytes; the
authors and moderators who send a token may).  What it holds and why is
described in :mod:`app.modules.export.archive`; the blocks are written by
:mod:`app.modules.export.car`.

A node whose key cannot be loaded cannot sign a head, so it answers ``503``
RFC 9457 problem details (the same ``node-key-unavailable`` type
``/v1/sync/head`` uses) rather than an archive that commits to nothing.

The archive of a node holds every file the node has, so it is never built in
memory: it is written to a temporary file (kept in memory only while small),
which is then streamed to the client.  Everything that can fail does so before
the first byte is sent, so a client never receives a truncated archive that
looks complete.
"""

from __future__ import annotations

import tempfile
from typing import BinaryIO, Iterator, Optional

from fastapi import APIRouter, Depends, Response
from fastapi.responses import StreamingResponse

from app.modules import ledger
from app.security import Principal

from .archive import collect_archive
from .auth import optional_principal
from .paper_car import CAR_MEDIA_TYPE

__all__ = [
    "CHUNK_SIZE",
    "SPOOL_MAX_BYTES",
    "router",
]

#: Archives up to this size are held in memory; larger ones spill to disk.
SPOOL_MAX_BYTES = 32 * 1024 * 1024

#: Bytes read from the finished archive per chunk sent.
CHUNK_SIZE = 1024 * 1024

#: Router the module loader mounts under ``/v1`` (serves the export routes).
router = APIRouter(prefix="/export", tags=["export"])


def _node_key_unavailable():
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and doing that while the module loader imports packages would
    # leave this package half-initialized without a `router` attribute.  The
    # message omits NODE_KEY_PATH: this response is public.
    from app.errors import ProblemException

    return ProblemException(
        503,
        "This node cannot sign its log head, so it cannot export an archive "
        "that commits to it: no usable Ed25519 node key was found. "
        "Provision the node key and retry.",
        type=ledger.NODE_KEY_UNAVAILABLE_TYPE,
    )


def _stream(spool: BinaryIO) -> Iterator[bytes]:
    """The finished archive in chunks; the temporary file is closed after."""
    try:
        while chunk := spool.read(CHUNK_SIZE):
            yield chunk
    finally:
        spool.close()


@router.get(
    "/archive.car",
    response_class=Response,
    summary="Export the complete public archive as a CARv1 archive "
    "(signed log head, log entries, records and files; no tombstoned bytes)",
)
def export_archive(
    principal: Optional[Principal] = Depends(optional_principal),
) -> Response:
    """Return the CARv1 archive of this node's whole public archive."""
    key = ledger.node_signing_key()
    if key is None:
        raise _node_key_unavailable()

    archive = collect_archive(key, principal)
    spool = tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES)
    try:
        size = archive.write_to(spool)
        spool.seek(0)
    except BaseException:
        spool.close()
        raise

    return StreamingResponse(
        _stream(spool),
        media_type=CAR_MEDIA_TYPE,
        headers={
            "Content-Length": str(size),
            "Content-Disposition": 'attachment; filename="archive.car"',
        },
    )
