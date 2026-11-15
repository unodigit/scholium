"""Upload size limits and tus upload classification (plugin: uploads).

A creation request tells the server what it is uploading either through
tus ``Upload-Metadata`` (base64-encoded values, as sent by tus-js-client
and Uppy) or — less canonically — through the request ``Content-Type``.
From those signals we classify the upload as a PDF, a bundle (source,
code or data archive), or something else, and apply the spec's limits:

* a PDF may be at most 50 MiB (``52,428,800`` bytes);
* a bundle may be at most 5 GiB (``5,368,709,120`` bytes);
* anything we cannot classify gets the bundle limit, the largest size
  the API accepts at all, so an unlabelled upload can never exceed the
  global cap.

Everything here is pure logic with no framework imports so it can be
unit-tested directly.
"""

from __future__ import annotations

import base64
import binascii
from typing import Optional

TUS_VERSION = "1.0.0"

KIND_PDF = "pdf"
KIND_BUNDLE = "bundle"
KIND_OTHER = "other"

PDF_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB
BUNDLE_MAX_BYTES = 5 * 1024**3  # 5 GiB

#: The largest single upload the API accepts, whatever its kind.
MAX_UPLOAD_BYTES = BUNDLE_MAX_BYTES

_KIND_LIMITS = {
    KIND_PDF: PDF_MAX_BYTES,
    KIND_BUNDLE: BUNDLE_MAX_BYTES,
    KIND_OTHER: BUNDLE_MAX_BYTES,
}

#: Metadata keys that name the payload's media type or kind.
_TYPE_KEYS = frozenset(
    {
        "type",
        "filetype",
        "file_type",
        "content_type",
        "content-type",
        "contenttype",
        "media_type",
        "media-type",
        "mediatype",
        "mime_type",
        "mime-type",
        "mimetype",
        "mime",
        "kind",
        "upload_type",
        "upload-type",
        "uploadtype",
        "category",
    }
)

#: Metadata keys that carry a filename we can look at the extension of.
_NAME_KEYS = frozenset({"filename", "file_name", "file", "name", "path", "filepath", "file_path"})

_PDF_TYPES = frozenset({"application/pdf", "application/x-pdf", "pdf"})

_BUNDLE_TYPES = frozenset(
    {
        "application/zip",
        "application/x-zip-compressed",
        "application/x-zip",
        "zip",
        "application/x-tar",
        "application/tar",
        "tar",
        "application/gzip",
        "application/x-gzip",
        "gzip",
        "application/x-bzip",
        "application/x-bzip2",
        "application/bzip2",
        "application/x-xz",
        "application/x-xz-compressed",
        "application/x-7z-compressed",
        "application/x-7z",
        "application/zstd",
        "application/x-rar-compressed",
        "application/vnd.rar",
        "bundle",
    }
)

_BUNDLE_KEYWORDS = ("zip", "tar", "gzip", "gz", "bzip", "bz2", "xz", "7z", "rar", "zst", "compress", "archive", "bundle")

_PDF_EXTENSIONS = (".pdf",)

_BUNDLE_EXTENSIONS = (
    ".zip",
    ".tar",
    ".tgz",
    ".tar.gz",
    ".tar.bz2",
    ".tar.xz",
    ".gz",
    ".bz2",
    ".xz",
    ".7z",
    ".rar",
    ".zst",
)

#: Content types that belong to the tus/HTTP transport itself and must
#: never be read as a statement about the payload being uploaded.
_TRANSPORT_CONTENT_TYPES = frozenset(
    {
        "application/offset+octet-stream",
        "application/octet-stream",
        "application/json",
        "application/problem+json",
        "application/x-www-form-urlencoded",
        "text/plain",
    }
)


def _looks_like_text(value: str) -> bool:
    """True when ``value`` is printable text (a decoded value, not binary noise)."""
    if not value:
        return False
    printable = sum(1 for ch in value if ch.isprintable() or ch in "\t\n\r")
    return printable / len(value) > 0.9


def decode_metadata_value(raw: str) -> str:
    """Decode one tus metadata value.

    tus 1.0.0 encodes every value as base64, but hand-rolled clients and
    tests sometimes send the plain string. Try base64 first (so encoded
    values win) and fall back to the raw text whenever decoding yields
    anything that is not clean printable text.
    """
    raw = raw.strip()
    if not raw:
        return ""
    for candidate in (raw, raw + "=" * (-len(raw) % 4)):
        try:
            decoded = base64.b64decode(candidate, validate=True).decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            continue
        if _looks_like_text(decoded):
            return decoded
    return raw


def parse_upload_metadata(header: Optional[str]) -> dict[str, str]:
    """Parse a tus ``Upload-Metadata`` header into ``{key: value}``.

    The header is a comma-separated list of ``key`` or ``key value``
    pairs where every value is base64-encoded (``filename
    dGVzdC5wZGY=``). Keys are lower-cased; values are decoded with a
    plain-text fallback. An absent, empty or malformed header yields an
    empty mapping — malformed pairs are skipped rather than rejected so
    one bad pair cannot break an otherwise usable creation request.
    """
    if not header:
        return {}
    metadata: dict[str, str] = {}
    for pair in header.split(","):
        pair = pair.strip()
        if not pair:
            continue
        parts = pair.split(None, 1)
        key = parts[0].lower()
        if not key:
            continue
        value = decode_metadata_value(parts[1]) if len(parts) > 1 else ""
        metadata[key] = value
    return metadata


def _classify_type_value(value: str) -> Optional[str]:
    """Classify a media-type-ish string such as ``application/pdf``."""
    normalized = value.strip().lower()
    if not normalized or normalized in _TRANSPORT_CONTENT_TYPES:
        return None
    if normalized in _PDF_TYPES or normalized.endswith("/pdf") or normalized.endswith(".pdf"):
        return KIND_PDF
    if normalized in _BUNDLE_TYPES:
        return KIND_BUNDLE
    if "pdf" in normalized:
        return KIND_PDF
    if any(keyword in normalized for keyword in _BUNDLE_KEYWORDS):
        return KIND_BUNDLE
    return None


def _classify_name_value(value: str) -> Optional[str]:
    """Classify a filename such as ``paper.tar.gz`` by its extension."""
    normalized = value.strip().lower()
    if not normalized:
        return None
    if normalized.endswith(_PDF_EXTENSIONS):
        return KIND_PDF
    if normalized.endswith(_BUNDLE_EXTENSIONS):
        return KIND_BUNDLE
    return None


def classify_upload(
    metadata: Optional[dict[str, str]] = None,
    *,
    content_type: Optional[str] = None,
) -> str:
    """Return :data:`KIND_PDF`, :data:`KIND_BUNDLE` or :data:`KIND_OTHER`.

    Every signal is consulted; a PDF hint anywhere wins over a bundle
    hint, because the PDF limit is the stricter one and a PDF must never
    slip past it by also claiming to be an archive. Metadata keys naming
    a type outrank filename extensions, which outrank the request's own
    ``Content-Type``.
    """
    metadata = metadata or {}
    kinds: list[str] = []
    for key, value in metadata.items():
        classifier = _classify_type_value if key in _TYPE_KEYS else _classify_name_value if key in _NAME_KEYS else None
        if classifier is None:
            continue
        kind = classifier(value)
        if kind is not None:
            kinds.append(kind)
    if content_type:
        kind = _classify_type_value(content_type.partition(";")[0].strip())
        if kind is not None:
            kinds.append(kind)
    if KIND_PDF in kinds:
        return KIND_PDF
    if KIND_BUNDLE in kinds:
        return KIND_BUNDLE
    return KIND_OTHER


def limit_for(kind: str) -> int:
    """Return the maximum accepted ``Upload-Length`` for ``kind``."""
    return _KIND_LIMITS.get(kind, BUNDLE_MAX_BYTES)


def limit_description(kind: str) -> str:
    """A human phrase for the limit applied to ``kind``."""
    if kind == KIND_PDF:
        return "PDF uploads are limited to 50 MiB"
    if kind == KIND_BUNDLE:
        return "bundle uploads are limited to 5 GiB"
    return "uploads are limited to 5 GiB"


def check_upload_length(upload_length: int, kind: str) -> Optional[int]:
    """Return the limit ``upload_length`` exceeds, or ``None`` when it fits.

    ``upload_length`` is the declared total size in bytes; the check is
    strictly greater-than, so an upload of exactly the limit is fine.
    """
    limit = limit_for(kind)
    return limit if upload_length > limit else None
