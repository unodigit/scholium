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
    "UNKNOWN_PAPER",
    "VERSION_OUT_OF_SEQUENCE",
    "CategoryNotEndorsed",
    "GenesisRateLimited",
    "InvalidVersionState",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
    "ShortIdCollision",
    "UnknownPaper",
    "UnknownVersion",
    "VersionOutOfSequence",
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

#: A ``paper.version`` does not extend the paper's current version chain.
VERSION_OUT_OF_SEQUENCE = "urn:scholium:problem:version-out-of-sequence"

#: A ``paper.version`` names a paper this node has no ``paper.genesis`` for.
UNKNOWN_PAPER = "urn:scholium:problem:unknown-paper"

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


class VersionOutOfSequence(ProblemException, ValueError):
    """A ``paper.version`` does not extend the paper's version chain: ``409``.

    The chain is linear: version 1's ``prev`` is the paper's genesis cid and
    version *n*'s ``prev`` is version *n-1*'s cid, with ``n`` one more than the
    version ``prev`` names.  A record that points ``prev`` somewhere else --
    an already-superseded version, the genesis after a version exists, a
    version that is not here -- or claims the wrong ``n`` for the version it
    points at would fork the timeline, so it is refused rather than stored.

    The expected and submitted values are carried as extension members
    (``expected_prev``/``expected_n``/``submitted_prev``/``submitted_n``) and
    as one field error per mismatched field, so a client that was editing a
    stale draft can see the version it has to extend.
    """

    def __init__(
        self,
        paper_cid: object,
        *,
        expected_prev: object,
        expected_n: int,
        submitted_prev: object,
        submitted_n: object,
    ) -> None:
        self.paper_cid = paper_cid
        self.expected_prev = expected_prev
        self.expected_n = expected_n
        self.submitted_prev = submitted_prev
        self.submitted_n = submitted_n
        shown_expected = _clip(expected_prev if isinstance(expected_prev, str) else repr(expected_prev))
        shown_submitted = _clip(submitted_prev if isinstance(submitted_prev, str) else repr(submitted_prev))
        message = (
            "This paper.version does not extend the paper's current version "
            f"chain: version {expected_n} with prev {shown_expected!r} was "
            f"expected, but the record is version {submitted_n!r} with prev "
            f"{shown_submitted!r}."
        )
        errors = []
        if submitted_prev != expected_prev:
            errors.append(
                {
                    "loc": ["prev"],
                    "msg": f"The prev must be the current latest version {shown_expected!r}.",
                    "type": "version_out_of_sequence",
                    "input": shown_submitted,
                }
            )
        if submitted_n != expected_n:
            errors.append(
                {
                    "loc": ["body", "n"],
                    "msg": f"The version number must be {expected_n} for this prev.",
                    "type": "version_out_of_sequence",
                    "input": _clip(submitted_n),
                }
            )
        super().__init__(
            409,
            message,
            type=VERSION_OUT_OF_SEQUENCE,
            paper_cid=paper_cid,
            expected_prev=expected_prev,
            expected_n=int(expected_n),
            submitted_prev=submitted_prev,
            submitted_n=submitted_n,
            errors=errors,
        )


class UnknownPaper(ProblemException, LookupError):
    """A ``paper.version`` names a paper this node has no genesis for: ``422``.

    ``body.paper`` must be the cid of an accepted ``paper.genesis`` record; a
    version cannot create the paper it belongs to.  The error names the cid at
    ``body.paper`` so the author can tell it apart from a bad envelope.
    """

    def __init__(self, paper_cid: object) -> None:
        self.paper_cid = paper_cid
        shown = _clip(paper_cid if isinstance(paper_cid, str) else repr(paper_cid))
        message = (
            f"The paper.version names paper {shown!r}, which is not a paper "
            "this node holds a paper.genesis record for."
        )
        super().__init__(
            422,
            message,
            type=UNKNOWN_PAPER,
            errors=[
                {
                    "loc": ["body", "paper"],
                    "msg": message,
                    "type": "unknown_paper",
                    "input": shown,
                }
            ],
        )


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


# --------------------------------------------------------------------------- #
# State transitions (feature 52)
# --------------------------------------------------------------------------- #
#
# These two are not HTTP problems: a state change is made by the node's own
# jobs and by other plugins (consents, moderation, sanitizer), never by a
# client request this plugin serves, so letting one escape a request is a bug.
# They are still ordinary Python exceptions -- ``LookupError`` and
# ``ValueError`` -- so a caller can catch them without FastAPI in the picture.


class UnknownVersion(LookupError):
    """No stored version has this cid, so its state cannot be advanced."""

    def __init__(self, version_cid: object) -> None:
        self.version_cid = version_cid
        shown = _clip(version_cid if isinstance(version_cid, str) else repr(version_cid))
        super().__init__(f"No stored paper version has cid {shown!r}.")


class InvalidVersionState(ValueError):
    """A version cannot be put in the requested state.

    The vocabulary is fixed: the spec's ``awaiting_consent``, ``scanning``,
    ``moderation``, ``listed``, ``held`` and ``rejected``, plus the consent
    plugin's ``draft``.  Anything else would make
    ``paper_versions.state`` unreadable to every feature that switches on it.
    """

    def __init__(self, state: object) -> None:
        self.state = state
        shown = _clip(state if isinstance(state, str) else repr(state))
        super().__init__(
            f"{shown!r} is not a version state: a version may be "
            "awaiting_consent, scanning, moderation, listed, held, rejected "
            "or draft."
        )
