"""Stable ``sch:`` short ids for papers and paper versions.

A paper's short id is derived from the CID of its ``paper.genesis``
record, so it is stable for the life of the paper and can be recomputed by
any node::

    sch:xxxx-xxxx-xxxx          paper
    sch:xxxx-xxxx-xxxx/vN       version N of that paper (N >= 1)

The twelve ``x`` characters are lowercase RFC 4648 base32 (``a-z``,
``2-7``, the alphabet CIDs use) and consist of:

* **10 payload characters** -- the first 50 bits of the genesis CID's
  sha2-256 digest, base32 encoded.  The digest is used rather than the
  leading characters of the CID *string*: every record CID starts with the
  same ``bafyrei`` header, which would leave too little entropy to avoid
  collisions.  Working from the digest also makes the id independent of the
  multibase the CID happens to be written in.
* **2 checksum characters** -- CRC-10/ATM (polynomial ``0x233``, init 0, no
  reflection, no final xor) over the 50 payload bits, most significant bit
  first, written as two base32 characters, high five bits first.  A CRC
  guarantees detection of every single-character substitution and every
  adjacent transposition, the usual ways a hand-copied id goes wrong.

Parsing is case-insensitive and always yields the canonical lowercase form.
The grouping hyphens are required.  A version number is a positive decimal
integer of at most nine digits without leading zeros.

Everything raises :class:`ValueError` with a human-readable message on bad
input; a checksum mismatch says so explicitly.  The rules are pinned
across language ports by ``vectors/short_ids.json``.
"""

from __future__ import annotations

import base64
import re
from typing import NamedTuple

from multiformats import CID

from .envelope import CID_CODEC, CID_HASH, CID_VERSION

#: Scheme prefix of every short id and version id.
SHORT_ID_PREFIX = "sch:"

#: Lowercase RFC 4648 base32 alphabet (the one CIDs use).
SHORT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

#: Characters taken from the genesis CID digest.
SHORT_ID_PAYLOAD_LENGTH = 10

#: Checksum characters following the payload.
SHORT_ID_CHECKSUM_LENGTH = 2

#: Characters per hyphen-separated group.
SHORT_ID_GROUP_SIZE = 4

#: Largest supported version number (nine decimal digits).
MAX_VERSION = 999_999_999

_BITS_PER_CHAR = 5
_CRC_WIDTH = 10  # == SHORT_ID_CHECKSUM_LENGTH * _BITS_PER_CHAR
_CRC_MASK = (1 << _CRC_WIDTH) - 1
_CRC_POLY = 0x233  # CRC-10/ATM: x^10 + x^9 + x^5 + x^4 + x + 1

_ID_PATTERN = re.compile(
    r"sch:(?P<g1>[a-z2-7]{4})-(?P<g2>[a-z2-7]{4})-(?P<g3>[a-z2-7]{4})"
    r"(?:/v(?P<version>[1-9][0-9]{0,8}))?",
    re.ASCII | re.IGNORECASE,
)

_SHOW_LIMIT = 60


class VersionId(NamedTuple):
    """A parsed ``sch:xxxx-xxxx-xxxx/vN`` id."""

    short_id: str
    """Canonical paper short id, ``sch:xxxx-xxxx-xxxx``."""
    version: int
    """Version number ``N``, at least 1."""


def _show(value: object) -> str:
    """``repr`` of ``value`` clipped so errors never echo huge input."""
    text = repr(value)
    if len(text) > _SHOW_LIMIT:
        text = text[: _SHOW_LIMIT - 3] + "..."
    return text


def _crc10(value: int, bit_count: int) -> int:
    """CRC-10/ATM over the low ``bit_count`` bits of ``value``, MSB first."""
    crc = 0
    for shift in range(bit_count - 1, -1, -1):
        feedback = ((crc >> (_CRC_WIDTH - 1)) ^ (value >> shift)) & 1
        crc = (crc << 1) & _CRC_MASK
        if feedback:
            crc ^= _CRC_POLY
    return crc


def _checksum(payload: str) -> str:
    """Return the checksum characters for a validated payload string."""
    value = 0
    for char in payload:
        value = (value << _BITS_PER_CHAR) | SHORT_ID_ALPHABET.index(char)
    crc = _crc10(value, len(payload) * _BITS_PER_CHAR)
    return "".join(
        SHORT_ID_ALPHABET[(crc >> (_BITS_PER_CHAR * place)) & 0x1F]
        for place in reversed(range(SHORT_ID_CHECKSUM_LENGTH))
    )


def _group(body: str) -> str:
    """Render the 12 id characters as ``sch:xxxx-xxxx-xxxx``."""
    groups = (
        body[i : i + SHORT_ID_GROUP_SIZE]
        for i in range(0, len(body), SHORT_ID_GROUP_SIZE)
    )
    return SHORT_ID_PREFIX + "-".join(groups)


def _genesis_digest(genesis_cid: str | CID) -> bytes:
    if isinstance(genesis_cid, CID):
        cid = genesis_cid
    elif isinstance(genesis_cid, str):
        try:
            cid = CID.decode(genesis_cid)
        except (ValueError, KeyError) as exc:
            raise ValueError(
                f"genesis CID {_show(genesis_cid)} is not a valid CID"
            ) from exc
    else:
        raise ValueError(
            "genesis CID must be a CID string or object, "
            f"got {type(genesis_cid).__name__}"
        )
    if (
        cid.version != CID_VERSION
        or cid.codec.name != CID_CODEC
        or cid.hashfun.name != CID_HASH
    ):
        raise ValueError(
            f"genesis CID {_show(str(cid))} is not a record id: expected "
            f"CIDv{CID_VERSION} with {CID_CODEC} codec and {CID_HASH} hash"
        )
    return bytes(cid.raw_digest)


def derive_short_id(genesis_cid: str | CID) -> str:
    """Derive the stable ``sch:xxxx-xxxx-xxxx`` short id of a paper.

    ``genesis_cid`` is the record id (CIDv1, dag-cbor, sha2-256) of the
    paper's ``paper.genesis`` record, as a string in any multibase or as a
    ``CID`` object.  The same genesis always yields the same short id.

    Raises:
        ValueError: if ``genesis_cid`` is not a valid record CID.
    """
    digest = _genesis_digest(genesis_cid)
    # 7 bytes = 56 bits is the smallest whole number of bytes covering the
    # 50 payload bits; b32encode renders it as 11 significant characters.
    encoded = base64.b32encode(digest[:7]).decode("ascii").lower()
    payload = encoded[:SHORT_ID_PAYLOAD_LENGTH]
    return _group(payload + _checksum(payload))


def _parse(value: object) -> tuple[str, int | None]:
    """Validate ``value`` and return ``(short_id, version or None)``."""
    if not isinstance(value, str):
        raise ValueError(f"sch: id must be a string, got {type(value).__name__}")
    match = _ID_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError(
            f"{_show(value)} is not a valid sch: id; expected "
            "'sch:xxxx-xxxx-xxxx' or 'sch:xxxx-xxxx-xxxx/vN' with base32 "
            "characters (a-z, 2-7) and N from 1 to "
            f"{MAX_VERSION}"
        )
    body = "".join(match.group("g1", "g2", "g3")).lower()
    payload = body[:SHORT_ID_PAYLOAD_LENGTH]
    if body[SHORT_ID_PAYLOAD_LENGTH:] != _checksum(payload):
        raise ValueError(
            f"sch: id {_show(value)} has a bad checksum; "
            "it was probably mistyped or truncated"
        )
    version = match.group("version")
    return _group(body), None if version is None else int(version)


def parse_short_id(value: str) -> str:
    """Validate a paper ``sch:xxxx-xxxx-xxxx`` id; return its canonical form.

    The canonical form is lowercase.  A version id (``.../vN``) is not
    accepted here; use :func:`parse_version_id`.

    Raises:
        ValueError: if ``value`` is malformed, carries a version suffix, or
            has a bad checksum.
    """
    short_id, version = _parse(value)
    if version is not None:
        raise ValueError(
            f"{_show(value)} is a version id; expected a paper id "
            "'sch:xxxx-xxxx-xxxx' without a /vN suffix"
        )
    return short_id


def parse_version_id(value: str) -> VersionId:
    """Parse a ``sch:xxxx-xxxx-xxxx/vN`` version id.

    Returns the canonical paper short id and the version number.

    Raises:
        ValueError: if ``value`` is malformed, has no ``/vN`` suffix, or has
            a bad checksum.
    """
    short_id, version = _parse(value)
    if version is None:
        raise ValueError(
            f"{_show(value)} has no version; expected "
            "'sch:xxxx-xxxx-xxxx/vN'"
        )
    return VersionId(short_id, version)


def format_version_id(short_id: str, version: int) -> str:
    """Return the ``sch:xxxx-xxxx-xxxx/vN`` id of version ``version``.

    ``short_id`` is validated (checksum included) and canonicalised.

    Raises:
        ValueError: if ``short_id`` is not a valid paper short id or
            ``version`` is not an integer from 1 to :data:`MAX_VERSION`.
    """
    canonical = parse_short_id(short_id)
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or not 1 <= version <= MAX_VERSION
    ):
        raise ValueError(
            f"version must be an integer from 1 to {MAX_VERSION}, "
            f"got {_show(version)}"
        )
    return f"{canonical}/v{version}"
