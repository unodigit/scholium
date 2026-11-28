"""The filesystem ObjectStore driver: objects are files under a root directory.

``STORAGE_BACKEND=fs`` (the default) roots it at ``CONTENT_DIR``.  A key is a
path under the root, so the layout the content store has always used -- one
file per CID, directly in ``CONTENT_DIR`` -- is exactly what this driver reads
and writes, and an existing install needs no migration::

    CONTENT_DIR/
        bafkrei...               <- key "bafkrei..."
        uploads/Zk3x/00000001    <- key "uploads/Zk3x/00000001"
        .tmp/                    <- writes in flight; never an object, never listed

Writes are atomic and durable the way they always were: the bytes go to a
fresh file in ``.tmp`` (the same filesystem, so the last step is a rename),
are flushed and fsynced, and only then renamed over the key; the directory is
fsynced so the rename itself survives a crash.  A file at a key is therefore
always complete.  Keys cannot start a segment with ``.`` (see
:mod:`app.storage.base`), so ``.tmp`` and the legacy ``.uploads`` staging
directory can never be addressed as, or collide with, an object.

The root is not touched until the first write, and is read on construction
only as a string: the driver holds no open handles and is safe to share
between threads.
"""

from __future__ import annotations

import errno
import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Optional

from .base import (
    ChunkSource,
    InvalidRangeError,
    KeyConflictError,
    ObjectNotFoundError,
    ObjectStore,
    RawStream,
    StorageConfigError,
    StoredObject,
    SupportsRead,
    empty_stream,
    is_valid_key,
    validate_key,
    validate_prefix,
    validate_range,
)

__all__ = ["FilesystemObjectStore", "TMP_DIRNAME"]

#: Subdirectory of the root holding writes in flight.  No key can start with a
#: dot, so it can never collide with an object.
TMP_DIRNAME = ".tmp"

#: How often a write retries when a concurrent delete prunes the directory it
#: was about to rename into (see :meth:`FilesystemObjectStore._install`).
_INSTALL_ATTEMPTS = 20


class FilesystemObjectStore(ObjectStore):
    """Objects as files under ``root``."""

    def __init__(self, root: "str | os.PathLike[str]") -> None:
        if not str(root).strip():
            # ``Path("")`` is the current directory: refuse rather than scatter
            # objects wherever the process happens to have been started.
            raise StorageConfigError("the filesystem object store has no root directory")
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    def path_for(self, key: str) -> Path:
        """Where the object at ``key`` lives (whether or not it exists yet).

        The one place that maps keys to paths.  Validation is what keeps the
        path inside the root: no key can contain ``..``, an empty segment or a
        leading ``/``.

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
        """
        return self._root / validate_key(key)

    # -- writing ------------------------------------------------------------

    def put_stream(self, key: str, stream: SupportsRead) -> StoredObject:
        final = self.path_for(key)
        source = ChunkSource(stream)
        tmp_dir = self._root / TMP_DIRNAME
        tmp_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=tmp_dir, prefix="blob-")
        try:
            with os.fdopen(fd, "wb") as out:
                for chunk in source:
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            self._install(tmp_name, final)
        finally:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass  # renamed into place
        return source.stored(key)

    @contextmanager
    def _directory(self, segments: tuple[str, ...], *, create: bool = False) -> Iterator[int]:
        """Open one segment at a time to keep syscalls below the OS path limit."""
        fd = os.open(self._root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for segment in segments:
                if create:
                    try:
                        os.mkdir(segment, dir_fd=fd)
                    except FileExistsError:
                        pass
                    else:
                        _fsync_dir(fd)
                child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    def _install(self, tmp_name: str, final: Path) -> None:
        """Rename the finished file into place and make the rename durable."""
        *parents, name = final.relative_to(self._root).parts
        for attempt in range(_INSTALL_ATTEMPTS):
            try:
                with self._directory(tuple(parents), create=True) as fd:
                    os.replace(tmp_name, name, dst_dir_fd=fd)
                    _fsync_dir(fd)
                return
            except (NotADirectoryError, IsADirectoryError) as exc:
                raise self._conflict(final) from exc
            except OSError as exc:
                # A concurrent delete can unlink an empty parent between mkdir
                # and rename. Darwin can report EINVAL for that rename.
                retryable = {errno.ENOENT, errno.EEXIST, errno.EINVAL}
                if exc.errno in retryable and attempt < _INSTALL_ATTEMPTS - 1:
                    continue
                if isinstance(exc, FileExistsError):
                    raise self._conflict(final) from exc
                raise

    def _conflict(self, final: Path) -> KeyConflictError:
        key = final.relative_to(self._root).as_posix()
        return KeyConflictError(f"{key!r} clashes with another key's directory")

    def delete(self, key: str) -> None:
        *parents, name = validate_key(key).split("/")
        try:
            with self._directory(tuple(parents)) as fd:
                try:
                    os.unlink(name, dir_fd=fd)
                except (IsADirectoryError, PermissionError):
                    if stat.S_ISDIR(os.stat(name, dir_fd=fd).st_mode):
                        return
                    raise
        except (FileNotFoundError, NotADirectoryError):
            return
        while parents:
            component = parents.pop()
            try:
                with self._directory(tuple(parents)) as fd:
                    os.rmdir(component, dir_fd=fd)
            except OSError:
                break

    # -- reading ------------------------------------------------------------

    def open(self, key: str, *, offset: int = 0, length: Optional[int] = None) -> BinaryIO:
        *parents, name = validate_key(key).split("/")
        validate_range(offset, length)
        try:
            with self._directory(tuple(parents)) as fd:
                handle = open(name, "rb", opener=lambda path, flags: os.open(path, flags, dir_fd=fd))
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            raise ObjectNotFoundError(f"no object at {key!r}") from None
        if offset == 0 and length is None:
            return handle  # a plain file, exactly what the content store always returned
        try:
            size = os.fstat(handle.fileno()).st_size
            if offset > size:
                raise InvalidRangeError(f"offset {offset} is beyond the end of {key!r} ({size} bytes)")
            if length == 0 or offset == size:
                handle.close()
                return empty_stream()
            handle.seek(offset)
            available = size - offset
            limit = available if length is None else min(length, available)
            return RawStream(handle, limit=limit)  # type: ignore[return-value]
        except BaseException:
            handle.close()
            raise

    def size(self, key: str) -> int:
        try:
            *parents, name = validate_key(key).split("/")
            with self._directory(tuple(parents)) as fd:
                info = os.stat(name, dir_fd=fd)
        except (FileNotFoundError, NotADirectoryError):
            raise ObjectNotFoundError(f"no object at {key!r}") from None
        if not stat.S_ISREG(info.st_mode):
            raise ObjectNotFoundError(f"no object at {key!r}")
        return info.st_size

    def exists(self, key: str) -> bool:
        try:
            self.size(key)
        except ObjectNotFoundError:
            return False
        return True

    def list(self, prefix: str = "") -> Iterator[str]:
        validate_prefix(prefix)
        return self._walk(prefix)

    def _walk(self, prefix: str) -> Iterator[str]:
        # Only the directory part of the prefix can be walked to directly; the
        # rest (a partial segment) filters names inside it.
        directory, slash, _ = prefix.rpartition("/")
        base = directory + slash  # "" or "uploads/" or "uploads/Zk3x/"
        yield from self._walk_dir(tuple(directory.split("/")) if directory else (), base, prefix)

    def _walk_dir(self, directory: tuple[str, ...], base: str, prefix: str) -> Iterator[str]:
        try:
            with self._directory(directory) as fd, os.scandir(fd) as scan:
                entries = [(entry.name, entry.is_dir(), entry.is_file()) for entry in scan]
        except (FileNotFoundError, NotADirectoryError):
            return
        # A directory's keys all start "name/", so it sorts as that: this makes
        # the walk come out in the order of the keys' UTF-8 bytes, the order an
        # S3 listing has ("a-b" before "a/b", because '-' is below '/').
        entries.sort(key=lambda item: item[0] + "/" if item[1] else item[0])
        for name, is_dir, is_file in entries:
            if name.startswith("."):
                continue  # .tmp, the legacy .uploads, and anything else not ours
            key = base + name
            if is_dir:
                nested = key + "/"
                if nested.startswith(prefix) or prefix.startswith(nested):
                    yield from self._walk_dir((*directory, name), nested, prefix)
            elif is_file and key.startswith(prefix) and is_valid_key(key):
                yield key


def _fsync_dir(fd: int) -> None:
    """Make a directory update durable where the filesystem supports it."""
    try:
        os.fsync(fd)
    except OSError:
        pass
