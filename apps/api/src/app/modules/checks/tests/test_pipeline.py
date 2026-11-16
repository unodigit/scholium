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
  ``apps/web/src/features/submit/checks.ts`` parses.

Isolation follows the rest of this suite: each test uses fresh record cids and
asserts on its own rows.
"""

from __future__ import annotations

import importlib
import uuid

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import compute_record_id
from sqlalchemy import text

from app import db
from app.modules import checks, content, ledger
from app.modules.submissions import VersionStateChanged, emit_state_changed
from app.modules.submissions.models import PaperVersion

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


def ensure_trigger() -> None:
    """Install the extraction trigger (normally done when the module loads)."""
    pipeline = importlib.import_module("app.modules.checks.pipeline")
    pipeline.ensure_subscribed()


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

    response = client.get(f"/v1/papers/{short_id_for(paper_cid)}/v/1/checks")

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
    assert report["files"] == [
        {
            "path": "main.pdf",
            "cid": report["files"][0]["cid"],
            "role": "manuscript",
            "status": "scanning",
            "failedChecks": [],
            "detail": None,
        }
    ]


def test_the_checks_route_404s_for_an_unknown_version(client):
    response = client.get(f"/v1/papers/{derive_unknown_short_id()}/v/9/checks")

    assert response.status_code == 404


def derive_unknown_short_id() -> str:
    from scholium_record_core import derive_short_id

    return derive_short_id(new_record_cid("test.unknown"))
