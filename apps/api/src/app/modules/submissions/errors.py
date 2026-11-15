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

import math
from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Any, Optional

from app.errors import ProblemException

__all__ = [
    "CATEGORY_NOT_ENDORSED",
    "GENESIS_RATE_LIMITED",
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "SHORT_ID_COLLISION",
    "CategoryNotEndorsed",
    "GenesisRateLimited",
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

#: A young tier-2 author already started a paper inside the weekly window.
GENESIS_RATE_LIMITED = "urn:scholium:problem:genesis-rate-limited"

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


def _iso(value: datetime) -> str:
    """``value`` as an ISO 8601 UTC instant with a ``Z`` suffix, as the API writes dates."""
    moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class GenesisRateLimited(ProblemException):
    """A young tier-2 author already started a paper this week: ``429``.

    ``next_allowed_at`` is the instant the earlier genesis leaves the rolling
    seven-day window, so it is the first moment another ``paper.genesis`` can
    be accepted.  The same instant is echoed as ``next_allowed_date`` (the
    name the spec uses), while ``retry_after`` carries the whole seconds until
    then -- also sent as the ``Retry-After`` header.

    The refusal happens before the ledger append, so the refused record stores
    nothing.
    """

    def __init__(
        self,
        next_allowed_at: datetime,
        *,
        now: Optional[datetime] = None,
        limit: int = 1,
        window_seconds: int = 7 * 24 * 60 * 60,
    ) -> None:
        self.next_allowed_at = next_allowed_at
        self.limit = int(limit)
        self.window_seconds = int(window_seconds)
        moment = now if now is not None else datetime.now(timezone.utc)
        later = (
            next_allowed_at
            if next_allowed_at.tzinfo is not None
            else next_allowed_at.replace(tzinfo=timezone.utc)
        )
        earlier = moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)
        self.retry_after = max(1, math.ceil((later - earlier).total_seconds()))
        shown = _iso(next_allowed_at)
        message = (
            "A tier-2 account younger than 90 days may start one paper per "
            f"week; the next paper.genesis is allowed at {shown}."
        )
        super().__init__(
            429,
            message,
            type=GENESIS_RATE_LIMITED,
            headers={"Retry-After": str(self.retry_after)},
            next_allowed_at=shown,
            next_allowed_date=shown,
            retry_after=self.retry_after,
            limit=self.limit,
            window_seconds=self.window_seconds,
        )
