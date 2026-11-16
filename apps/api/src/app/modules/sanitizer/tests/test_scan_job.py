"""Tests for the per-version background scan (feature 63).

A version in ``scanning`` state has every file of its signed manifest
scanned, each blob's ``scan_status`` saved, and is then moved to
``moderation`` (clean) or held with the exact failing check.

Isolation: every test stores its own random bytes (so its own cids) and
creates its own version and manifest, because xdist workers share a database
and a content directory.  The sanitizer's ``version.state_changed``
subscription is (re)established before each test: the submissions tests clear
the process-wide subscriber list.
"""

from __future__ import annotations

import io
import uuid
import zipfile
from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject
from scholium_record_core import did_key_from_signing_key, sign_record

from app import jobs
from app.modules import content, ledger, sanitizer
from app.modules.sanitizer import (
    CHECK_FILE_MISSING,
    CHECK_MANIFEST_UNREADABLE,
    CHECK_PATH_TRAVERSAL,
    JOB_KIND,
    RESULT_FAILED,
    RESULT_PASSED,
)
from app.modules.submissions import (
    AWAITING_CONSENT,
    HELD,
    MODERATION,
    SCANNING,
    clear_state_changed_subscribers,
    get_version,
    save_version,
    subscribe_version_state_changed,
    transition_version,
)

MANUSCRIPT = "application/pdf"
BUNDLE = "application/zip"
PLAIN = "text/plain"


# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def subscribed():
    """The scans are normally started by the state-change subscription."""
    sanitizer.ensure_subscribed()
    yield


@pytest.fixture
def suspended(subscribed):
    """Create versions in ``scanning`` without the scan starting immediately."""
    clear_state_changed_subscribers()
    yield
    sanitizer.ensure_subscribed()


@pytest.fixture
def files_not_scanned_early(subscribed):
    """Record manifests without their files being scanned (see ``test_scan_ahead``).

    A recorded manifest normally scans the files it names at once.  A test of
    what the *version* scan does on its own removes that subscription first.
    """
    from app.modules.sanitizer import scan_job

    ledger.unsubscribe("manifest", scan_job._on_manifest_recorded)
    ledger.unsubscribe("paper.version", scan_job._on_manifest_recorded)
    yield
    sanitizer.ensure_subscribed()


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata({"/Title": f"clean-{uuid.uuid4().hex}"})
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def javascript_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_metadata({"/Title": f"evil-{uuid.uuid4().hex}"})
    writer._root_object[NameObject("/OpenAction")] = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('pwned')"),
        }
    )
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def traversal_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../escape.txt", "outside the extraction root")
    return buffer.getvalue()


def stored(data: bytes, media_type: str):
    """Store bytes and return the ``blobs`` row (status starts ``scanning``)."""
    return content.store_bytes(data, media_type=media_type)


def entry(blob, path: str, media_type: str, role: str = "manuscript") -> dict:
    return {
        "path": path,
        "cid": blob.cid,
        "size": blob.size,
        "mediaType": media_type,
        "role": role,
    }


def add_manifest(entries: list[dict]) -> str:
    """Append a signed manifest record and return its cid."""
    seed = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "manifest",
            "author": did_key_from_signing_key(seed),
            "created": now(),
            "prev": None,
            "body": {"files": entries},
            "proofs": [],
        },
        seed,
    )
    ledger.append(record)
    return record["id"]


def make_version(
    entries: list[dict],
    *,
    state: str = AWAITING_CONSENT,
    manifest_cid: str | None = None,
) -> str:
    """Save a version for ``entries`` and return its cid."""
    manifest = add_manifest(entries) if manifest_cid is None else manifest_cid
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=f"bafyreipaper{uuid.uuid4().hex}",
        n=1,
        title="A version that is scanned",
        abstract="",
        manifest_cid=manifest,
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
    )
    return version_cid


def state_of(version_cid: str) -> str:
    row = get_version(version_cid)
    assert row is not None
    return row.state


def status_of(cid: str) -> str:
    blob = content.get_blob(cid)
    assert blob is not None
    return blob.scan_status


# --------------------------------------------------------------------------- #
# A clean version
# --------------------------------------------------------------------------- #


def test_a_clean_version_passes_every_file_and_moves_to_moderation():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    notes = stored(b"supporting notes", PLAIN)
    version_cid = make_version(
        [entry(pdf, "paper.pdf", MANUSCRIPT), entry(notes, "notes.txt", PLAIN, "supplement")]
    )

    transition_version(version_cid, SCANNING, reason="all authors consented")

    assert status_of(pdf.cid) == RESULT_PASSED
    assert status_of(notes.cid) == RESULT_PASSED
    assert state_of(version_cid) == MODERATION
    # A clean scan writes no failed reports.
    assert sanitizer.reports_for(pdf.cid) == []
    assert sanitizer.reports_for(notes.cid) == []


def test_scan_version_returns_one_result_per_file(suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    result = sanitizer.scan_version(version_cid)

    assert result.version_cid == version_cid
    assert result.skipped is False
    assert result.passed is True
    assert result.failed is False
    assert result.state == MODERATION
    assert result.failing_check is None
    assert [file.cid for file in result.files] == [pdf.cid]
    assert result.files[0].passed is True
    assert result.files[0].path == "paper.pdf"


# --------------------------------------------------------------------------- #
# A version with a failing file
# --------------------------------------------------------------------------- #


def test_a_failing_check_holds_the_version_with_that_exact_check():
    clean = stored(clean_pdf(), MANUSCRIPT)
    evil = stored(javascript_pdf(), MANUSCRIPT)
    version_cid = make_version(
        [entry(clean, "paper.pdf", MANUSCRIPT), entry(evil, "appendix.pdf", MANUSCRIPT)]
    )

    events = []
    subscribe_version_state_changed(events.append)

    transition_version(version_cid, SCANNING, reason="all authors consented")

    assert state_of(version_cid) == HELD
    # Clean files still get their verdict; the failing one is marked failed.
    assert status_of(clean.cid) == RESULT_PASSED
    assert status_of(evil.cid) == RESULT_FAILED
    reports = sanitizer.reports_for(evil.cid)
    assert ("javascript", RESULT_FAILED) in [
        (report.check_name, report.result) for report in reports
    ]

    held = next(event for event in events if event.state == HELD)
    assert held.version_cid == version_cid
    assert held.reason == "scan failed: javascript"
    assert held.previous_state == SCANNING


def test_every_file_is_scanned_not_only_the_manuscript(suspended):
    clean = stored(clean_pdf(), MANUSCRIPT)
    bundle = stored(traversal_zip(), BUNDLE)
    evil = stored(javascript_pdf(), MANUSCRIPT)
    version_cid = make_version(
        [
            entry(clean, "paper.pdf", MANUSCRIPT),
            # A non-manuscript bundle and an appendix must be scanned too.
            entry(bundle, "source.zip", BUNDLE, "source"),
            entry(evil, "appendix.pdf", MANUSCRIPT, "supplement"),
        ],
        state=SCANNING,
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert status_of(clean.cid) == RESULT_PASSED
    assert status_of(bundle.cid) == RESULT_FAILED
    assert status_of(evil.cid) == RESULT_FAILED

    assert [(report.check_name, report.result) for report in sanitizer.reports_for(bundle.cid)] == [
        (CHECK_PATH_TRAVERSAL, RESULT_FAILED)
    ]
    assert ("javascript", RESULT_FAILED) in [
        (report.check_name, report.result)
        for report in sanitizer.reports_for(evil.cid)
    ]

    # The first failing file in manifest order names the held check.
    assert result.failing_check == CHECK_PATH_TRAVERSAL
    assert result.failing_cid == bundle.cid
    assert result.failing_path == "source.zip"


# --------------------------------------------------------------------------- #
# The background job
# --------------------------------------------------------------------------- #


def test_the_job_is_registered_and_scanning_runs_through_it(suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    job_id = sanitizer.enqueue_scan(version_cid)

    assert isinstance(job_id, int)
    assert JOB_KIND == "sanitizer.scan_version"
    assert state_of(version_cid) == MODERATION
    assert status_of(pdf.cid) == RESULT_PASSED


def test_an_empty_job_payload_sweeps_every_scanning_version(suspended):
    first_pdf = stored(clean_pdf(), MANUSCRIPT)
    first = make_version([entry(first_pdf, "one.pdf", MANUSCRIPT)], state=SCANNING)
    second_pdf = stored(clean_pdf(), MANUSCRIPT)
    second = make_version([entry(second_pdf, "two.pdf", MANUSCRIPT)], state=SCANNING)

    sanitizer.scan_version_job({})

    assert first not in sanitizer.versions_in_scanning_state()
    assert second not in sanitizer.versions_in_scanning_state()
    assert state_of(first) == MODERATION
    assert state_of(second) == MODERATION


def test_jobs_enqueue_accepts_the_kind(suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    jobs.enqueue(JOB_KIND, {"version_cid": version_cid})

    assert state_of(version_cid) == MODERATION


# --------------------------------------------------------------------------- #
# Only versions in scanning state are moved, and re-runs are no-ops
# --------------------------------------------------------------------------- #


def test_a_version_not_in_scanning_state_is_left_alone(files_not_scanned_early):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)])

    result = sanitizer.scan_version(version_cid)

    assert result.skipped is True
    assert result.state == AWAITING_CONSENT
    assert status_of(pdf.cid) == content.SCAN_SCANNING
    assert state_of(version_cid) == AWAITING_CONSENT


def test_scanning_an_already_scanned_version_changes_nothing():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)])
    transition_version(version_cid, SCANNING)
    assert state_of(version_cid) == MODERATION

    again = sanitizer.scan_version(version_cid)

    assert again.skipped is True
    assert again.state == MODERATION
    assert status_of(pdf.cid) == RESULT_PASSED
    assert state_of(version_cid) == MODERATION


# --------------------------------------------------------------------------- #
# Unscannable input is held, never passed
# --------------------------------------------------------------------------- #


def test_a_missing_manifest_holds_the_version(suspended):
    # The event trigger leaves a version whose manifest is unreadable in
    # scanning; an explicit scan is what holds it.
    version_cid = make_version(
        [], manifest_cid=f"bafyreimissing{uuid.uuid4().hex}", state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert state_of(version_cid) == HELD


def test_a_missing_manifest_names_the_check_in_the_held_reason(suspended):
    version_cid = make_version(
        [], manifest_cid=f"bafyreimissing{uuid.uuid4().hex}", state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.failing_check == CHECK_MANIFEST_UNREADABLE
    assert result.reason is not None
    assert result.reason.startswith(f"scan failed: {CHECK_MANIFEST_UNREADABLE}")


def test_an_unreadable_manifest_does_not_stop_the_event_trigger():
    """A version whose manifest has not arrived stays scanning, unheld."""
    version_cid = make_version([], manifest_cid=f"bafyreimissing{uuid.uuid4().hex}")

    transition_version(version_cid, SCANNING)

    assert state_of(version_cid) == SCANNING


def test_missing_file_bytes_are_held_as_file_missing(suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)
    # Remove the bytes but keep the blobs row, as a damaged store would.
    content.blob_path(pdf.cid).unlink()

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert result.failing_check == CHECK_FILE_MISSING
    assert status_of(pdf.cid) == RESULT_FAILED
    assert [(report.check_name, report.result) for report in sanitizer.reports_for(pdf.cid)] == [
        (CHECK_FILE_MISSING, RESULT_FAILED)
    ]


def test_a_listed_file_with_no_blob_row_is_held():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    # A manifest entry for bytes this node never stored: the version cannot
    # be cleared, so it is held naming the missing file.
    ghost = {
        "path": "ghost.pdf",
        "cid": "bafkrei" + "a" * 52,
        "size": 1,
        "mediaType": MANUSCRIPT,
        "role": "supplement",
    }
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT), ghost])
    events = []
    subscribe_version_state_changed(events.append)

    transition_version(version_cid, SCANNING)

    assert state_of(version_cid) == HELD
    held = next(event for event in events if event.state == HELD)
    assert held.reason == f"scan failed: {CHECK_FILE_MISSING}"
