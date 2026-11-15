"""Accepting a ``manifest`` record (plugin: submissions, feature 48).

A ``manifest`` record is the signed file list of a paper version
(:mod:`scholium_record_core.manifest`)::

    {"files": [
        {"path": "paper.pdf", "cid": "bafkrei...", "size": 1048576,
         "mediaType": "application/pdf", "role": "manuscript"}
    ]}

The record core validates that body's *shape*.  This module adds the one
check a signature cannot make: that the bytes exist.  Every listed ``cid``
must have a row in the content store's ``blobs`` table, and the row's
``size`` must equal the size the manifest declares.  A manifest whose files
are missing -- or are recorded with a different length -- can never be served
as signed, so it is refused with ``422`` problem details naming the file
``path`` and is not appended to the ledger.

Only those two properties are checked.  ``scan_status`` is the sanitizer's
verdict and is deliberately not consulted (a manifest may be signed while
scanning runs); neither is the declared ``mediaType``, which the content
store treats as a hint.

``handle_manifest`` is registered with the ingest registry at import time.
Any authenticated caller may relay the record (``min_tier`` is ``0``): a
manifest is self-authenticating and harmless in itself -- it names bytes that
already exist -- and a paper's authority is decided when its ``paper.genesis``
and ``paper.version`` records are accepted.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from app.modules import content
from app.modules.ingest.errors import InvalidRecord

from .errors import ManifestFileNotStored, ManifestFileSizeMismatch

__all__ = [
    "MANIFEST_MIN_TIER",
    "MANIFEST_TYPE",
    "handle_manifest",
    "manifest_files",
    "validate_manifest_files",
]

#: The record type this plugin owns.
MANIFEST_TYPE = "manifest"

#: Lowest trust tier allowed to submit the record.  A manifest is a signed
#: statement about bytes that already exist here; accepting it needs no
#: author entitlement (``paper.genesis``/``paper.version`` decide that).
MANIFEST_MIN_TIER = 0

#: Body-level key holding the file list (see ``scholium_record_core.manifest``).
_FILES_FIELD = "files"


def manifest_files(record: Mapping[str, Any]) -> Sequence[Any]:
    """Return the file entries of a validated manifest record (or body).

    Accepts either a full envelope (``{"body": {"files": [...]}, ...}``) or the
    body itself, which keeps the function usable from tests and from a future
    caller that already unwrapped it.

    Raises:
        InvalidRecord: ``422`` problem details when the structure is not a
            manifest body.  The ingest pipeline's schema check normally
            catches this first; the explicit check keeps direct callers safe.
    """
    body = record.get("body") if isinstance(record, Mapping) and "body" in record else record
    if not isinstance(body, Mapping):
        raise InvalidRecord(
            ["the manifest body must be an object"],
            detail="The manifest body must be a JSON object.",
        )

    files = body.get(_FILES_FIELD)
    if isinstance(files, (str, bytes)) or not isinstance(files, Sequence):
        raise InvalidRecord(
            ["manifest field 'files' must be a list of file entries"],
            detail="The manifest field 'files' must be a list of file entries.",
        )
    if not files:
        raise InvalidRecord(
            ["manifest field 'files' must list at least one file"],
            detail="The manifest field 'files' must list at least one file.",
        )
    return files


def _entry_field(entry: Mapping[str, Any], field: str, index: int) -> Any:
    """Read one entry field, refusing a wrong type as an invalid record (422)."""
    value = entry.get(field)
    if field == "path":
        if not isinstance(value, str) or not value:
            raise InvalidRecord(
                [_entry_message(index, f'field {field!r} must be a non-empty string')],
                detail=f"Manifest entry files[{index}] field 'path' must be a non-empty string.",
            )
    elif field == "cid":
        if not isinstance(value, str) or not value:
            raise InvalidRecord(
                [_entry_message(index, f'field {field!r} must be a non-empty string')],
                detail=f"Manifest entry files[{index}] field 'cid' must be a non-empty string.",
            )
    elif field == "size":
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise InvalidRecord(
                [_entry_message(index, "field 'size' must be a non-negative integer")],
                detail=(
                    f"Manifest entry files[{index}] field 'size' must be a "
                    "non-negative integer number of bytes."
                ),
            )
    return value


def _entry_message(index: int, detail: str) -> dict[str, Any]:
    message = f"Manifest entry files[{index}]: {detail}."
    return {
        "loc": ["body", _FILES_FIELD, index],
        "msg": message,
        "type": "invalid_record",
        "input": None,
    }


def validate_manifest_files(record: Mapping[str, Any]) -> None:
    """Refuse ``record`` unless every listed file is stored at its declared size.

    For each entry, in manifest order, the ``cid`` must have a row in ``blobs``
    and that row's ``size`` must equal the declared ``size``.  The first entry
    that fails is reported, naming its ``path``:

    * no row -- :class:`~.errors.ManifestFileNotStored` (``422``);
    * a row of another size -- :class:`~.errors.ManifestFileSizeMismatch`
      (``422``).

    Returns ``None`` when every file is present and matches.
    """
    for index, entry in enumerate(manifest_files(record)):
        if not isinstance(entry, Mapping):
            raise InvalidRecord(
                [_entry_message(index, "must be an object")],
                detail=f"Manifest entry files[{index}] must be an object.",
            )
        path = _entry_field(entry, "path", index)
        cid = _entry_field(entry, "cid", index)
        size = _entry_field(entry, "size", index)

        blob = content.get_blob(cid)
        if blob is None:
            raise ManifestFileNotStored(path, cid, index)
        if blob.size != size:
            raise ManifestFileSizeMismatch(path, cid, size, blob.size, index)


def handle_manifest(record: Mapping[str, Any]) -> None:
    """Ingest handler for ``manifest`` records: validate the listed blobs.

    Called by :func:`app.modules.ingest.service.ingest` before the record is
    appended, so raising here refuses the record and nothing is stored.  A
    valid manifest reports no state (the pipeline answers ``"accepted"``).
    """
    validate_manifest_files(record)
    return None
