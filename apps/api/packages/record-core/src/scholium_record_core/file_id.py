"""Content ids for file bytes.

Every file uploaded to Scholium is addressed by a *file id*: a CIDv1
with the **raw** codec (``0x55``) and sha2-256, written in base32::

    bafkrei...

That is exactly the id IPFS assigns a raw single-block file, so file
content is addressable by any IPLD tooling without re-encoding.  The id
covers the file's exact bytes and nothing else -- no name, no media
type -- which is what lets the manifest (:mod:`scholium_record_core.manifest`)
reference files by content and the node recompute and compare ids on
download.

Record ids (:mod:`scholium_record_core.envelope`) use the dag-cbor codec
because they hash an encoding; file ids use the raw codec because they
hash the bytes themselves.  Both are CIDv1 sha2-256 base32, and the two
prefixes -- ``bafyrei`` for records, ``bafkrei`` for files -- make the
kinds visually distinct.
"""

from __future__ import annotations

import hashlib
from collections.abc import Buffer
from typing import Any

from multiformats import CID

from .envelope import CID_VERSION

#: Codec used for file ids: raw bytes, no wrapping DAG.
FILE_CODEC = "raw"
FILE_CODEC_CODE = 0x55

#: Hash function used for file ids (same as record ids).
FILE_HASH = "sha2-256"

#: Multibase file ids are written in (same as record ids).
FILE_BASE = "base32"

#: Prefix every canonical file id string starts with.
FILE_ID_PREFIX = "bafkrei"

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    """``repr`` of ``value`` clipped so errors never echo huge input."""
    text = repr(value)
    if len(text) > _SHOW_LIMIT:
        text = text[: _SHOW_LIMIT - 3] + "..."
    return text


def _as_bytes(data: Any) -> bytes:
    # The Buffer ABC covers every bytes-like type (bytes, bytearray,
    # memoryview, array.array, ...) while excluding str and int, so
    # ``bytes(data)`` never invents content.
    if isinstance(data, Buffer):
        return bytes(data)
    raise ValueError(
        "file bytes must be bytes-like (bytes, bytearray, memoryview), "
        f"got {type(data).__name__}"
    )


def compute_file_cid(data: Buffer) -> CID:
    """Return the file id of ``data`` as a CIDv1 raw-codec object.

    The CID wraps sha2-256 over the exact bytes of ``data``.  The empty
    file is a valid input and has a well-defined id.
    """
    digest = hashlib.sha256(_as_bytes(data)).digest()
    return CID(
        base=FILE_BASE,
        version=CID_VERSION,
        codec=FILE_CODEC,
        digest=(FILE_HASH, digest),
    )


def compute_file_id(data: Buffer) -> str:
    """Return the file id of ``data`` as a canonical base32 CIDv1 string.

    Deterministic: the same bytes always yield the same id; a single
    flipped bit never does.
    """
    return str(compute_file_cid(data))


def parse_file_cid(value: object) -> CID:
    """Validate a file id string and return it as a CIDv1 raw-codec object.

    ``value`` must be the canonical base32 form -- exactly what
    :func:`compute_file_id` returns.  Equivalent encodings of the same
    CID (uppercase base32, base58btc, ...) are rejected so a manifest can
    never carry two spellings of one file id.

    Raises:
        ValueError: if ``value`` is not a string, is not a valid CID, or
            is not a CIDv1 raw-codec sha2-256 id in canonical base32 form.
    """
    if not isinstance(value, str):
        raise ValueError(
            f"file id must be a string, got {type(value).__name__}"
        )
    try:
        cid = CID.decode(value)
    except (ValueError, KeyError) as exc:
        raise ValueError(f"file id {_show(value)} is not a valid CID") from exc
    if (
        cid.version != CID_VERSION
        or cid.codec.name != FILE_CODEC
        or cid.hashfun.name != FILE_HASH
    ):
        raise ValueError(
            f"file id {_show(value)} is not a raw file id: expected "
            f"CIDv{CID_VERSION} with {FILE_CODEC} codec and {FILE_HASH} "
            f"hash, got CIDv{cid.version} {cid.codec.name} {cid.hashfun.name}"
        )
    canonical = cid.encode(FILE_BASE)
    if value != canonical:
        raise ValueError(
            f"file id {_show(value)} is not in canonical base32 form; "
            f"expected {canonical}"
        )
    return cid
