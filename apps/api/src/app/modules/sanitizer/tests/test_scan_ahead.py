"""Files are scanned when a manifest names them, not only with their version.

A version that lists a co-author waits in ``awaiting_consent`` until every
co-author has consented, and only then enters ``scanning``.  A file is not
served until its blob is ``passed``, so scanning files only with their version
meant the co-author asked to approve a PDF got ``423`` for it.  Recording a
manifest now scans the files it names; the version's state machine is
untouched (see the end-to-end test in ``content/tests``).
"""

from __future__ import annotations

import uuid

import pytest
from scholium_record_core import compute_file_id

from app import jobs
from app.modules import content, ledger, sanitizer
from app.modules.sanitizer import FILE_JOB_KIND, scan_job
from app.modules.submissions import AWAITING_CONSENT, HELD, MODERATION, SCANNING, transition_version

from .test_scan_job import (
    MANUSCRIPT,
    PLAIN,
    add_manifest,
    clean_pdf,
    entry,
    javascript_pdf,
    make_version,
    state_of,
    status_of,
    stored,
)


@pytest.fixture(autouse=True)
def subscribed():
    """The scans are started by the ledger subscription; other suites clear it."""
    sanitizer.ensure_subscribed()
    yield


@pytest.fixture
def files_not_scanned_early(subscribed):
    ledger.unsubscribe("manifest", scan_job._on_manifest_recorded)
    ledger.unsubscribe("paper.version", scan_job._on_manifest_recorded)
    yield
    sanitizer.ensure_subscribed()


def test_recording_a_manifest_scans_the_files_it_names():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    notes = stored(b"supporting notes " + uuid.uuid4().hex.encode(), PLAIN)
    assert status_of(pdf.cid) == content.SCAN_SCANNING

    version_cid = make_version(
        [entry(pdf, "paper.pdf", MANUSCRIPT), entry(notes, "notes.txt", PLAIN, "supplement")]
    )

    assert status_of(pdf.cid) == content.SCAN_PASSED
    assert status_of(notes.cid) == content.SCAN_PASSED
    # The version itself has not moved: it still waits for its co-authors.
    assert state_of(version_cid) == AWAITING_CONSENT


def test_a_failing_file_is_failed_and_reported_when_its_manifest_is_recorded():
    bad = stored(javascript_pdf(), MANUSCRIPT)

    version_cid = make_version([entry(bad, "paper.pdf", MANUSCRIPT)])

    assert status_of(bad.cid) == content.SCAN_FAILED
    early_checks = {report.check_name for report in sanitizer.reports_for(bad.cid)}
    assert early_checks, "the author must be able to see why the file failed"
    assert state_of(version_cid) == AWAITING_CONSENT

    # After consent the version scan reaches the same verdict and holds the
    # version; it does not leave a second row per check.
    transition_version(version_cid, SCANNING, reason="all authors consented")
    assert state_of(version_cid) == HELD
    reports = sanitizer.reports_for(bad.cid)
    assert {report.check_name for report in reports} == early_checks
    assert len(reports) == len(early_checks)


def test_after_consent_a_version_whose_files_already_passed_moves_on_at_once():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)])
    assert status_of(pdf.cid) == content.SCAN_PASSED

    transition_version(version_cid, SCANNING, reason="all authors consented")

    assert state_of(version_cid) == MODERATION


def test_a_version_still_waits_in_scanning_when_its_scan_is_pending(files_not_scanned_early):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)])
    assert status_of(pdf.cid) == content.SCAN_SCANNING

    # With nothing scanned ahead, the version scan after consent does the work
    # exactly as before.
    transition_version(version_cid, SCANNING, reason="all authors consented")

    assert status_of(pdf.cid) == content.SCAN_PASSED
    assert state_of(version_cid) == MODERATION


def test_a_file_the_node_does_not_hold_yet_is_left_for_the_version_scan():
    missing = compute_file_id(b"bytes that have not arrived " + uuid.uuid4().hex.encode())

    # Recording must not fail, and must not report a failure for a file that
    # may simply not have been received yet.
    add_manifest([{"path": "paper.pdf", "cid": missing, "mediaType": MANUSCRIPT}])

    assert content.get_blob(missing) is None
    assert sanitizer.reports_for(missing) == []
    assert sanitizer.scan_stored_file(missing) is None


def test_a_verdict_already_given_is_not_decided_again():
    pdf = stored(clean_pdf(), MANUSCRIPT)
    content.set_scan_status(pdf.cid, content.SCAN_FAILED)  # e.g. a moderator's or a past scan's verdict

    add_manifest([entry(pdf, "paper.pdf", MANUSCRIPT)])

    assert status_of(pdf.cid) == content.SCAN_FAILED
    assert sanitizer.scan_stored_file(pdf.cid) is None
    assert sanitizer.enqueue_file_scan(pdf.cid) is None


def test_the_file_job_scans_one_file(files_not_scanned_early):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    bad = stored(javascript_pdf(), MANUSCRIPT)

    jobs.enqueue(FILE_JOB_KIND, {"cid": pdf.cid})
    jobs.enqueue(FILE_JOB_KIND, {"cid": bad.cid})

    assert status_of(pdf.cid) == content.SCAN_PASSED
    assert status_of(bad.cid) == content.SCAN_FAILED


def test_a_scan_that_cannot_be_scheduled_neither_breaks_the_append_nor_the_other_files(monkeypatch):
    first = stored(clean_pdf(), MANUSCRIPT)
    second = stored(clean_pdf(), MANUSCRIPT)
    real = scan_job.enqueue_file_scan

    def flaky(cid):
        if cid == first.cid:
            raise RuntimeError("the job queue is down")
        return real(cid)

    monkeypatch.setattr(scan_job, "enqueue_file_scan", flaky)

    version_cid = make_version(
        [entry(first, "a.pdf", MANUSCRIPT), entry(second, "b.pdf", MANUSCRIPT, "supplement")]
    )

    assert version_cid
    assert status_of(second.cid) == content.SCAN_PASSED
    # The file that could not be scheduled is not lost: its version scan still covers it.
    assert status_of(first.cid) == content.SCAN_SCANNING
    transition_version(version_cid, SCANNING, reason="all authors consented")
    assert status_of(first.cid) == content.SCAN_PASSED
    assert state_of(version_cid) == MODERATION
