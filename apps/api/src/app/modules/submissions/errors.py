"""Errors raised while accepting a submission (plugin: submissions).

A manifest is only useful if every file it lists is actually here: the paper's
bytes live in the content store, addressed by cid and recorded in ``blobs``.
A manifest entry whose cid has no row, or whose row records a different number
of bytes, can never be served as the author signed it, so the record is refused
with ``422`` problem details naming the offending ``path``.

Both errors are :class:`app.errors.ProblemException`, so letting one escape the
``POST /v1/records`` handler renders ``application/problem+json`` with no extra
wiring.  They are also ordinary Python exceptions (:class:`LookupError` and
:class:`ValueError`) for callers that would rather catch them without FastAPI.
"""

from __future__ import annotations

from typing import Any, Optional

from app.errors import ProblemException

__all__ = [
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
]

#: A manifest file's cid has no row in the ``blobs`` table.
MANIFEST_FILE_NOT_STORED = "urn:scholium:problem:manifest-file-not-stored"

#: A manifest file's declared size disagrees with the size recorded in ``blobs``.
MANIFEST_FILE_SIZE_MISMATCH = "urn:scholium:problem:manifest-file-size-mismatch"


def _field_error(
    path: str,
    index: Optional[int],
    message: str,
    kind: str,
    value: Any,
) -> dict[str, Any]:
    """One field error in the shape FastAPI uses for a bad request body.

    The path is both named in ``msg`` and carried as the entry's ``input`` (the
    offending field is the file entry, so ``loc`` points at it), which keeps a
    client able to say exactly which file is wrong even when several are.
    """
    return {
        "loc": ["body", "files", index] if index is not None else ["body", "files"],
        "msg": message,
        "type": kind,
        "input": path,
    }


class ManifestFileError(ProblemException):
    """A manifest lists a file the content store cannot satisfy: ``422``.

    ``path`` is always named in the human-readable ``detail`` and in the single
    ``errors`` entry, because that is what tells the author which file to fix.
    """

    def __init__(
        self,
        detail: str,
        *,
        type: str,
        path: str,
        index: Optional[int],
        kind: str,
        value: Any,
    ) -> None:
        self.path = path
        super().__init__(
            422,
            detail,
            type=type,
            errors=[_field_error(path, index, detail, kind, value)],
        )


class ManifestFileNotStored(ManifestFileError, LookupError):
    """No ``blobs`` row has the manifest file's cid: ``422`` problem details."""

    def __init__(self, path: str, cid: str, index: Optional[int] = None) -> None:
        self.cid = cid
        message = (
            f"Manifest file {path!r} is not in the content store: "
            f"no blob has cid {cid!r}."
        )
        super().__init__(
            message,
            type=MANIFEST_FILE_NOT_STORED,
            path=path,
            index=index,
            kind="manifest_file_not_stored",
            value=cid,
        )


class ManifestFileSizeMismatch(ManifestFileError, ValueError):
    """The declared size disagrees with ``blobs.size``: ``422`` problem details."""

    def __init__(
        self,
        path: str,
        cid: str,
        declared: int,
        stored: int,
        index: Optional[int] = None,
    ) -> None:
        self.cid = cid
        self.declared = declared
        self.stored = stored
        message = (
            f"Manifest file {path!r} declares {declared} bytes but the stored "
            f"blob for cid {cid!r} is {stored} bytes."
        )
        super().__init__(
            message,
            type=MANIFEST_FILE_SIZE_MISMATCH,
            path=path,
            index=index,
            kind="manifest_file_size_mismatch",
            value=declared,
        )
