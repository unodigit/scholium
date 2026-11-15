"""A strict, dependency-light CARv1 reader.

A CAR ("Content Addressable aRchive") v1 file is::

    varint(len(header)) header  { varint(len(cid) + len(data)) cid data }*

where ``header`` is DAG-CBOR ``{"roots": [CID, ...], "version": 1}``, every
``cid`` is a binary CID and ``data`` is the block the CID names.  Scholium
exports papers, their files and their log entries as such an archive, and
``scholium verify`` reads one without any network access.

:func:`read_car` parses the structure and refuses anything ambiguous:
truncated sections, non-minimal varints, trailing bytes that are not a
whole section, CARv2.  It does *not* decide whether a block is authentic --
the bytes of a section are only as trustworthy as their CID says, so
:func:`block_problem` recomputes the hash of each block and reports a
mismatch, and the caller decides what a mismatch means.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import dag_cbor
from dag_cbor.decoding.err import CBORDecodingError
from multiformats import CID

__all__ = [
    "Block",
    "Car",
    "CarError",
    "block_problem",
    "read_car",
]

#: The only CAR version understood.
CAR_VERSION = 1

#: Longest varint accepted (a 63-bit length needs nine bytes).
_MAX_VARINT_BYTES = 9

#: First bytes of a CIDv0: the sha2-256 multihash header ``0x12 0x20``.
_CIDV0_PREFIX = b"\x12\x20"
_CIDV0_LENGTH = 34


class CarError(ValueError):
    """The file is not a well-formed CARv1 archive."""


@dataclass(frozen=True)
class Block:
    """One section of the archive: a CID and the bytes it claims to name."""

    cid: CID
    data: bytes


@dataclass(frozen=True)
class Car:
    """A parsed archive."""

    roots: tuple[CID, ...]
    blocks: tuple[Block, ...]

    def __iter__(self) -> Iterator[Block]:
        return iter(self.blocks)


def _read_varint(view: memoryview, offset: int, what: str) -> tuple[int, int]:
    """Read an unsigned LEB128 varint; return ``(value, offset after it)``."""
    value = 0
    for position in range(_MAX_VARINT_BYTES):
        index = offset + position
        if index >= len(view):
            raise CarError(f"the archive ends inside {what}")
        byte = view[index]
        value |= (byte & 0x7F) << (7 * position)
        if not byte & 0x80:
            if position and byte == 0:
                raise CarError(f"{what} is not minimally encoded")
            return value, index + 1
    raise CarError(f"{what} is longer than {_MAX_VARINT_BYTES} bytes")


def _cid_length(view: memoryview, start: int, end: int) -> int:
    """Return the byte length of the binary CID at ``view[start:end]``."""
    if bytes(view[start : start + 2]) == _CIDV0_PREFIX:
        length = _CIDV0_LENGTH
    else:
        position = start
        for what in ("CID version", "CID codec", "CID hash function"):
            _, position = _read_varint(view[:end], position, what)
        digest_size, position = _read_varint(view[:end], position, "CID digest size")
        length = position - start + digest_size
    if start + length > end:
        raise CarError("a section is too short to hold the CID it starts with")
    return length


def _read_cid(view: memoryview, start: int, end: int) -> tuple[CID, int]:
    length = _cid_length(view, start, end)
    try:
        cid = CID.decode(bytes(view[start : start + length]))
    except (ValueError, KeyError, TypeError) as exc:
        raise CarError(f"a section starts with an invalid CID: {exc}") from exc
    return cid, start + length


def _read_header(view: memoryview) -> tuple[tuple[CID, ...], int]:
    size, start = _read_varint(view, 0, "the header length")
    if size == 0 or start + size > len(view):
        raise CarError("the archive header is truncated")
    try:
        header = dag_cbor.decode(bytes(view[start : start + size]))
    except (CBORDecodingError, ValueError, RecursionError) as exc:
        raise CarError(f"the archive header is not valid DAG-CBOR: {exc}") from exc
    if not isinstance(header, dict):
        raise CarError("the archive header is not a map")
    version = header.get("version")
    if version != CAR_VERSION or isinstance(version, bool):
        raise CarError(
            f"unsupported CAR version {version!r}; only CARv{CAR_VERSION} is supported"
        )
    roots = header.get("roots")
    if not isinstance(roots, list):
        raise CarError("the archive header's roots must be a list of CIDs")
    cids: list[CID] = []
    for root in roots:
        if not isinstance(root, CID):
            raise CarError("the archive header's roots must be a list of CIDs")
        cids.append(root)
    return tuple(cids), start + size


def read_car(data: bytes | bytearray | memoryview) -> Car:
    """Parse a CARv1 archive held in memory.

    Raises:
        CarError: if ``data`` is not a well-formed CARv1 archive.  A block
            whose bytes do not hash to its CID is *not* an error here; see
            :func:`block_problem`.
    """
    view = memoryview(data)
    roots, offset = _read_header(view)
    blocks: list[Block] = []
    while offset < len(view):
        size, start = _read_varint(view, offset, "a section length")
        end = start + size
        if size == 0:
            raise CarError("a section is empty")
        if end > len(view):
            raise CarError(
                f"section {len(blocks) + 1} is truncated: it claims {size} bytes "
                f"but only {len(view) - start} remain"
            )
        cid, payload = _read_cid(view, start, end)
        blocks.append(Block(cid, bytes(view[payload:end])))
        offset = end
    return Car(roots, tuple(blocks))


def block_problem(block: Block) -> str | None:
    """Why the bytes of ``block`` are not what its CID names, or ``None``.

    Recomputes the multihash named by the CID over the block data.  A hash
    function that cannot be computed here is reported as a problem rather
    than skipped: an unverifiable block must not look verified.
    """
    cid = block.cid
    try:
        expected = cid.digest
        actual = cid.hashfun.digest(block.data)
    except (ValueError, KeyError, ImportError) as exc:
        # ImportError: a known multihash (e.g. blake3) whose optional library
        # is not installed.  Decoding such a CID works; hashing does not.
        return f"uses a hash function that cannot be checked here ({exc})"
    if bytes(actual) != bytes(expected):
        return "bytes do not match the hash in its CID"
    return None
