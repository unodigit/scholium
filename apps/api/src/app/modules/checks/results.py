"""Writing and reading a version's row in ``check_results`` (features 67, 68).

The automated checks each own their columns of a version's row, so they can
run in any order and in any combination::

    from app.modules import checks

    checks.save_metadata_match(version_cid, signed_title, first_page_text)
    checks.save_metadata_match(version_cid, signed_title, pdf_cid=pdf_cid)   # from a PDF
    checks.save_metadata_match(version_cid)   # title + manuscript from the signed record
    checks.get_check_result(version_cid).metadata_match

    checks.save_reference_check(version_cid)  # from the text saved in version_texts
    checks.get_check_result(version_cid).references_total
    checks.get_check_result(version_cid).references_unresolved

``save_reference_check`` is the feature-67 entry point: it extracts the
reference list from the version's saved text (see
:mod:`app.modules.checks.references`) and saves ``references_total`` and
``references_unresolved``.  A reference is *unresolved* unless Crossref
confirms its DOI, and Crossref is asked (see :mod:`app.modules.checks.crossref`)
only when ``CROSSREF_ENABLED=1``.  Without the flag nothing leaves the
process, nothing is confirmed, and so ``references_unresolved`` equals
``references_total``: it means "none resolved", and is how a consumer of the
row sees that resolution was not run.  Both columns are written in one
transaction, so they always describe the same run.

``save_metadata_match`` is the feature-68 entry point: it compares the signed
title with the first page text (see :mod:`app.modules.checks.metadata`), saves
the verdict as ``metadata_match`` and returns it.  Writing twice replaces the
previous verdict; it never inserts a second row and never clears the columns
owned by the similarity and reference checks.

Where the inputs come from:

* ``signed_title`` is normally passed by the submission pipeline, which has
  the verified signed ``paper.version`` record in hand.  When omitted, the
  title is read from that record in the event log -- the same signed bytes
  the rest of the system verifies.
* ``first_page_text`` can be passed directly, or the check can extract the
  first page from a PDF.  The PDF is ``pdf_cid`` when given, otherwise the
  manuscript listed in the signed record's manifest.  Reading only page one
  keeps a title quoted in the body of a later page from counting.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from sqlalchemy.exc import IntegrityError

from app import db

from .crossref import crossref_enabled, resolve_dois
from .errors import MetadataMatchError
from .extract import extract_first_page_text
from .metadata import metadata_match as _metadata_match
from .models import CheckResult, ensure_check_results_table
from .references import Reference, extract_references
from .service import _check_version_cid, get_version_text, open_seekable_pdf

__all__ = [
    "ReferenceCheck",
    "get_check_result",
    "save_check_result",
    "save_metadata_match",
    "save_reference_check",
]

#: Distinguishes "leave this column alone" from an explicit ``None`` (NULL)
#: in :func:`save_check_result`.
_UNSET = object()

# Two writers racing on a new version's row can both insert; the loser's
# retry sees the winner's row and updates it, as in the version-text writer.
_ATTEMPTS = 2

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def save_check_result(
    version_cid: str,
    *,
    similarity_pct: Any = _UNSET,
    references_total: Any = _UNSET,
    references_unresolved: Any = _UNSET,
    metadata_match: Any = _UNSET,
) -> CheckResult:
    """Insert or update ``version_cid``'s row, setting only the given columns.

    Columns not named are left as they are, so each check can call this with
    just its own verdict.  Passing an explicit ``None`` stores SQL ``NULL``.

    Args:
        version_cid: the version's record cid (canonical base32).
        similarity_pct: percentage (0-100) over the whole document.
        references_total: number of references found in the text.
        references_unresolved: how many of them could not be resolved.
        metadata_match: whether the signed title appears on page one.

    Returns:
        The saved row, detached from any session.

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        TypeError: if a value has the wrong type (nothing is written).
        ValueError: if a count or percentage is out of range.
    """
    version_cid = _check_version_cid(version_cid)

    values: dict[str, object] = {}
    if similarity_pct is not _UNSET:
        values["similarity_pct"] = _percentage(similarity_pct)
    if references_total is not _UNSET:
        values["references_total"] = _count(references_total, "references_total")
    if references_unresolved is not _UNSET:
        values["references_unresolved"] = _count(
            references_unresolved, "references_unresolved"
        )
    if metadata_match is not _UNSET:
        values["metadata_match"] = _boolean(metadata_match)

    ensure_check_results_table()
    for attempt in range(_ATTEMPTS):
        try:
            with db.SessionLocal() as session:
                session.expire_on_commit = False
                row = session.get(CheckResult, version_cid)
                if row is None:
                    row = CheckResult(version_cid=version_cid)
                    session.add(row)
                for name, value in values.items():
                    setattr(row, name, value)
                session.commit()
                session.expunge(row)
                return row
        except IntegrityError:
            if attempt == _ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable")  # pragma: no cover


def get_check_result(version_cid: str) -> Optional[CheckResult]:
    """``version_cid``'s saved check row, or ``None`` when no check has run.

    A ``version_cid`` that is not a string has no row, so it also gives
    ``None``; a malformed string is not an error here (reading is forgiving,
    like :func:`~app.modules.checks.get_version_text`).
    """
    if not isinstance(version_cid, str):
        return None
    ensure_check_results_table()
    with db.SessionLocal() as session:
        session.expire_on_commit = False
        row = session.get(CheckResult, version_cid)
        if row is not None:
            session.expunge(row)
        return row


# --------------------------------------------------------------------------- #
# Metadata match (feature 68)
# --------------------------------------------------------------------------- #


def save_metadata_match(
    version_cid: str,
    title: Optional[str] = None,
    first_page_text: Optional[str] = None,
    *,
    pdf_cid: Optional[str] = None,
    signed_title: Optional[str] = None,
) -> bool:
    """Save whether the signed title appears in the first page text.

    The comparison itself is :func:`app.modules.checks.metadata.metadata_match`.
    The result is written to ``check_results.metadata_match`` and returned.

    Args:
        version_cid: the version's record cid (canonical base32).
        title: the title from the signed ``paper.version`` record.  When
            ``None``, it is read from the record in the event log.
        first_page_text: the text of the PDF's first page.  When ``None``,
            :func:`~app.modules.checks.extract.extract_first_page_text`
            reads it from the PDF named by ``pdf_cid`` or, when that is also
            omitted, by the manuscript entry in the signed record's manifest.
        pdf_cid: the version's PDF file id in the content store, used when
            ``first_page_text`` is not supplied.
        signed_title: alias for ``title``, naming the value's provenance.

    Returns:
        ``True`` when the title appears on page one, ``False`` otherwise
        (including a title that is absent, or a page with no text layer).

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        MetadataMatchError: if the title or first page text is not supplied
            and cannot be recovered from the signed record.
        content.BlobNotFound: if the PDF is not in the content store.
        PdfTextError: if the PDF cannot be read.
    """
    version_cid = _check_version_cid(version_cid)

    if title is not None and signed_title is not None and title != signed_title:
        raise TypeError("pass either title or signed_title, not both")
    if title is None:
        title = signed_title
    if title is None:
        title = _signed_title(version_cid)
    if not isinstance(title, str):
        raise TypeError(
            f"signed title must be a string, got {type(title).__name__}"
        )

    text = first_page_text
    if text is None:
        text = _first_page_text(version_cid, pdf_cid)
    if not isinstance(text, str):
        raise TypeError(
            f"first page text must be a string, got {type(text).__name__}"
        )

    matched = _metadata_match(title, text)
    save_check_result(version_cid, metadata_match=matched)
    return matched


def _first_page_text(version_cid: str, pdf_cid: Optional[str]) -> str:
    """Extract page one of ``pdf_cid`` or of the version's manuscript PDF."""
    from app.modules import content  # local: keeps the check library importable alone

    cid = pdf_cid if pdf_cid is not None else _manuscript_cid(version_cid)
    if content.get_blob(cid) is None:
        raise content.BlobNotFound(f"no blob with cid {_show(cid)}")
    with open_seekable_pdf(cid) as pdf:
        return extract_first_page_text(pdf)


# --------------------------------------------------------------------------- #
# References (feature 67)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ReferenceCheck:
    """What :func:`save_reference_check` saved."""

    #: Entries in the reference list (``check_results.references_total``).
    total: int
    #: Entries not confirmed by Crossref (``check_results.references_unresolved``):
    #: those with no DOI, those whose DOI Crossref does not know, and -- when
    #: ``CROSSREF_ENABLED`` is not ``1`` and nothing is looked up -- all of them.
    unresolved: int


def save_reference_check(
    version_cid: str, *, client: Optional[httpx.Client] = None
) -> ReferenceCheck:
    """Extract ``version_cid``'s references and save the reference counts.

    Reads the paragraphs saved for the version (:func:`~.save_version_text`
    must have run), extracts the reference list from them and writes
    ``references_total`` -- and ``references_unresolved`` too, in the same
    transaction -- to ``check_results``.  Writing again replaces both; the
    other checks' columns are left alone.

    A reference is *unresolved* unless Crossref confirms its DOI: it has no
    DOI, or Crossref does not know the DOI, or Crossref was not asked.
    Crossref is asked only when the environment has ``CROSSREF_ENABLED=1``;
    otherwise no request is made and every reference counts as unresolved
    (see the module docstring).  A version with no saved text, or text with
    no reference list, has 0 references and 0 unresolved.

    Args:
        version_cid: the version's record cid (canonical base32).
        client: an ``httpx.Client`` for the Crossref requests (tests, or an
            operator's own ``User-Agent``).  Ignored unless the flag is on:
            passing a client does not enable the network.

    Returns:
        The saved counts.

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        CrossrefError: if Crossref is enabled but cannot answer for some DOI.
            Nothing is saved, so the previous row (if any) stands and the
            check can simply be run again.
    """
    version_cid = _check_version_cid(version_cid)
    references = extract_references(get_version_text(version_cid))

    unresolved = _count_unresolved(references, client)

    save_check_result(
        version_cid,
        references_total=len(references),
        references_unresolved=unresolved,
    )
    return ReferenceCheck(total=len(references), unresolved=unresolved)


def _count_unresolved(
    references: Sequence[Reference], client: Optional[httpx.Client]
) -> int:
    """How many of ``references`` Crossref does not confirm.

    With ``CROSSREF_ENABLED`` off nothing is looked up, so none is confirmed.
    """
    resolved: dict[str, bool] = {}
    if crossref_enabled():
        resolved = resolve_dois((ref.doi for ref in references if ref.doi), client=client)
    return sum(1 for ref in references if ref.doi is None or not resolved.get(ref.doi, False))


# --------------------------------------------------------------------------- #
# Reading the signed record
# --------------------------------------------------------------------------- #


def _signed_body(version_cid: str) -> Mapping[str, Any]:
    """The body of ``version_cid``'s signed record in the event log."""
    from app.modules import ledger  # local: the checks library does not require it

    entry = ledger.entry_by_cid(version_cid)
    body = getattr(entry, "body", None) if entry is not None else None
    if not isinstance(body, Mapping):
        raise MetadataMatchError(
            f"no signed record with body metadata for version {_show(version_cid)}"
        )
    return body


def _signed_title(version_cid: str) -> str:
    """The ``title`` from ``version_cid``'s signed record."""
    title = _signed_body(version_cid).get("title")
    if not isinstance(title, str) or not title.strip():
        raise MetadataMatchError(
            f"the signed record for version {_show(version_cid)} has no title"
        )
    return title


def _manuscript_cid(version_cid: str) -> str:
    """The file id of the version's manuscript PDF, from its signed record.

    The record's ``manifest`` may be the manifest body itself (``{"files":
    [...]}``), its file list, or a cid referring to a separate ``manifest``
    record.  The manuscript is the entry with ``role: "manuscript"`` and a
    PDF media type; failing that, any PDF entry, then any manuscript entry.
    """
    body = _signed_body(version_cid)
    manifest = body.get("manifest")
    if manifest is None:
        manifest = body.get("manifest_cid", body.get("manifestCid"))
    if manifest is None and "files" in body:
        manifest = body

    files = _manifest_files(manifest)
    entry = _pick_manuscript(files)
    cid = entry.get("cid")
    if not isinstance(cid, str) or not cid:
        raise MetadataMatchError(
            f"the manuscript entry for version {_show(version_cid)} has no cid"
        )
    return cid


def _manifest_files(manifest: object) -> Sequence[Any]:
    """The ``files`` list of a manifest body, file list or manifest cid."""
    if isinstance(manifest, Mapping):
        files = manifest.get("files")
    elif isinstance(manifest, str):
        from app.modules import ledger

        entry = ledger.entry_by_cid(manifest)
        body = getattr(entry, "body", None) if entry is not None else None
        files = body.get("files") if isinstance(body, Mapping) else None
    else:
        files = manifest
    if isinstance(files, (str, bytes)) or not isinstance(files, Sequence):
        raise MetadataMatchError("the signed record's manifest lists no files")
    return files


def _pick_manuscript(files: Sequence[Any]) -> Mapping[str, Any]:
    """The manifest entry that is the manuscript PDF."""
    entries = [entry for entry in files if isinstance(entry, Mapping)]
    for entry in entries:
        if entry.get("role") == "manuscript" and _is_pdf(entry):
            return entry
    for entry in entries:
        if _is_pdf(entry):
            return entry
    for entry in entries:
        if entry.get("role") == "manuscript":
            return entry
    raise MetadataMatchError("the signed record's manifest lists no manuscript PDF")


def _is_pdf(entry: Mapping[str, Any]) -> bool:
    media_type = entry.get("mediaType")
    return isinstance(media_type, str) and media_type.lower() == "application/pdf"


# --------------------------------------------------------------------------- #
# Value validation
# --------------------------------------------------------------------------- #


def _percentage(value: object) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(
            f"similarity_pct must be a number or None, got {type(value).__name__}"
        )
    if not 0 <= value <= 100:
        raise ValueError(f"similarity_pct must be between 0 and 100, got {value}")
    return float(value)


def _count(value: object, field: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer or None, got {type(value).__name__}")
    if value < 0:
        raise ValueError(f"{field} must not be negative, got {value}")
    return value


def _boolean(value: object) -> Optional[bool]:
    if value is None or isinstance(value, bool):
        return value
    raise TypeError(f"metadata_match must be a boolean or None, got {type(value).__name__}")
