"""The ObjectStore interface every storage driver implements (plugin: storage).

An object store holds *objects*: byte strings addressed by a *key*.  Callers
never learn where the bytes physically live -- a directory on disk or a bucket
behind the S3 API -- and every driver gives the same answers to the same
calls; ``tests/__init__.py`` is the one contract suite both drivers must pass.

Keys
----
A key is a ``/``-separated path of segments: ``bafkrei...`` or
``uploads/Zk3x/00000001``.  Keys are validated by every operation, before any
I/O, because they come (indirectly) from clients and one of the drivers turns
them into file paths:

* each segment is non-empty and does not start with ``.`` -- which keeps ``.``
  and ``..`` out, and leaves dot-names (the filesystem driver's ``.tmp``) free
  for a driver's own bookkeeping;
* no control characters, no backslash, valid UTF-8;
* at most 1024 bytes in all and 255 per segment.

A key is a name, not a path: an object may not be stored at a key that is
also the directory part of another key (``a`` and ``a/b``).  The filesystem
cannot hold both and refuses; an S3 bucket could, so don't rely on it.

Semantics both drivers share
----------------------------
* :meth:`~ObjectStore.put_stream` replaces whatever is at the key, atomically:
  a reader sees the old object or the whole new one, never a mixture or a
  prefix, and a write that fails leaves the old object alone.
* :meth:`~ObjectStore.delete` of a missing key is a no-op.
* :meth:`~ObjectStore.list` yields keys in ascending order of their UTF-8 bytes.
* Reading a missing key raises :class:`ObjectNotFoundError`, which is also a
  :class:`FileNotFoundError`.
"""

from __future__ import annotations

import abc
import hashlib
import io
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import BinaryIO, Optional, Protocol

__all__ = [
    "CHUNK_SIZE",
    "ChunkSource",
    "InvalidKeyError",
    "InvalidRangeError",
    "KeyConflictError",
    "MAX_KEY_BYTES",
    "MAX_SEGMENT_BYTES",
    "ObjectNotFoundError",
    "ObjectStore",
    "ObjectStoreError",
    "RawStream",
    "StorageConfigError",
    "StoredObject",
    "SupportsRead",
    "empty_stream",
    "is_valid_key",
    "validate_key",
    "validate_prefix",
    "validate_range",
]

#: How many bytes are read from a source stream at a time.
CHUNK_SIZE = 1024 * 1024

#: The longest key, in UTF-8 bytes (the S3 limit).
MAX_KEY_BYTES = 1024
#: The longest key segment, in UTF-8 bytes (the usual filesystem limit).
MAX_SEGMENT_BYTES = 255

#: Control characters (which include NUL and newlines) and backslash.
_FORBIDDEN_CHARS = re.compile(r"[\x00-\x1f\x7f\\]")


class ObjectStoreError(Exception):
    """An object store could not do what it was asked."""


class StorageConfigError(ObjectStoreError):
    """The storage backend is not configured well enough to be used."""


class InvalidKeyError(ObjectStoreError, ValueError):
    """A key (or prefix) is not one this interface accepts; nothing was done."""


class InvalidRangeError(ObjectStoreError, ValueError):
    """A byte range cannot be satisfied: it starts after the end of the object."""


class ObjectNotFoundError(ObjectStoreError, FileNotFoundError):
    """No object is stored at the key."""


class KeyConflictError(ObjectStoreError):
    """The key clashes with another key's directory part (filesystem driver only)."""


class SupportsRead(Protocol):
    """A binary readable: ``read(n)`` returns up to ``n`` bytes, ``b""`` at EOF."""

    def read(self, size: int = -1, /) -> bytes: ...


@dataclass(frozen=True)
class StoredObject:
    """The outcome of :meth:`ObjectStore.put_stream`."""

    key: str
    #: How many bytes were stored.
    size: int
    #: The raw 32-byte sha2-256 digest of the bytes read from the stream, so a
    #: caller expecting particular content can check what was actually stored.
    sha256: bytes


# ---------------------------------------------------------------------------
# Key validation
# ---------------------------------------------------------------------------


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _check_text(value: str, *, what: str) -> None:
    if _FORBIDDEN_CHARS.search(value):
        raise InvalidKeyError(f"{what} {_show(value)} contains a control character or backslash")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        raise InvalidKeyError(f"{what} {_show(value)} is not valid UTF-8") from None
    if len(encoded) > MAX_KEY_BYTES:
        raise InvalidKeyError(f"{what} is longer than {MAX_KEY_BYTES} bytes")


def _check_segment(segment: str, *, whole: str, what: str) -> None:
    if not segment:
        raise InvalidKeyError(f"{what} {_show(whole)} has an empty path segment")
    if segment.startswith("."):
        raise InvalidKeyError(f"{what} {_show(whole)} has a path segment starting with '.'")
    if len(segment.encode("utf-8")) > MAX_SEGMENT_BYTES:
        raise InvalidKeyError(f"{what} {_show(whole)} has a path segment longer than {MAX_SEGMENT_BYTES} bytes")


def validate_key(key: object) -> str:
    """``key`` itself if it is a valid object key (see the module docstring).

    Raises:
        InvalidKeyError: otherwise.  It is also a :class:`ValueError`.
    """
    if not isinstance(key, str):
        raise InvalidKeyError(f"an object key must be a str, got {type(key).__name__}")
    _check_text(key, what="object key")
    for segment in key.split("/"):
        _check_segment(segment, whole=key, what="object key")
    return key


def is_valid_key(key: object) -> bool:
    """Whether :func:`validate_key` accepts ``key``."""
    try:
        validate_key(key)
    except InvalidKeyError:
        return False
    return True


def validate_prefix(prefix: object) -> str:
    """``prefix`` itself if it can be the start of a valid key.

    ``""`` is every key.  Like a key, but the last segment may be partial or
    empty (``"uploads/Zk"`` and ``"uploads/"`` are both fine).

    Raises:
        InvalidKeyError: otherwise.
    """
    if not isinstance(prefix, str):
        raise InvalidKeyError(f"a key prefix must be a str, got {type(prefix).__name__}")
    if not prefix:
        return prefix
    _check_text(prefix, what="key prefix")
    *whole_segments, last = prefix.split("/")
    for segment in whole_segments:
        _check_segment(segment, whole=prefix, what="key prefix")
    if last:
        _check_segment(last, whole=prefix, what="key prefix")
    return prefix


def validate_range(offset: object, length: object) -> None:
    """Check the arguments of :meth:`ObjectStore.open`.

    Raises:
        ValueError: ``offset`` is not a non-negative int, or ``length`` is
            neither ``None`` nor a non-negative int.
    """
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError(f"offset must be a non-negative int, got {offset!r}")
    if length is not None and (isinstance(length, bool) or not isinstance(length, int) or length < 0):
        raise ValueError(f"length must be None or a non-negative int, got {length!r}")


# ---------------------------------------------------------------------------
# Helpers the drivers share
# ---------------------------------------------------------------------------


class ChunkSource:
    """Iterate a binary stream in chunks, counting and hashing what passes.

    ``stream`` must be a *binary* readable; a text-mode stream raises
    :class:`TypeError` as soon as it is read, before the driver has stored
    anything it would have to take back.  After one full iteration
    :meth:`stored` describes what went through.
    """

    def __init__(self, stream: SupportsRead, chunk_size: int = CHUNK_SIZE) -> None:
        if not callable(getattr(stream, "read", None)):
            raise TypeError(f"stream must have a read() method, got {type(stream).__name__}")
        self._stream = stream
        self._chunk_size = chunk_size
        self._digest = hashlib.sha256()
        self.size = 0

    def __iter__(self) -> Iterator[bytes]:
        while True:
            chunk = self._stream.read(self._chunk_size)
            if not isinstance(chunk, (bytes, bytearray, memoryview)):
                raise TypeError(
                    f"stream must be a binary readable; read() returned {type(chunk).__name__}"
                )
            if not chunk:
                return
            self._digest.update(chunk)
            self.size += len(chunk)
            yield chunk

    def stored(self, key: str) -> StoredObject:
        """The :class:`StoredObject` for everything iterated so far."""
        return StoredObject(key=key, size=self.size, sha256=self._digest.digest())


class _Source(Protocol):
    def read(self, size: int, /) -> bytes: ...

    def close(self) -> None: ...


class RawStream(io.RawIOBase):
    """A forward-only binary reader over anything with ``read(n)`` and ``close()``.

    What :meth:`ObjectStore.open` returns when the bytes are not simply a
    local file: an S3 response body, or a byte range of a file.  With ``limit``
    it ends after that many bytes.  It is a context manager, and closing it
    closes the source.  It is not seekable.
    """

    def __init__(self, source: _Source, limit: Optional[int] = None) -> None:
        super().__init__()
        self._source = source
        self._remaining = limit

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        view = memoryview(buffer).cast("B")
        want = len(view)
        if self._remaining is not None:
            want = min(want, self._remaining)
        if want == 0:
            return 0
        data = self._source.read(want)
        count = len(data)
        view[:count] = data
        if self._remaining is not None:
            self._remaining -= count
        return count

    def close(self) -> None:
        try:
            self._source.close()
        finally:
            super().close()


class _Empty:
    """A source with nothing in it, for ranges that select no bytes."""

    def read(self, size: int, /) -> bytes:
        return b""

    def close(self) -> None:
        pass


def empty_stream() -> BinaryIO:
    """A reader that is at EOF at once (what a zero-length range opens)."""
    return RawStream(_Empty())  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# The interface
# ---------------------------------------------------------------------------


class ObjectStore(abc.ABC):
    """Keyed byte-string storage.  See the module docstring for the shared rules."""

    @abc.abstractmethod
    def put_stream(self, key: str, stream: SupportsRead) -> StoredObject:
        """Store everything ``stream`` yields until EOF at ``key``, replacing any object there.

        ``stream`` must be a *binary* readable (``read(n)`` returns ``bytes``);
        anything else raises :class:`TypeError` and stores nothing.  If the
        stream raises, so does this call, and nothing is stored.

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
            ObjectStoreError: the store could not take the bytes.
        """

    @abc.abstractmethod
    def open(self, key: str, *, offset: int = 0, length: Optional[int] = None) -> BinaryIO:
        """Open the object at ``key`` for streaming reads, optionally just a byte range.

        With the defaults it yields the whole object.  ``offset`` is the first
        byte wanted and ``length`` how many bytes at most (``None``: to the
        end); a ``length`` running past the end is cut short there.  An
        ``offset`` equal to the object's size yields nothing; one beyond it is
        an error.  The result is a binary file-like that need not be seekable;
        close it (it is a context manager).

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
            ValueError: ``offset`` or ``length`` is negative (or not an int).
            ObjectNotFoundError: nothing is stored at ``key``.
            InvalidRangeError: ``offset`` is beyond the end of the object.
        """

    @abc.abstractmethod
    def size(self, key: str) -> int:
        """The size in bytes of the object at ``key``.

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
            ObjectNotFoundError: nothing is stored at ``key``.
        """

    @abc.abstractmethod
    def exists(self, key: str) -> bool:
        """Whether an object is stored at ``key``.

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
        """

    @abc.abstractmethod
    def delete(self, key: str) -> None:
        """Remove the object at ``key``; nothing happens if there is none.

        Raises:
            InvalidKeyError: ``key`` is not a valid key.
        """

    @abc.abstractmethod
    def list(self, prefix: str = "") -> Iterator[str]:
        """The keys that start with ``prefix`` (any string prefix, not only whole segments), in order.

        The default ``""`` lists everything.  The prefix is checked at once;
        the keys themselves are produced lazily as the result is iterated.

        Raises:
            InvalidKeyError: ``prefix`` could not start a valid key.
        """
