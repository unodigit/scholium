"""The CID-addressed blob store (plugin: content).

Blob bytes are kept through the app-wide :class:`~app.storage.base.ObjectStore`
(:func:`app.storage.get_object_store`), keyed by the file's id -- the
raw-codec CIDv1 sha2-256 string from :mod:`scholium_record_core.file_id`.
Where the bytes physically live is a deployment choice
(``STORAGE_BACKEND``): with ``fs`` (the default) the store is rooted at
``settings.CONTENT_DIR`` and keeps the layout this module has always
written, one file per distinct content, so existing data is read as it
stands -- no migration::

    CONTENT_DIR/
        bafkrei...               <- key "bafkrei..."
        bafkrei...
        .tmp/                    <- writes in flight; never served

The cid is never taken from the caller: it is computed here from the bytes
actually written, and the store's own sha2-256 of what it put is checked
against it.  A write therefore never leaves bytes under a cid that is not
their hash.

Reading is streaming: :func:`open_blob` and :func:`open_range` hand back a
binary reader straight from the ObjectStore, so a served file never has to
be held in memory -- and need not be seekable, which is why callers that
must seek (or need a path to hand a subprocess) ask for a
:func:`local_copy`.  :func:`blob_path` survives only as the
filesystem-backend helper it always was: with any other backend there is
no path, and it says so.
"""

from __future__ import annotations

import hashlib
import io
import shutil
import tempfile
from collections.abc import Buffer, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Optional, Protocol

from multiformats import CID
from scholium_record_core import (
    CID_VERSION,
    FILE_BASE,
    FILE_CODEC,
    FILE_HASH,
    parse_file_cid,
)

from app.settings import settings
from app.storage import (
    FilesystemObjectStore,
    ObjectNotFoundError,
    ObjectStore,
    StorageConfigError,
    get_object_store,
)
from app.storage.filesystem import TMP_DIRNAME

from .errors import ContentError

__all__ = [
    "CHUNK_SIZE",
    "StoredFile",
    "TMP_DIRNAME",
    "SupportsRead",
    "blob_path",
    "blob_size",
    "cid_from_digest",
    "content_dir",
    "delete_blob",
    "exists",
    "local_copy",
    "open_blob",
    "open_range",
    "write_bytes",
    "write_stream",
]

#: How many bytes are read from a source stream at a time.  (Matches the
#: ObjectStore drivers' own chunk size; the two are independent.)
CHUNK_SIZE = 1024 * 1024


class SupportsRead(Protocol):
    """A binary readable: ``read(n)`` returns up to ``n`` bytes, ``b""`` at EOF."""

    def read(self, size: int = -1, /) -> bytes: ...


@dataclass(frozen=True)
class StoredFile:
    """The outcome of writing bytes into the object store."""

    cid: str
    size: int
    #: ``False`` when these exact bytes were already stored.
    created: bool


def _object_store() -> ObjectStore:
    """The ObjectStore ``settings.STORAGE_BACKEND`` selects.

    Configuration problems are this module's error to raise: the store is a
    library, and its callers know :class:`ContentError`, not the storage
    package's own exception hierarchy.
    """
    try:
        return get_object_store()
    except StorageConfigError as exc:
        raise ContentError(str(exc)) from exc


def _check_cid(cid: str) -> None:
    """Insist ``cid`` is a canonical raw-codec file id.

    That is what keeps keys safe everywhere below: base32 CIDv1 strings
    contain only ``a-z`` and ``2-7``, so nothing a client sends can name an
    object outside the store.
    """
    parse_file_cid(cid)


def content_dir() -> Path:
    """The ``CONTENT_DIR`` setting: the filesystem backend's root (read on every call)."""
    configured = settings.CONTENT_DIR
    if not configured or not configured.strip():
        # ``Path("")`` is the current directory: refuse rather than scatter
        # blobs wherever the process happens to have been started.
        raise ContentError("CONTENT_DIR is not configured")
    return Path(configured)


def blob_path(cid: str) -> Path:
    """Where the bytes for file id ``cid`` live on the local filesystem.

    A filesystem-backend helper, for callers that must point at a real file
    (and only while ``STORAGE_BACKEND`` is ``fs``): with any other backend
    the bytes have no path, and callers should use :func:`local_copy`.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        ContentError: if the storage backend is not the filesystem one.
    """
    _check_cid(cid)
    store = _object_store()
    if not isinstance(store, FilesystemObjectStore):
        raise ContentError(
            "blob_path() only knows where bytes live on the filesystem "
            "backend, and the object store in use is not it; use "
            "local_copy() for a real local file on any backend"
        )
    return store.path_for(cid)


def exists(cid: str) -> bool:
    """Whether the bytes for ``cid`` are stored.

    A malformed ``cid`` is simply not there, so it returns ``False``.
    """
    try:
        _check_cid(cid)
    except ValueError:
        return False
    return _object_store().exists(cid)


def open_range(
    cid: str, *, offset: int = 0, length: Optional[int] = None
) -> BinaryIO:
    """Open the stored bytes for ``cid`` for streaming reads, optionally a range.

    ``offset`` is the first byte wanted and ``length`` how many at most
    (``None``: to the end).  The result is a binary file-like that need not
    be seekable; close it (it is a context manager).  What the download
    route streams, including its ``Range`` answers.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        FileNotFoundError: if the bytes are not stored.
        InvalidRangeError: if ``offset`` is beyond the end of the stored bytes.
    """
    _check_cid(cid)
    return _object_store().open(cid, offset=offset, length=length)


def open_blob(cid: str) -> BinaryIO:
    """Open the stored bytes for ``cid`` for reading, all of them.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        FileNotFoundError: if the bytes are not stored.
    """
    return open_range(cid)


def blob_size(cid: str) -> int:
    """The size in bytes of the stored bytes for ``cid``.

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        FileNotFoundError: if the bytes are not stored.
    """
    _check_cid(cid)
    return _object_store().size(cid)


def delete_blob(cid: str) -> None:
    """Remove the stored bytes for ``cid``; a cid with no bytes is left alone.

    Only the bytes: the ``blobs`` row and any denylist entry are the
    callers' business (moderation's, in practice).

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
    """
    _check_cid(cid)
    _object_store().delete(cid)


@contextmanager
def local_copy(cid: str) -> Iterator[Path]:
    """Yield a real local file holding the stored bytes for ``cid``, then remove it.

    For callers that need an actual file -- to hand a path to a subprocess,
    or a library that insists on seeking -- whatever the storage backend
    is.  The copy is made into a fresh temporary directory which is removed
    when the block leaves, so the path is valid only inside it and is safe
    to read (and only read: it is a snapshot, not the stored bytes).

    Raises:
        ValueError: if ``cid`` is not a canonical raw-codec file id.
        FileNotFoundError: if the bytes are not stored.
    """
    _check_cid(cid)
    store = _object_store()
    with tempfile.TemporaryDirectory(prefix="scholium-blob-") as directory:
        target = Path(directory) / cid
        with store.open(cid) as source, open(target, "wb") as sink:
            shutil.copyfileobj(source, sink, CHUNK_SIZE)
        yield target


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
    digest = hashlib.sha256(view).digest()
    return _install(cid_from_digest(digest), io.BytesIO(view), len(view), digest)


def write_stream(stream: SupportsRead) -> StoredFile:
    """Store everything ``stream`` yields until EOF and return its id and size.

    ``stream`` must be a *binary* readable (an object whose ``read(n)`` returns
    ``bytes``); a text-mode stream raises :class:`TypeError` and stores nothing.
    The cid is the hash of the bytes, so they are spooled to a scratch file --
    constant memory -- while it is computed, then handed to the object store.

    The signature the store has always had; where the bytes land is the
    backend's business.
    """

    def chunks() -> Iterator[bytes]:
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

    digest = hashlib.sha256()
    size = 0
    with tempfile.TemporaryFile() as spool:
        for chunk in chunks():
            digest.update(chunk)
            spool.write(chunk)
            size += len(chunk)
        spool.seek(0)
        raw = digest.digest()
        return _install(cid_from_digest(raw), spool, size, raw)


def _install(cid: str, stream: BinaryIO, size: int, digest: bytes) -> StoredFile:
    """Put the already-hashed ``stream`` at ``cid``, or notice it is already there.

    Content addressing makes an existing object of the right size at ``cid``
    the same bytes already; leave it be (and never disturb a scan verdict by
    so much as a rewrite).  After a write, the store's own accounting of
    what it put is checked against the hash the cid was built from: the one
    guarantee this module makes -- bytes live under their own id -- holds
    even if a driver misbehaves, loudly rather than silently.
    """
    store = _object_store()
    try:
        already_there = store.size(cid) == size
    except ObjectNotFoundError:
        already_there = False
    if already_there:
        return StoredFile(cid=cid, size=size, created=False)

    stored = store.put_stream(cid, stream)
    if stored.size != size or stored.sha256 != digest:
        store.delete(cid)
        raise ContentError(f"the bytes stored for {cid} do not hash to that cid")
    return StoredFile(cid=cid, size=size, created=True)
