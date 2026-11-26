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
import logging
import socketserver
import struct
import threading
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db, jobs
from app.modules import content, ledger, sanitizer
from app.modules.sanitizer import (
    CHECK_AV_UNAVAILABLE,
    CHECK_FILE_MISSING,
    CHECK_MALWARE,
    CHECK_MANIFEST_UNREADABLE,
    CHECK_PATH_TRAVERSAL,
    JOB_KIND,
    RENDITION_TYPE,
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
from app.settings import settings

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


def clean_zip() -> bytes:
    """A structurally clean archive: only the malware scan can judge it."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("data/notes.txt", f"notes {uuid.uuid4().hex}")
    return buffer.getvalue()


def renditions_of(version_cid: str) -> list:
    """Every ``rendition`` entry in the log whose ``source`` is the version."""
    return [
        logged
        for logged in ledger.entries()
        if logged.record_type == RENDITION_TYPE and logged.body.get("source") == version_cid
    ]


def make_version_in_chain(
    paper_cid: str,
    n: int,
    entries: list[dict],
    *,
    state: str = AWAITING_CONSENT,
) -> str:
    """Save version ``n`` of ``paper_cid`` and return its cid."""
    manifest = add_manifest(entries)
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=n,
        title="A version that is scanned",
        abstract="",
        manifest_cid=manifest,
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
    )
    return version_cid


# --------------------------------------------------------------------------- #
# An unavailable antivirus (fake clamd)
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def no_clamd(monkeypatch):
    """Default to a node whose antivirus cannot run."""
    monkeypatch.delenv("CLAMD_SOCKET", raising=False)


class _FakeClamd(socketserver.StreamRequestHandler):
    """Enough of clamd's protocol for a scan: ``VERSION`` and ``INSTREAM``."""

    def handle(self) -> None:
        command = self.rfile.readline().strip()
        if command == b"VERSION":
            self.wfile.write(b"ClamAV 1.4.2/27500/Mon Nov 10 08:00:00 2026\n")
        elif command == b"INSTREAM":
            while True:
                (size,) = struct.unpack("!I", self.rfile.read(4))
                if size == 0:
                    break
                self.rfile.read(size)
            self.wfile.write(self.server.reply + b"\n")


@pytest.fixture
def clamd_factory(monkeypatch):
    """Start a fake clamd that answers ``reply`` to every ``INSTREAM``."""
    servers = []

    def start(reply: bytes):
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _FakeClamd)
        server.reply = reply
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        servers.append(server)
        monkeypatch.setenv("CLAMD_SOCKET", f"127.0.0.1:{server.server_address[1]}")
        return server

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


@pytest.fixture
def node_key(tmp_path, monkeypatch) -> SigningKey:
    """A node Ed25519 key so a passing rescan can sign a rendition."""
    key = SigningKey.generate()
    path = tmp_path / "node.key"
    path.write_text(key.encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return key


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


# --------------------------------------------------------------------------- #
# An unavailable antivirus leaves the version waiting, never held (bug fix)
# --------------------------------------------------------------------------- #


def test_without_clamd_socket_the_version_stays_scanning_and_gets_no_rendition(
    suspended,
):
    """The reported bug: a node without ClamAV held every submission.

    A clean archive can only be cleared by the malware scan.  When clamd
    cannot run, that is not a finding -- the version waits in ``scanning``
    until the antivirus answers, with no rendition and no hold.
    """
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == SCANNING
    assert result.failing_check is None
    assert result.rendition_cid is None
    assert state_of(version_cid) == SCANNING
    # The finding is on record, but it is not a verdict: the blob still waits
    # and the author is not told to publish a new version.
    assert status_of(bundle.cid) == content.SCAN_SCANNING
    assert [
        (report.check_name, report.result)
        for report in sanitizer.reports_for(bundle.cid)
    ] == [(CHECK_AV_UNAVAILABLE, RESULT_FAILED)]
    assert renditions_of(version_cid) == []


def test_an_unnamed_clamd_error_is_inconclusive_too(suspended, clamd_factory):
    clamd_factory(b"INSTREAM failed. ERROR")
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == SCANNING
    assert result.failing_check is None
    assert state_of(version_cid) == SCANNING
    assert status_of(bundle.cid) == content.SCAN_SCANNING


def test_a_size_limit_error_is_conclusive_and_holds_the_version(
    suspended, clamd_factory
):
    """A file larger than clamd's limit cannot be cleared, so it is held."""
    from app.modules.sanitizer import CHECK_TOO_LARGE_TO_SCAN

    clamd_factory(b"INSTREAM size limit exceeded. ERROR")
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert result.failing_check == CHECK_TOO_LARGE_TO_SCAN
    assert state_of(version_cid) == HELD
    assert status_of(bundle.cid) == RESULT_FAILED
    assert [
        (report.check_name, report.result)
        for report in sanitizer.reports_for(bundle.cid)
    ] == [(CHECK_TOO_LARGE_TO_SCAN, RESULT_FAILED)]


def test_a_found_answer_still_holds_the_version_as_malware(suspended, clamd_factory):
    clamd_factory(b"stream: Eicar-Test-Signature FOUND")
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert result.failing_check == CHECK_MALWARE
    assert state_of(version_cid) == HELD
    assert status_of(bundle.cid) == RESULT_FAILED


# --------------------------------------------------------------------------- #
# The periodic rescan
# --------------------------------------------------------------------------- #


def test_the_rescan_job_is_registered_and_scheduled_every_fifteen_minutes():
    from app.modules.sanitizer import RESCAN_JOB

    assert RESCAN_JOB == "sanitizer.rescan"
    assert jobs.schedule_registry.period(RESCAN_JOB) == timedelta(minutes=15)


def test_the_rescan_job_moves_a_waiting_version_on_once_clamd_answers(
    suspended, clamd_factory, node_key
):
    from app.modules.sanitizer import RESCAN_JOB

    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )
    first = sanitizer.scan_version(version_cid)
    assert first.state == SCANNING
    assert state_of(version_cid) == SCANNING

    # The antivirus comes back and the next scheduled pass scans the version.
    clamd_factory(b"stream: OK")
    jobs.enqueue(RESCAN_JOB, {})

    assert state_of(version_cid) == MODERATION
    assert status_of(bundle.cid) == RESULT_PASSED
    assert renditions_of(version_cid) != []


def test_a_version_held_only_for_av_unavailable_is_reopened_and_scanned(
    suspended, clamd_factory, node_key
):
    """A version a previous outage held is not left for dead."""
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=HELD
    )
    sanitizer.record_report(bundle.cid, CHECK_AV_UNAVAILABLE, result=RESULT_FAILED)

    events = []
    subscribe_version_state_changed(events.append)
    clamd_factory(b"stream: OK")

    scanned = sanitizer.rescan_versions()

    assert scanned >= 1
    assert state_of(version_cid) == MODERATION
    assert status_of(bundle.cid) == RESULT_PASSED
    reopened = [
        event
        for event in events
        if event.version_cid == version_cid and event.state == SCANNING
    ]
    assert reopened
    assert reopened[-1].reason == "re-scan: the antivirus was unavailable"
    assert renditions_of(version_cid) != []


def test_a_version_held_for_a_conclusive_finding_is_not_reopened(
    suspended, clamd_factory
):
    clamd_factory(b"stream: Eicar-Test-Signature FOUND")
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING
    )
    held = sanitizer.scan_version(version_cid)
    assert held.state == HELD

    # Even a working antivirus must not re-open a version held on a finding.
    clamd_factory(b"stream: OK")
    sanitizer.rescan_versions()

    assert state_of(version_cid) == HELD
    assert status_of(bundle.cid) == RESULT_FAILED


def test_a_superseded_held_version_is_not_reopened(suspended, clamd_factory):
    paper_cid = f"bafyreipaper{uuid.uuid4().hex}"
    old_bundle = stored(clean_zip(), BUNDLE)
    old = make_version_in_chain(
        paper_cid,
        1,
        [entry(old_bundle, "source.zip", BUNDLE, "source")],
        state=HELD,
    )
    sanitizer.record_report(old_bundle.cid, CHECK_AV_UNAVAILABLE, result=RESULT_FAILED)
    new_bundle = stored(clean_zip(), BUNDLE)
    new = make_version_in_chain(
        paper_cid,
        2,
        [entry(new_bundle, "source.zip", BUNDLE, "source")],
        state=SCANNING,
    )

    clamd_factory(b"stream: OK")
    sanitizer.rescan_versions()

    # The newest version is scanned; the superseded one is never surfaced again.
    assert state_of(old) == HELD
    assert state_of(new) == MODERATION


def test_a_held_version_with_a_moderation_decision_is_not_reopened(
    suspended, clamd_factory
):
    from app.modules.moderation.models import ModerationDecision, ensure_tables

    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=HELD
    )
    sanitizer.record_report(bundle.cid, CHECK_AV_UNAVAILABLE, result=RESULT_FAILED)
    ensure_tables()
    with db.SessionLocal() as session:
        session.add(
            ModerationDecision(
                decision_cid=f"bafyreidecision{uuid.uuid4().hex}",
                target_cid=version_cid,
                action="hold",
                clause="policy-1",
                moderator_did="did:key:z6Mkexample",
                decided_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
        session.commit()

    clamd_factory(b"stream: OK")
    sanitizer.rescan_versions()

    assert state_of(version_cid) == HELD


def test_a_pass_that_leaves_versions_waiting_logs_one_warning(
    suspended, clamd_factory, caplog
):
    bundle = stored(clean_zip(), BUNDLE)
    make_version([entry(bundle, "source.zip", BUNDLE, "source")], state=SCANNING)

    with caplog.at_level(logging.WARNING, logger="app.modules.sanitizer.scan_job"):
        sanitizer.rescan_versions()

    warnings = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
        and "still waiting for the antivirus" in record.getMessage()
    ]
    assert len(warnings) == 1
    assert "CLAMD_SOCKET" in warnings[0]


def test_a_held_version_with_no_scan_report_is_not_reopened(
    files_not_scanned_early, clamd_factory
):
    """Only a hold caused by ``av_unavailable`` may be re-opened."""
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(bundle, "source.zip", BUNDLE, "source")], state=HELD
    )
    assert sanitizer.reports_for(bundle.cid) == []

    clamd_factory(b"stream: OK")
    sanitizer.rescan_versions()

    assert state_of(version_cid) == HELD


def test_a_held_version_with_an_unreadable_manifest_is_not_reopened(
    suspended, clamd_factory
):
    """An unreadable manifest is a conclusive hold, not an AV outage."""
    version_cid = make_version(
        [], manifest_cid=f"bafyreimissing{uuid.uuid4().hex}", state=HELD
    )

    clamd_factory(b"stream: OK")
    sanitizer.rescan_versions()

    assert state_of(version_cid) == HELD
