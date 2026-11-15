"""The CID-addressed blob directory (plugin: content).

File bytes live in ``settings.CONTENT_DIR``, one file per distinct content,
named by the file's id -- the raw-codec CIDv1 sha2-256 string from
:mod:`scholium_record_core.file_id`::

    CONTENT_DIR/
        bafkrei...               <- one file per distinct content, named by its cid
        bafkrei...
        .tmp/                    <- writes in flight; never served

The layout is flat: the first characters of a CID are a constant prefix
(``bafkrei``), so sharding on them would spread nothing, and :func:`blob_path`
is the only place that knows where a blob lives should that ever change.

A blob is written to ``.tmp`` while its sha2-256 is computed, then renamed
into place.  A file at a CID path is therefore always complete, and its name
is the hash of its content.  The cid is never taken from the caller: it is
computed here from the bytes actually written.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from collections.abc import Buffer
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol

from multiformats import CID
from scholium_record_core import (
    CID_VERSION,
    FILE_BASE,
    FILE_CODEC,
    FILE_HASH,
    parse_file_cid,
)

from app.settings import settings

from .errors import ContentError

__all__ = [
    "CHUNK_SIZE",
    "StoredFile",
    "TMP_DIRNAME",
    "blob_path",
    "cid_from_digest",
    "content_dir",
    "exists",
    "open_blob",
    "write_bytes",
    "write_stream",
]

#: How many bytes are read from a source stream at a time.
CHUNK_SIZE = 1024 * 1024

#: Subdirectory of ``CONTENT_DIR`` holding writes in flight.  No CID starts
#: with a dot, so it can never collide with a blob.
TMP_DIRNAME = ".tmp"


class SupportsRead(Protocol):
    """A binary readable: ``read(n)`` returns up to ``n`` bytes, ``b""`` at EOF."""

    def read(self, size: int = -1, /) -> bytes: ...


@dataclass(frozen=True)
class StoredFile:
    """The outcome of writing bytes into the blob directory."""

    cid: str
    size: int
    #: ``False`` when these exact bytes were already in the directory.
    created: bool


def content_dir() -> Path:
    """The blob directory, from ``settings.CONTENT_DIR`` (read on every call)."""
    configured = settings.CONTENT_DIR
    if not configured or not configured.strip():
        # ``Path("")`` is the current directory: refuse rather than scatter
        # blobs wherever the process happens to have been started.
        raise ContentError("CONTENT_DIR is not configured")
    return Path(configured)


def blob_path(cid: str) -> Path:
    """Where the bytes for file id ``cid`` live (whether or not they exist yet).

    ``cid`` must be a canonical file id.  That is what keeps the path safe:
    base32 CIDv1 strings contain only ``a-z`` and ``2-7``, so nothing a client
    sends can name a path outside the blob directory.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
    """
    parse_file_cid(cid)
    return content_dir() / cid


def exists(cid: str) -> bool:
    """Whether the bytes for ``cid`` are in the blob directory.

    A malformed ``cid`` is simply not there, so it returns ``False``.
    """
    try:
        return blob_path(cid).is_file()
    except ValueError:
        return False


def open_blob(cid: str) -> BinaryIO:
    """Open the stored bytes for ``cid`` for reading.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        FileNotFoundError: if the bytes are not in the directory.
    """
    return open(blob_path(cid), "rb")


def cid_from_digest(digest: bytes) -> str:
    """The file id for a sha2-256 ``digest`` of some bytes.

    Built the way :func:`scholium_record_core.compute_file_id` builds it, but
    from a digest, so a file can be hashed as a stream instead of held in
    memory.  (The tests check the two agree.)
    """
    cid = CID(
        base=FILE_BASE,
        version=CID_VERSION,
        codec=FILE_CODEC,
        digest=(FILE_HASH, digest),
    )
    return str(cid)


def write_bytes(data: Buffer) -> StoredFile:
    """Store the bytes-like ``data`` and return its id and size."""
    if not isinstance(data, Buffer):
        raise TypeError(f"file bytes must be bytes-like, got {type(data).__name__}")
    view = memoryview(data).cast("B")
    return _write_chunks(
        view[start : start + CHUNK_SIZE] for start in range(0, len(view), CHUNK_SIZE)
    )


def write_stream(stream: SupportsRead) -> StoredFile:
    """Store everything ``stream`` yields until EOF and return its id and size.

    ``stream`` must be a *binary* readable (an object whose ``read(n)`` returns
    ``bytes``); a text-mode stream raises :class:`TypeError` and stores nothing.
    """

    def chunks():
        while True:
            chunk = stream.read(CHUNK_SIZE)
            if not isinstance(chunk, (bytes, bytearray, memoryview)):
                raise TypeError(
                    "stream must be a binary readable; read() returned "
                    f"{type(chunk).__name__}"
                )
            if not chunk:
                return
            yield chunk

    return _write_chunks(chunks())


def _write_chunks(chunks) -> StoredFile:
    root = content_dir()
    tmp_dir = root / TMP_DIRNAME
    tmp_dir.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256()
    size = 0
    fd, tmp_name = tempfile.mkstemp(dir=tmp_dir, prefix="blob-")
    try:
        with os.fdopen(fd, "wb") as out:
            for chunk in chunks:
                digest.update(chunk)
                out.write(chunk)
                size += len(chunk)
            out.flush()
            os.fsync(out.fileno())

        cid = cid_from_digest(digest.digest())
        final = root / cid
        # Content addressing makes an existing file of the right size the same
        # bytes already; leave it be.  A wrong-sized one (never produced by
        # this code, which only renames complete files) is replaced.
        if final.is_file() and final.stat().st_size == size:
            return StoredFile(cid=cid, size=size, created=False)
        os.replace(tmp_name, final)
        _fsync_dir(root)
        return StoredFile(cid=cid, size=size, created=True)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass  # renamed into place


def _fsync_dir(path: Path) -> None:
    """Make a rename inside ``path`` durable; best effort where unsupported."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
