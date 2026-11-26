"""The extraction pipeline that runs when a version reaches moderation.

Bug: ``save_version_text``, ``save_similarity_check``, ``save_reference_check``
and ``save_metadata_match`` existed but nothing ever called them, so every
paper read as empty, the moderation queue's similarity/reference columns
stayed NULL and the checks route the web submit step polls was missing.

These tests drive the behaviour the node promises:

* a version entering ``moderation`` schedules a background job (through
  :mod:`app.jobs`, eager in tests) that extracts its PDF into
  ``version_texts`` and runs the advisory checks;
* the job is idempotent per version;
* ``GET /v1/papers/{id}/v/{n}/checks`` is mounted, is a 404 problem until the
  checks ran, and then returns the report shape
  ``apps/web/src/features/submit/checks.ts`` parses;
* a version the safety scan held answers with its per-file verdicts (round 22),
  and a version still ``scanning`` whose only findings are the inconclusive
  ``av_unavailable`` answers that it is waiting for the node's antivirus
  (``scanWaiting`` true, each such file ``waiting``) rather than the pending
  404 (bug spec round 27, item 2).

Isolation follows the rest of this suite: each test uses fresh record cids and
asserts on its own rows.
"""

from __future__ import annotations

import importlib
import io
import uuid
import zipfile
from typing import Optional

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import compute_record_id
from sqlalchemy import text

from app import db
from app.modules import checks, content, ledger, sanitizer
from app.modules.submissions import VersionStateChanged, emit_state_changed
from app.modules.submissions.models import PaperVersion
from app.security import issue_access_token

from .pdfs import simple_pdf

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
TITLE = "Widgets And Gadgets"

# The title is on page one, so the metadata check has something to find.
PDF = simple_pdf(
    [
        (720, TITLE),
        (700, "We study the effect of widgets on"),
        (686, "gadgets in a controlled setting."),
        (658, "Second paragraph starts here and"),
        (644, "continues on this line."),
    ],
    [(720, "A paragraph on the next page.")],
)
PARAGRAPHS = [
    TITLE,
    "We study the effect of widgets on gadgets in a controlled setting.",
    "Second paragraph starts here and continues on this line.",
    "A paragraph on the next page.",
]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def new_record_cid(kind: str = "test.checks") -> str:
    """A real, unique dag-cbor record id."""
    return compute_record_id(
        {
            "v": 1,
            "type": kind,
            "author": AUTHOR,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def append_manifest(files: list[dict]) -> str:
    """Append an unsigned ``manifest`` record and return its cid."""
    envelope = {
        "v": 1,
        "type": "manifest",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        # The PDF bytes are deterministic, so the nonce keeps each test's
        # manifest record (and its cid) distinct in the shared worker log.
        "body": {"files": files, "nonce": uuid.uuid4().hex},
        "proofs": [],
    }
    envelope["id"] = compute_record_id(envelope)
    return ledger.append(envelope).record_cid


def store_version(state: str = "moderation") -> tuple[str, str, str]:
    """Store a version row whose manifest points at a text-bearing PDF.

    Returns ``(version_cid, paper_cid, pdf_cid)``.
    """
    from app.modules.submissions.models import ensure_tables

    version_cid = new_record_cid()
    paper_cid = new_record_cid("test.paper")
    pdf = content.store_bytes(PDF, media_type="application/pdf")
    manifest_cid = append_manifest(
        [
            {
                "path": "main.pdf",
                "cid": str(pdf.cid),
                "size": len(PDF),
                "mediaType": "application/pdf",
                "role": "manuscript",
            }
        ]
    )

    ensure_tables()
    with db.SessionLocal() as session:
        session.add(
            PaperVersion(
                version_cid=version_cid,
                paper_cid=paper_cid,
                n=1,
                title=TITLE,
                abstract="An abstract.",
                manifest_cid=manifest_cid,
                licence="CC-BY-4.0",
                prev_cid=None,
                state=state,
            )
        )
        session.commit()
    return version_cid, paper_cid, str(pdf.cid)


#: Bytes of a code bundle whose scan fails because the antivirus is unavailable.
ZIP = b"PK\x03\x04a code bundle no scan could clear"


def clean_zip() -> bytes:
    """A structurally clean archive: only the malware scan can judge it.

    Fresh bytes per call, so every test's bundle has its own content cid and
    its own scan reports.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("data/notes.txt", f"notes {uuid.uuid4().hex}")
    return buffer.getvalue()


def store_scan_held_version(state: str = "held") -> tuple[str, str, str]:
    """Store a version the safety scan held: a bundle blob whose scan failed.

    The blob carries ``scan_status`` ``failed`` and the ``av_unavailable``
    report the scan wrote; no ``check_results`` row exists, because the
    advisory checks only run after a clean scan.

    Returns ``(version_cid, paper_cid, bundle_cid)``.
    """
    from app.modules.submissions.models import ensure_tables

    version_cid = new_record_cid()
    paper_cid = new_record_cid("test.paper")
    bundle = content.store_bytes(ZIP, media_type="application/zip")
    content.set_scan_status(bundle.cid, content.SCAN_FAILED)
    sanitizer.record_finding(
        str(bundle.cid),
        sanitizer.CHECK_AV_UNAVAILABLE,
        "ClamAV (clamd) is unavailable: CLAMD_SOCKET is not set",
    )
    manifest_cid = append_manifest(
        [
            {
                "path": "code.zip",
                "cid": str(bundle.cid),
                "size": len(ZIP),
                "mediaType": "application/zip",
                "role": "code",
            }
        ]
    )

    ensure_tables()
    with db.SessionLocal() as session:
        session.add(
            PaperVersion(
                version_cid=version_cid,
                paper_cid=paper_cid,
                n=1,
                title=TITLE,
                abstract="An abstract.",
                manifest_cid=manifest_cid,
                licence="CC-BY-4.0",
                prev_cid=None,
                state=state,
            )
        )
        session.commit()
    return version_cid, paper_cid, str(bundle.cid)


def ensure_trigger() -> None:
    """Install the extraction trigger (normally done when the module loads)."""
    pipeline = importlib.import_module("app.modules.checks.pipeline")
    pipeline.ensure_subscribed()


def store_waiting_version(*, with_pdf: bool = False) -> tuple[str, str, str, Optional[str]]:
    """Store a version waiting for the node's antivirus to come back.

    What the scanner leaves behind on a node without ``CLAMD_SOCKET`` (round
    27, bug 1): the manifest's eager file scan can find nothing against a
    clean archive except the inconclusive ``av_unavailable``, so the bundle's
    blob keeps its ``scanning`` verdict -- an inconclusive finding is not a
    failure -- and the version, stored in ``scanning``, never reaches the
    advisory checks, so no ``check_results`` row exists.  With ``with_pdf``
    the manifest also names a clean PDF, cleared to ``passed`` ahead of the
    version.

    Returns ``(version_cid, paper_cid, bundle_cid, pdf_cid)``; ``pdf_cid`` is
    ``None`` unless ``with_pdf``.
    """
    from app.modules.submissions.models import ensure_tables

    version_cid = new_record_cid()
    paper_cid = new_record_cid("test.paper")
    bundle_bytes = clean_zip()
    bundle = content.store_bytes(bundle_bytes, media_type="application/zip")
    files = [
        {
            "path": "code.zip",
            "cid": str(bundle.cid),
            "size": len(bundle_bytes),
            "mediaType": "application/zip",
            "role": "code",
        }
    ]
    pdf_cid: Optional[str] = None
    if with_pdf:
        pdf = content.store_bytes(PDF, media_type="application/pdf")
        pdf_cid = str(pdf.cid)
        content.set_scan_status(pdf.cid, content.SCAN_PASSED)
        files.append(
            {
                "path": "main.pdf",
                "cid": pdf_cid,
                "size": len(PDF),
                "mediaType": "application/pdf",
                "role": "manuscript",
            }
        )
    manifest_cid = append_manifest(files)
    # The finding the scan leaves on record -- the eager file scan records it
    # itself when its subscription is live; recording it here keeps the scene
    # whatever the subscriber state.
    sanitizer.record_finding(
        str(bundle.cid),
        sanitizer.CHECK_AV_UNAVAILABLE,
        "ClamAV (clamd) is unavailable: CLAMD_SOCKET is not set",
    )

    ensure_tables()
    with db.SessionLocal() as session:
        session.add(
            PaperVersion(
                version_cid=version_cid,
                paper_cid=paper_cid,
                n=1,
                title=TITLE,
                abstract="An abstract.",
                manifest_cid=manifest_cid,
                licence="CC-BY-4.0",
                prev_cid=None,
                state="scanning",
            )
        )
        session.commit()
    return version_cid, paper_cid, str(bundle.cid), pdf_cid


def enter_moderation(version_cid: str, paper_cid: str) -> None:
    emit_state_changed(
        VersionStateChanged(
            version_cid=version_cid,
            paper_cid=paper_cid,
            n=1,
            state="moderation",
            previous_state="scanning",
        )
    )


def text_rows(version_cid: str) -> list[tuple]:
    with db.SessionLocal() as session:
        return [
            tuple(row)
            for row in session.execute(
                text(
                    "SELECT paragraph_id, position, text FROM version_texts "
                    "WHERE version_cid = :v ORDER BY position"
                ),
                {"v": version_cid},
            )
        ]


# --------------------------------------------------------------------------- #
# The trigger
# --------------------------------------------------------------------------- #


def test_a_version_entering_moderation_gets_its_text_extracted_and_checked():
    version_cid, paper_cid, _ = store_version()

    ensure_trigger()
    enter_moderation(version_cid, paper_cid)

    assert [p.text for p in checks.get_version_text(version_cid)] == PARAGRAPHS
    result = checks.get_check_result(version_cid)
    assert result is not None
    # Every advisory check ran: a NULL means "not run", which is the bug.
    assert result.similarity_pct is not None
    assert result.references_total == 0
    assert result.references_unresolved == 0
    assert result.metadata_match is True


def test_extraction_is_idempotent_per_version():
    version_cid, paper_cid, _ = store_version()

    ensure_trigger()
    enter_moderation(version_cid, paper_cid)
    first_rows = text_rows(version_cid)
    first_result = checks.get_check_result(version_cid).to_dict()

    enter_moderation(version_cid, paper_cid)

    assert text_rows(version_cid) == first_rows
    assert checks.get_check_result(version_cid).to_dict() == first_result


def test_a_version_in_another_state_is_not_extracted_by_an_unrelated_event():
    version_cid, paper_cid, _ = store_version(state="awaiting_consent")

    ensure_trigger()
    emit_state_changed(
        VersionStateChanged(
            version_cid=version_cid,
            paper_cid=paper_cid,
            n=1,
            state="awaiting_consent",
        )
    )

    assert checks.get_version_text(version_cid) == []
    assert checks.get_check_result(version_cid) is None


# --------------------------------------------------------------------------- #
# The checks report route
# --------------------------------------------------------------------------- #


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def short_id_for(paper_cid: str) -> str:
    from scholium_record_core import derive_short_id

    return derive_short_id(paper_cid)


def test_the_checks_route_is_mounted(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert "/v1/papers/{paper_id}/v/{n}/checks" in paths


def test_the_checks_route_is_a_404_problem_until_the_checks_ran(client):
    version_cid, paper_cid, _ = store_version()

    response = client.get(f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")


def test_the_checks_route_returns_the_report_the_web_parses(client):
    version_cid, paper_cid, _ = store_version()

    ensure_trigger()
    enter_moderation(version_cid, paper_cid)
    result = checks.get_check_result(version_cid)

    # The version is still in moderation, so only its authors and moderators may read it.
    moderator = {"Authorization": f"Bearer {issue_access_token('did:key:z6MkModeratorForChecks', 4)}"}
    response = client.get(f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator)

    assert response.status_code == 200
    report = response.json()
    assert report["paper"] == short_id_for(paper_cid)
    assert report["version"] == 1
    assert report["versionCid"] == version_cid
    assert report["state"] == "moderation"
    # The web's normalizeVersionChecks reads these flat spellings.
    assert report["similarityPct"] == result.similarity_pct
    assert report["referencesTotal"] == 0
    assert report["referencesUnresolved"] == 0
    assert report["metadataMatch"] is True
    # The advisory checks ran, so the report says so; only a version the
    # safety scan held has no results and reports checksRan false.
    assert report["checksRan"] is True
    assert report["checks_ran"] is True
    assert report["files"] == [
        {
            "path": "main.pdf",
            "cid": report["files"][0]["cid"],
            "role": "manuscript",
            "status": "passed",
            "failedChecks": [],
            "detail": None,
        }
    ]


def test_the_checks_route_404s_for_an_unknown_version(client):
    response = client.get(f"/v1/papers/{derive_unknown_short_id()}/v/9/checks")

    assert response.status_code == 404


def moderator_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token('did:key:z6MkModeratorForChecks', 4)}"}


@pytest.mark.parametrize("state", ["held", "rejected"])
def test_a_scan_held_version_returns_its_file_failure_report(client, state):
    # The safety scan holds the version before the advisory checks can run, so
    # there is no check_results row; the per-file scan verdict is the report.
    version_cid, paper_cid, bundle_cid = store_scan_held_version(state)

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 200
    report = response.json()
    assert report["state"] == state
    assert report["versionCid"] == version_cid
    # The advisory checks did not run, and the report says so rather than
    # pretending the file scan's failure is a pending check.
    assert report["checksRan"] is False
    assert report["checks_ran"] is False
    assert report["files"] == [
        {
            "path": "code.zip",
            "cid": bundle_cid,
            "role": "code",
            "status": "failed",
            "failedChecks": ["av_unavailable"],
            "detail": "ClamAV (clamd) is unavailable: CLAMD_SOCKET is not set",
        }
    ]
    assert report["similarity"] == {"pct": None}
    assert report["similarityPct"] is None
    assert report["similarity_pct"] is None
    assert report["references"] == {"total": None, "unresolved": None}
    assert report["referencesTotal"] is None
    assert report["referencesUnresolved"] is None
    assert report["metadata"] == {"match": None, "signedTitle": None}
    assert report["metadataMatch"] is None
    assert report["metadata_match"] is None


def test_a_scan_held_version_is_still_hidden_from_a_stranger(client):
    version_cid, paper_cid, _ = store_scan_held_version()

    response = client.get(f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    # The unknown-version 404, not the pending one: a stranger cannot tell the
    # version exists or that it was held.
    assert "have not run yet" not in response.json()["detail"]


def test_a_version_still_scanning_keeps_the_checks_pending_404(client):
    version_cid, paper_cid, _ = store_version(state="scanning")

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "have not run yet" in response.json()["detail"]


# --------------------------------------------------------------------------- #
# A version waiting for the node's antivirus (round 27, bug 2)
# --------------------------------------------------------------------------- #


def test_a_version_waiting_for_the_antivirus_answers_scan_waiting_true(client):
    version_cid, paper_cid, bundle_cid, _ = store_waiting_version()

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 200
    report = response.json()
    assert report["versionCid"] == version_cid
    assert report["state"] == "scanning"
    # The answer says the scan is waiting on the node's antivirus, in both
    # spellings, so the tracker can say why the scan is not finishing.
    assert report["scanWaiting"] is True
    assert report["scan_waiting"] is True
    assert report["waitingReason"] == "antivirus_unavailable"
    assert report["waiting_reason"] == "antivirus_unavailable"
    # The advisory checks run only after a clean scan, so they did not run.
    assert report["checksRan"] is False
    assert report["checks_ran"] is False
    assert report["similarityPct"] is None
    assert report["referencesTotal"] is None
    assert report["metadataMatch"] is None
    # The file the scan could not clear is waiting, not failed: there is no
    # finding against the author, and nothing for them to fix.
    assert report["files"] == [
        {
            "path": "code.zip",
            "cid": bundle_cid,
            "role": "code",
            "status": "waiting",
            "failedChecks": ["av_unavailable"],
            "detail": "ClamAV (clamd) is unavailable: CLAMD_SOCKET is not set",
        }
    ]


def test_a_waiting_answer_keeps_the_other_files_statuses(client):
    _version_cid, paper_cid, _bundle_cid, _pdf_cid = store_waiting_version(with_pdf=True)

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 200
    report = response.json()
    assert report["scanWaiting"] is True
    # Only the file the antivirus could not scan waits; the cleared PDF keeps
    # the verdict its own scan gave it.
    assert {file["path"]: file["status"] for file in report["files"]} == {
        "code.zip": "waiting",
        "main.pdf": "passed",
    }


@pytest.mark.parametrize("state", ["held", "rejected"])
def test_a_scan_held_answer_says_it_is_not_waiting(client, state):
    # The same av_unavailable finding, but on a version the scan held: the
    # conclusive-hold answer of round 22 is unchanged and never claims a wait.
    _version_cid, paper_cid, _bundle_cid = store_scan_held_version(state)

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 200
    report = response.json()
    assert report["files"][0]["status"] == "failed"
    assert report["scanWaiting"] is False
    assert report["scan_waiting"] is False
    assert report["waitingReason"] is None
    assert report["waiting_reason"] is None


def test_a_normal_scan_in_progress_is_never_reported_as_waiting(client):
    # A scan progressing normally has no inconclusive finding on record, so it
    # is not waiting on the antivirus: the version keeps the checks-pending 404.
    _version_cid, paper_cid, _ = store_version(state="scanning")

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "have not run yet" in response.json()["detail"]

    # And the answer the checks return once they ran carries scanWaiting false.
    version_cid, paper_cid, _ = store_version()
    ensure_trigger()
    enter_moderation(version_cid, paper_cid)

    response = client.get(
        f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks", headers=moderator_headers()
    )

    assert response.status_code == 200
    report = response.json()
    assert report["scanWaiting"] is False
    assert report["scan_waiting"] is False
    assert report["waitingReason"] is None
    assert report["waiting_reason"] is None


def derive_unknown_short_id() -> str:
    from scholium_record_core import derive_short_id

    return derive_short_id(new_record_cid("test.unknown"))
