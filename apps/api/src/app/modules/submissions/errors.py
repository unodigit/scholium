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

from collections.abc import Sequence
from typing import Any, Optional

from app.errors import ProblemException

__all__ = [
    "CATEGORY_NOT_ENDORSED",
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "SHORT_ID_COLLISION",
    "CategoryNotEndorsed",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
    "ShortIdCollision",
]

#: A manifest file's cid has no row in the ``blobs`` table.
MANIFEST_FILE_NOT_STORED = "urn:scholium:problem:manifest-file-not-stored"

#: A manifest file's declared size disagrees with the size recorded in ``blobs``.
MANIFEST_FILE_SIZE_MISMATCH = "urn:scholium:problem:manifest-file-size-mismatch"

#: A ``paper.genesis`` names a category its author holds no active endorsement in.
CATEGORY_NOT_ENDORSED = "urn:scholium:problem:category-not-endorsed"

#: A genesis's derived ``sch:`` id is already assigned to a different paper.
SHORT_ID_COLLISION = "urn:scholium:problem:short-id-collision"

_MAX_ECHO = 64


def _clip(value: Any) -> Any:
    """Echo a client-supplied string clipped, so a huge one cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


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


class CategoryNotEndorsed(ProblemException, PermissionError):
    """A ``paper.genesis`` lists a category its author is not endorsed in: ``403``.

    Submission rights come from endorsements, one category at a time, and a
    genesis is accepted only when its author holds an active endorsement in
    *every* category it names.  ``unendorsed_categories`` lists the ones they do
    not (in the order the record names them) -- in the human-readable ``detail``,
    as an extension member of the problem document, and as one ``errors`` entry
    per category located at ``body.categories[i]``, so the author knows exactly
    which to drop or get endorsed for.

    It is also a ``PermissionError`` for callers that would rather catch it in
    plain Python.
    """

    def __init__(
        self,
        author: object,
        categories: Sequence[str],
        unendorsed: Sequence[tuple[int, str]],
    ) -> None:
        self.author = author
        self.categories = list(categories)
        self.unendorsed_categories = [category for _, category in unendorsed]
        shown_author = _clip(author if isinstance(author, str) else repr(author))
        names = ", ".join(repr(_clip(category)) for category in self.unendorsed_categories)
        noun = "category" if len(self.unendorsed_categories) == 1 else "categories"
        message = (
            "A paper.genesis record needs an active endorsement in every category "
            f"it lists; its author {shown_author} has none in {noun} {names}."
        )
        super().__init__(
            403,
            message,
            type=CATEGORY_NOT_ENDORSED,
            unendorsed_categories=[_clip(category) for category in self.unendorsed_categories],
            errors=[
                {
                    "loc": ["body", "categories", index],
                    "msg": f"The author is not endorsed in category {_clip(category)!r}.",
                    "type": "category_not_endorsed",
                    "input": _clip(category),
                }
                for index, category in unendorsed
            ],
        )


class ShortIdCollision(ProblemException, ValueError):
    """The ``sch:`` id derived for a genesis belongs to another paper: ``409``.

    A short id carries 50 bits of the genesis cid, so two different geneses
    sharing one is vanishingly unlikely -- but ``papers.short_id`` is UNIQUE and
    the id is derived rather than chosen, so the new paper cannot be given
    another.  The record is refused and nothing is stored, rather than the
    request failing with a database error.
    """

    def __init__(self, short_id: str, paper_cid: object = None) -> None:
        self.short_id = short_id
        self.paper_cid = paper_cid
        message = (
            f"The short id {short_id} derived for this paper is already assigned "
            "to a different paper."
        )
        super().__init__(409, message, type=SHORT_ID_COLLISION, short_id=short_id)
