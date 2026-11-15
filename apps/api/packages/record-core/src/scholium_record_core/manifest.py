"""Validation of ``manifest`` record bodies.

A ``manifest`` record lists the files of a paper version
(``docs/tech_architect.md`` §3.2)::

    {"files": [
        {"path": "main.pdf",        "cid": "bafkrei...", "size": 1048576,
         "mediaType": "application/pdf", "role": "manuscript"},
        {"path": "figures/plot.svg","cid": "bafkrei...", "size": 4021,
         "mediaType": "image/svg+xml",  "role": "figure"}
    ]}

The manifest is the map from a paper's logical layout to content
addresses.  Because the record id commits to the body bytes
(:mod:`scholium_record_core.envelope`), every field is validated strictly
so all ports agree byte-for-byte on what a manifest may contain:

* ``files`` -- a non-empty list; the only body-level key.
* ``path``  -- a normalized relative POSIX path (forward slashes, no
  leading ``/``, no ``.``/``..``/empty components, no backslashes or
  control characters, at most :data:`MAX_PATH_LENGTH` characters) and
  unique across the manifest.
* ``cid``   -- a canonical file id string (:func:
  `scholium_record_core.file_id.parse_file_cid`).
* ``size``  -- the file's exact byte length: an integer from ``0`` to
  :data:`MAX_FILE_SIZE` (booleans and floats are rejected).
* ``mediaType`` -- a bare lowercase ``type/subtype`` per RFC 6838, no
  parameters.
* ``role``  -- one of the :data:`FILE_ROLES` vocabulary; ``other`` is
  the catch-all, so nothing reasonable is ever rejected for want of a
  label.

Everything raises :class:`ValueError` with a message naming the field
and the entry (``files[2].cid: ...``).  The rules are pinned across
language ports by ``vectors/manifests.json``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from .file_id import parse_file_cid

#: Record type this module validates.
MANIFEST_TYPE = "manifest"

#: Body-level key holding the file list.
FILES_FIELD = "files"

#: Fields of one manifest file entry, in canonical order.
FILE_FIELDS: tuple[str, ...] = ("path", "cid", "size", "mediaType", "role")

#: Roles a file may play in a paper bundle.  ``other`` is the catch-all.
FILE_ROLES: frozenset[str] = frozenset(
    {
        "manuscript",    # the main PDF of the version
        "source",        # TeX/Docx/... sources, usually as an archive
        "figure",        # a figure asset
        "table",         # a table asset
        "dataset",       # accompanying data
        "code",          # code or a code archive
        "supplementary", # supplementary information documents
        "bibliography",  # .bib and similar
        "style",         # class, style or template files
        "cover",         # cover letter and correspondence
        "other",         # anything else
    }
)

#: Largest accepted ``size``.  Matches the largest integer every JSON
#: number port (JS ``Number.MAX_SAFE_INTEGER``) represents exactly.
MAX_FILE_SIZE = 2**53 - 1

#: Longest accepted ``path``.
MAX_PATH_LENGTH = 1024

#: Bare lowercase RFC 6838 ``type/subtype``; no parameters, no wildcards.
_MEDIA_TYPE_PATTERN = re.compile(
    r"[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+\-]{0,126}"
)

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    """``repr`` of ``value`` clipped so errors never echo huge input."""
    text = repr(value)
    if len(text) > _SHOW_LIMIT:
        text = text[: _SHOW_LIMIT - 3] + "..."
    return text


def _validate_path(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"{where} field 'path' must be a non-empty string, "
            f"got {_show(value)}"
        )
    if len(value) > MAX_PATH_LENGTH:
        raise ValueError(
            f"{where} field 'path' is {len(value)} characters; at most "
            f"{MAX_PATH_LENGTH} are allowed"
        )
    if "\\" in value:
        raise ValueError(
            f"{where} field 'path' {_show(value)} must use '/' separators, "
            "not backslashes"
        )
    if value.startswith("/"):
        raise ValueError(
            f"{where} field 'path' {_show(value)} must be relative, not "
            "absolute"
        )
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise ValueError(
            f"{where} field 'path' {_show(value)} must not contain control "
            "characters"
        )
    components = value.split("/")
    bad = [c for c in components if c in ("", ".", "..")]
    if bad:
        raise ValueError(
            f"{where} field 'path' {_show(value)} must be a normalized "
            "relative path: no empty, '.' or '..' components"
        )
    return value


def _validate_size(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(
            f"{where} field 'size' must be an integer number of bytes, "
            f"got {_show(value)}"
        )
    if value < 0:
        raise ValueError(
            f"{where} field 'size' must not be negative, got {value}"
        )
    if value > MAX_FILE_SIZE:
        raise ValueError(
            f"{where} field 'size' {value} exceeds the maximum accepted "
            f"file size {MAX_FILE_SIZE}"
        )
    return value


def _validate_media_type(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"{where} field 'mediaType' must be a non-empty string, "
            f"got {_show(value)}"
        )
    if _MEDIA_TYPE_PATTERN.fullmatch(value) is None:
        raise ValueError(
            f"{where} field 'mediaType' {_show(value)} must be a bare "
            "lowercase type/subtype per RFC 6838 (no parameters, no "
            "wildcards, no uppercase)"
        )
    return value


def _validate_role(value: object, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(
            f"{where} field 'role' must be a non-empty string, "
            f"got {_show(value)}"
        )
    if value not in FILE_ROLES:
        known = ", ".join(sorted(FILE_ROLES))
        raise ValueError(
            f"{where} field 'role' {_show(value)} is not one of the known "
            f"file roles: {known}"
        )
    return value


def validate_manifest_entry(
    entry: object, where: str = "file entry"
) -> dict[str, Any]:
    """Validate one manifest file entry; return it in canonical form.

    The entry must be a mapping carrying exactly :data:`FILE_FIELDS` --
    ``path``, ``cid``, ``size``, ``mediaType`` and ``role`` -- each
    satisfying its rule (see the module docstring).  The return value is
    a fresh mapping with the same values under the five fields in
    canonical order; extra keys are rejected, so it never silently drops
    data.

    ``where`` names the entry in error messages (e.g. ``files[2]``).

    Raises:
        ValueError: if the entry is not a mapping, fields are missing or
            unexpected, or any field fails its rule.
    """
    if not isinstance(entry, Mapping):
        raise ValueError(
            f"{where} must be a mapping, got {type(entry).__name__}"
        )
    missing = [field for field in FILE_FIELDS if field not in entry]
    if missing:
        raise ValueError(
            f"{where} is missing required field(s): " + ", ".join(missing)
        )
    unexpected = [key for key in entry if key not in FILE_FIELDS]
    if unexpected:
        raise ValueError(
            f"{where} has unexpected field(s): "
            + ", ".join(repr(key) for key in unexpected)
        )

    canonical: dict[str, Any] = {}
    canonical["path"] = _validate_path(entry["path"], where)
    try:
        parse_file_cid(entry["cid"])
    except ValueError as exc:
        raise ValueError(f"{where} field 'cid': {exc}") from exc
    canonical["cid"] = entry["cid"]  # already the canonical spelling
    canonical["size"] = _validate_size(entry["size"], where)
    canonical["mediaType"] = _validate_media_type(entry["mediaType"], where)
    canonical["role"] = _validate_role(entry["role"], where)
    return canonical


def validate_manifest_body(body: object) -> dict[str, Any]:
    """Validate a ``manifest`` record body; return it in canonical form.

    ``body`` must be a mapping with exactly one key, ``files``: a
    non-empty list of file entries (:func:`validate_manifest_entry`).
    Every ``path`` must be unique.  The return value is a fresh mapping
    ``{"files": [entry, ...]}`` with each entry canonicalized; it equals
    the DAG-CBOR-decoded body a record id was computed over, so callers
    can compare the two to detect tampering.

    Raises:
        ValueError: if the body is not a mapping, ``files`` is missing,
            empty, not a list, an entry is invalid, or a path repeats.
    """
    if not isinstance(body, Mapping):
        raise ValueError(
            f"manifest body must be a mapping, got {type(body).__name__}"
        )
    if FILES_FIELD not in body:
        raise ValueError(
            f"manifest body is missing required field(s): {FILES_FIELD}"
        )
    unexpected = [key for key in body if key != FILES_FIELD]
    if unexpected:
        raise ValueError(
            "manifest body has unexpected field(s): "
            + ", ".join(repr(key) for key in unexpected)
        )

    files = body[FILES_FIELD]
    if isinstance(files, (str, bytes)) or not isinstance(files, (list, tuple)):
        raise ValueError(
            f"manifest field 'files' must be a sequence, "
            f"got {type(files).__name__}"
        )
    if not files:
        raise ValueError(
            "manifest field 'files' must list at least one file"
        )

    seen: dict[str, int] = {}
    canonical_files = []
    for index, entry in enumerate(files):
        where = f"files[{index}]"
        canonical_files.append(validate_manifest_entry(entry, where))
        path = canonical_files[-1]["path"]
        if path in seen:
            raise ValueError(
                f"{where} field 'path' {_show(path)} repeats files[{seen[path]}]"
            )
        seen[path] = index
    return {FILES_FIELD: canonical_files}
