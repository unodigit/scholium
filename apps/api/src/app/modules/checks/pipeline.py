"""Extract a version's text and run its advisory checks (features 65-68).

The checks library in this package is what computes a version's text,
similarity, references and metadata match, but something has to *call* it.
This module is that trigger: when a version passes the sanitizer and enters
``moderation`` -- or, as a safety net, is ``listed`` without having passed
through it -- the node enqueues one :data:`JOB_KIND` job carrying the
version's cid.  The job, run by :mod:`app.jobs` (inline in tests, on the
worker thread in production)::

    from app.modules import checks

    checks.extract_version_text(version_cid)   # what the job calls

1. resolves the version's manuscript PDF from its signed manifest,
2. saves its text as paragraphs (:func:`~.service.save_version_text`),
3. re-indexes the version's body for full-text search,
4. runs the similarity, reference and metadata-match checks so their columns
   reach the moderation queue and the web submit step.

Every step is idempotent per version: the text is replaced wholesale and each
check rewrites its own column, so a retried or duplicated job changes nothing
that has not changed in the version itself.

The subscription is to the existing ``version.state_changed`` event
(:mod:`app.modules.submissions.events`); the submissions plugin is not
modified.  As with the sanitizer's scan job, registration is repeated before
every enqueue so a test or tool that cleared the process-wide subscriber list
does not silently stop extraction from being scheduled.

Why moderation and not listing
-----------------------------

The text has to exist before the version is listed: listing publishes the
full-text index entry, and the advisory AI pre-review (which quotes one
paragraph block per paragraph) is enqueued when the version becomes
``listed``.  Extracting on entry to ``moderation`` leaves both with text to
work from whatever the order in which their subscribers run.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any, Optional

from app import jobs

from .models import ensure_check_results_table, ensure_table
from .results import save_metadata_match, save_reference_check
from .service import save_version_text
from .similarity import save_similarity_check

__all__ = [
    "JOB_KIND",
    "enqueue_extraction",
    "ensure_subscribed",
    "extract_version_job",
    "extract_version_text",
    "manifest_entries",
    "manuscript_pdf_cid",
]

logger = logging.getLogger(__name__)

#: Job kind registered with :mod:`app.jobs`.
JOB_KIND = "checks.extract_text"

#: The states whose entry means the version's PDF has been cleared for text
#: extraction.  ``moderation`` is the normal trigger; ``listed`` is the safety
#: net for a version that reached the public state by another route.
_TRIGGER_STATES = frozenset({"moderation", "listed"})

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


# --------------------------------------------------------------------------- #
# The manifest
# --------------------------------------------------------------------------- #


def _files_of(body: object) -> Optional[list[Mapping[str, Any]]]:
    """The manifest's file entries in ``body``, or ``None`` when it is not one."""
    if isinstance(body, Mapping):
        files = body.get("files")
    elif isinstance(body, Sequence) and not isinstance(body, (str, bytes, bytearray)):
        files = body
    else:
        return None
    if isinstance(files, (str, bytes, bytearray)) or not isinstance(files, Sequence):
        return None
    entries = [entry for entry in files if isinstance(entry, Mapping)]
    return entries or None


def manifest_entries(version_cid: str) -> list[Mapping[str, Any]]:
    """The version's manifest file entries, from the record log.

    The canonical pointer is ``paper_versions.manifest_cid`` naming a
    ``manifest`` record.  A version record written before the manifest was
    split out may carry it inline (an object or file list) or as another
    record's cid, so those are accepted too.  Returns ``[]`` when nothing
    usable can be found -- the caller decides whether that is a failure.
    """
    from app.modules import ledger

    candidates: list[object] = []
    manifest_cid = None
    try:
        from app.modules import submissions

        row = submissions.get_version(version_cid)
        manifest_cid = getattr(row, "manifest_cid", None) if row is not None else None
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        logger.warning("could not read the version row for %s", _show(version_cid), exc_info=True)

    if isinstance(manifest_cid, str) and manifest_cid:
        entry = ledger.entry_by_cid(manifest_cid)
        if entry is not None:
            candidates.append(getattr(entry, "body", None))

    version_entry = ledger.entry_by_cid(version_cid)
    body = getattr(version_entry, "body", None) if version_entry is not None else None
    if isinstance(body, Mapping):
        manifest = body.get("manifest")
        if manifest is None:
            manifest = body.get("manifest_cid", body.get("manifestCid"))
        candidates.append(manifest)
        candidates.append(body)  # an inline {"files": [...]} body

    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            entry = ledger.entry_by_cid(candidate)
            if entry is not None:
                candidate = getattr(entry, "body", None)
        files = _files_of(candidate)
        if files is not None:
            return files
    return []


def _is_pdf(entry: Mapping[str, Any]) -> bool:
    """Whether a manifest entry names PDF bytes."""
    media_type = entry.get("mediaType", entry.get("media_type"))
    if isinstance(media_type, str):
        essence = media_type.split(";", 1)[0].strip().lower()
        if essence in ("application/pdf", "application/x-pdf"):
            return True
    path = entry.get("path")
    return isinstance(path, str) and path.lower().endswith(".pdf")


def _pick_manuscript(entries: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
    """The entry that is the manuscript PDF (same preference as the checks lib)."""
    for entry in entries:
        if entry.get("role") == "manuscript" and _is_pdf(entry):
            return entry
    for entry in entries:
        if _is_pdf(entry):
            return entry
    for entry in entries:
        if entry.get("role") == "manuscript":
            return entry
    return None


def manuscript_pdf_cid(version_cid: str) -> Optional[str]:
    """The file id of the version's manuscript PDF, or ``None`` when unresolved."""
    entry = _pick_manuscript(manifest_entries(version_cid))
    if entry is None:
        return None
    cid = entry.get("cid")
    return cid if isinstance(cid, str) and cid else None


# --------------------------------------------------------------------------- #
# The work
# --------------------------------------------------------------------------- #


def _run(name: str, check) -> None:
    """Run one advisory check; a failure is logged and must not stop the rest."""
    try:
        check()
    except Exception:
        logger.exception("the %s check failed", name)


def _reindex(version_cid: str) -> None:
    """Refresh the version's full-text row, if the search plugin has an index."""
    try:
        from app.modules import search

        search.sync_version(version_cid)
    except Exception:
        logger.warning(
            "could not refresh the search index for %s", _show(version_cid), exc_info=True
        )


def extract_version_text(version_cid: str) -> bool:
    """Extract ``version_cid``'s text and run its checks; return whether it ran.

    Idempotent per version.  Returns ``False`` (doing nothing) for a version
    this node does not hold or one whose manifest names no manuscript PDF.
    A PDF that cannot be read raises from :func:`~.service.save_version_text`,
    so the job is retried; nothing has been written for the version's text or
    checks in that case.
    """
    if not isinstance(version_cid, str) or not version_cid:
        return False

    from app.modules import submissions

    try:
        row = submissions.get_version(version_cid)
    except Exception:  # pragma: no cover - a damaged table is not a normal path
        logger.warning("could not read the version row for %s", _show(version_cid), exc_info=True)
        return False
    if row is None:
        logger.warning("no version %s to extract text from", _show(version_cid))
        return False

    pdf_cid = manuscript_pdf_cid(version_cid)
    if pdf_cid is None:
        logger.warning(
            "version %s has no manuscript PDF in its manifest; no text extracted",
            _show(version_cid),
        )
        return False

    ensure_table()
    ensure_check_results_table()
    save_version_text(version_cid, pdf_cid)
    _reindex(version_cid)

    _run("similarity", lambda: save_similarity_check(version_cid))
    _run("reference", lambda: save_reference_check(version_cid))
    title = getattr(row, "title", None)
    if isinstance(title, str) and title.strip():
        _run("metadata", lambda: save_metadata_match(version_cid, title, pdf_cid=pdf_cid))
    return True


def extract_version_job(payload: Any) -> None:
    """Job handler: extract the version named in ``payload``.

    ``payload`` is ``{"version_cid": ...}`` (``version``, ``versionCid`` and
    ``id`` are accepted as aliases).  An empty payload does nothing; there is
    no sweep, because the subscription covers every new transition.
    """
    payload = payload if isinstance(payload, Mapping) else {}
    version_cid = (
        payload.get("version_cid")
        or payload.get("versionCid")
        or payload.get("version")
        or payload.get("id")
    )
    if isinstance(version_cid, str) and version_cid:
        extract_version_text(version_cid)


def enqueue_extraction(version_cid: str) -> int:
    """Schedule text extraction for ``version_cid``; return the job id.

    Raises:
        ValueError: if ``version_cid`` is not a non-empty string.
    """
    if not isinstance(version_cid, str) or not version_cid:
        raise ValueError("a non-empty version_cid is required")
    ensure_subscribed()
    return jobs.enqueue(JOB_KIND, {"version_cid": version_cid})


# --------------------------------------------------------------------------- #
# The trigger
# --------------------------------------------------------------------------- #


def _on_version_state_changed(event: Any) -> None:
    """Schedule extraction when a version reaches moderation (or is listed)."""
    state = getattr(event, "state", None)
    if state is None:
        state = getattr(event, "to_state", None)
    if state not in _TRIGGER_STATES:
        return
    version_cid = getattr(event, "version_cid", None)
    if not isinstance(version_cid, str) or not version_cid:
        return
    if state == "listed":
        # The normal path already extracted on entry to moderation; listing is
        # only a safety net for a version that arrived there another way, so do
        # not re-read a PDF that has text.
        from .service import get_version_text

        try:
            if get_version_text(version_cid):
                return
        except Exception:  # pragma: no cover - a damaged table is not a normal path
            logger.warning(
                "could not tell whether %s has text yet", _show(version_cid), exc_info=True
            )
    try:
        enqueue_extraction(version_cid)
    except Exception:  # noqa: BLE001 - a broken job must not break the transition
        logger.exception("could not enqueue text extraction for %s", _show(version_cid))


def ensure_subscribed() -> None:
    """Make sure this module hears about versions entering ``moderation``.

    Registration is idempotent and is repeated before every enqueue, so a
    cleared subscriber registry cannot silently stop extraction.
    """
    from app.modules.submissions import subscribe_version_state_changed

    subscribe_version_state_changed(_on_version_state_changed)


# Register at import time so ``jobs.enqueue`` accepts the kind and a version
# entering moderation schedules its extraction without further wiring.
jobs.register(JOB_KIND, extract_version_job)
try:
    ensure_subscribed()
except Exception:  # pragma: no cover - submissions is importable on every normal path
    logger.exception("could not subscribe the text-extraction trigger")
