"""Tests for the metadata-match check (feature 68).

The check saves ``metadata_match`` to ``check_results``: ``True`` when the
version's signed title appears in the first page text, ``False`` otherwise.

Covers the comparison's tolerance (case, whitespace/line wrapping, ligatures,
line-break hyphenation), the persisted row and its upsert semantics (one row
per version, other checks' columns untouched), both ways of supplying the
first page text (directly or from the version's PDF), recovering the title
and manuscript from the signed record in the event log, validation, and the
table shape and module discovery.

Isolation note: xdist workers get their own database file but tests in a
worker share the tables, so every test uses a fresh random version cid and
asserts on its own rows.  ``CONTENT_DIR`` is fresh per test (see
``conftest.py``).
"""

from __future__ import annotations

import threading
import uuid

import pytest
from fastapi import FastAPI
from scholium_record_core import compute_file_id, compute_record_id
from sqlalchemy import inspect, text

from app import db, module_loader
from app.modules import checks, content, ledger

from .pdfs import build_pdf, simple_pdf

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
TITLE = "A Study of Widgets and Gadgets"


def new_version_cid() -> str:
    """A real, unique dag-cbor record id, as a version's cid is."""
    return compute_record_id(
        {
            "v": 1,
            "type": "test.checks",
            "author": AUTHOR,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def store_pdf(pdf: bytes) -> str:
    return str(content.store_bytes(pdf, media_type="application/pdf").cid)


def stored_result(version_cid: str) -> tuple | None:
    """The raw check_results row of a version, or None."""
    with db.SessionLocal() as session:
        row = session.execute(
            text(
                "SELECT version_cid, similarity_pct, references_total, "
                "references_unresolved, metadata_match FROM check_results "
                "WHERE version_cid = :v"
            ),
            {"v": version_cid},
        ).one_or_none()
    if row is None:
        return None
    version, similarity, total, unresolved, matched = row
    # SQLite hands booleans back as 0/1; normalize so the assertions can use
    # ``is True`` / ``is False`` and still catch a NULL.
    return (version, similarity, total, unresolved, None if matched is None else bool(matched))


# --- the comparison itself -----------------------------------------------------------


def test_an_exact_title_on_the_first_page_matches():
    assert checks.metadata_match(TITLE, f"{TITLE}\nA. Author, B. Author\nAbstract") is True


def test_matching_ignores_case():
    assert checks.metadata_match(TITLE, TITLE.upper()) is True
    assert checks.metadata_match(TITLE.lower(), f"  {TITLE}  ") is True


def test_matching_collapses_whitespace_and_line_wrapping():
    page = "A Study of Widgets\nand   Gadgets\n\nAbstract"

    assert checks.metadata_match(TITLE, page) is True


def test_matching_folds_ligatures_and_full_width_characters():
    assert checks.metadata_match("The ﬁndings of １２ Studies", "The findings of 12 studies") is True


def test_matching_ignores_hyphenation_from_a_line_break():
    page = "A Study of Wid-\ngets and Gadgets\nA. Author"

    assert checks.metadata_match(TITLE, page) is True


def test_a_title_absent_from_the_page_does_not_match():
    assert checks.metadata_match(TITLE, "Unrelated words on the first page.") is False


def test_words_must_appear_in_order_and_in_full():
    assert checks.metadata_match(TITLE, "Widgets of Study Gadgets") is False
    assert checks.metadata_match(TITLE, "A Study of Widgets") is False


def test_an_empty_title_never_matches():
    assert checks.metadata_match("", TITLE) is False
    assert checks.metadata_match("   \n\t", TITLE) is False


def test_non_string_arguments_are_type_errors():
    with pytest.raises(TypeError):
        checks.metadata_match(None, TITLE)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        checks.metadata_match(TITLE, b"bytes")  # type: ignore[arg-type]


# --- saving the verdict ---------------------------------------------------------------


def test_save_metadata_match_writes_true_to_check_results():
    version = new_version_cid()

    saved = checks.save_metadata_match(
        version, TITLE, f"{TITLE}\nDepartment of Widgets"
    )

    assert saved is True
    assert stored_result(version) == (version, None, None, None, True)


def test_save_metadata_match_writes_false_when_the_title_is_not_on_the_page():
    version = new_version_cid()

    saved = checks.save_metadata_match(version, TITLE, "A completely different title")

    assert saved is False
    assert stored_result(version) == (version, None, None, None, False)


def test_signed_title_is_a_keyword_alias_for_title():
    version = new_version_cid()

    saved = checks.save_metadata_match(
        version, first_page_text=TITLE, signed_title=TITLE
    )

    assert saved is True
    assert stored_result(version)[4] is True


def test_saving_again_updates_the_one_row_rather_than_inserting_another():
    version = new_version_cid()

    checks.save_metadata_match(version, TITLE, TITLE)
    checks.save_metadata_match(version, TITLE, "the title is gone")

    with db.SessionLocal() as session:
        count = session.execute(
            text("SELECT COUNT(*) FROM check_results WHERE version_cid = :v"),
            {"v": version},
        ).scalar_one()
    assert count == 1
    assert stored_result(version) == (version, None, None, None, False)


def test_saving_metadata_leaves_the_other_checks_columns_alone():
    version = new_version_cid()
    checks.save_check_result(
        version,
        similarity_pct=12.5,
        references_total=40,
        references_unresolved=3,
    )

    checks.save_metadata_match(version, TITLE, TITLE)

    assert stored_result(version) == (version, 12.5, 40, 3, True)


def test_a_page_without_a_text_layer_is_saved_as_false():
    version = new_version_cid()
    blank = store_pdf(build_pdf(["", ""]))

    assert checks.save_metadata_match(version, TITLE, blank) is False
    assert stored_result(version)[4] is False


def test_invalid_version_cid_raises_and_saves_nothing():
    for bad in ("", "abc", "not a cid", None, 12, b"bytes"):
        with pytest.raises(checks.InvalidVersionCid):
            checks.save_metadata_match(bad, TITLE, TITLE)  # type: ignore[arg-type]


def test_a_non_string_title_or_page_text_is_a_type_error():
    version = new_version_cid()

    with pytest.raises(TypeError):
        checks.save_metadata_match(version, 42, TITLE)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        checks.save_metadata_match(version, TITLE, 42)  # type: ignore[arg-type]

    assert stored_result(version) is None


# --- first page text from a PDF --------------------------------------------------------


def test_first_page_is_read_from_the_given_pdf():
    version = new_version_cid()
    pdf = simple_pdf([(720, TITLE), (700, "A. Author"), (686, "Abstract text.")])
    pdf_cid = store_pdf(pdf)

    assert checks.save_metadata_match(version, TITLE, pdf_cid=pdf_cid) is True
    assert stored_result(version)[4] is True


def test_a_title_that_only_appears_on_a_later_page_does_not_match():
    version = new_version_cid()
    pdf = simple_pdf(
        [(720, "Running header"), (700, "Unrelated opening words.")],
        [(720, TITLE), (700, "Body text quoting the title here.")],
    )
    pdf_cid = store_pdf(pdf)

    assert checks.save_metadata_match(version, TITLE, pdf_cid=pdf_cid) is False


def test_an_unknown_pdf_cid_raises_blob_not_found():
    version = new_version_cid()
    unknown = compute_file_id(b"never stored " + uuid.uuid4().bytes)

    with pytest.raises(content.BlobNotFound):
        checks.save_metadata_match(version, TITLE, pdf_cid=unknown)

    assert stored_result(version) is None


def test_an_unreadable_pdf_raises_pdf_text_error():
    version = new_version_cid()
    not_a_pdf = store_pdf(b"definitely not a pdf " + uuid.uuid4().bytes)

    with pytest.raises(checks.PdfTextError):
        checks.save_metadata_match(version, TITLE, pdf_cid=not_a_pdf)

    assert stored_result(version) is None


def test_extract_first_page_text_returns_only_page_one_as_one_line():
    pdf = simple_pdf(
        [(720, "First page"), (700, "second line")],
        [(720, "Second page")],
    )

    assert checks.extract_first_page_text(pdf) == "First page second line"


# --- title and manuscript from the signed record ---------------------------------------


def append_version_record(title: str, pdf_cid: str, pdf_size: int) -> str:
    """Append a signed ``paper.version`` record and return its cid."""
    envelope = {
        "v": 1,
        "type": "paper.version",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {
            "paper": compute_record_id(
                {
                    "v": 1,
                    "type": "test.paper",
                    "author": AUTHOR,
                    "created": "2026-11-15T00:00:00Z",
                    "prev": None,
                    "body": {"nonce": uuid.uuid4().hex},
                    "proofs": [],
                }
            ),
            "n": 1,
            "title": title,
            "manifest": {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": pdf_cid,
                        "size": pdf_size,
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        },
        "proofs": [],
    }
    ledger.append(envelope)
    return compute_record_id(envelope)


def test_the_signed_title_and_manuscript_are_read_from_the_event_log():
    pdf = simple_pdf([(720, TITLE), (700, "A. Author"), (686, "Abstract.")])
    pdf_cid = store_pdf(pdf)
    version = append_version_record(TITLE, pdf_cid, len(pdf))

    assert checks.save_metadata_match(version) is True
    assert stored_result(version)[4] is True


def test_a_signed_title_absent_from_the_manuscript_is_false():
    pdf = simple_pdf([(720, "A different paper title"), (700, "Body.")])
    pdf_cid = store_pdf(pdf)
    version = append_version_record(TITLE, pdf_cid, len(pdf))

    assert checks.save_metadata_match(version) is False


def test_the_manifest_may_be_a_separate_manifest_record():
    pdf = simple_pdf([(720, TITLE), (700, "Body.")])
    pdf_cid = store_pdf(pdf)
    manifest_envelope = {
        "v": 1,
        "type": "manifest",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {
            # Unique so repeated runs against the shared worker database do
            # not append the same event_log cid twice.
            "nonce": uuid.uuid4().hex,
            "files": [
                {
                    "path": "paper.pdf",
                    "cid": pdf_cid,
                    "size": len(pdf),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ],
        },
        "proofs": [],
    }
    ledger.append(manifest_envelope)
    version_envelope = {
        "v": 1,
        "type": "paper.version",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {
            "nonce": uuid.uuid4().hex,
            "title": TITLE,
            "manifest": compute_record_id(manifest_envelope),
        },
        "proofs": [],
    }
    ledger.append(version_envelope)
    version = compute_record_id(version_envelope)

    assert checks.save_metadata_match(version) is True


def test_a_version_with_no_signed_record_cannot_recover_its_inputs():
    version = new_version_cid()

    with pytest.raises(checks.MetadataMatchError):
        checks.save_metadata_match(version)

    with pytest.raises(checks.MetadataMatchError):
        checks.save_metadata_match(version, TITLE)  # no page text or pdf

    assert stored_result(version) is None


# --- reading --------------------------------------------------------------------------


def test_get_check_result_returns_the_saved_row():
    version = new_version_cid()
    checks.save_metadata_match(version, TITLE, TITLE)

    row = checks.get_check_result(version)

    assert row is not None
    assert row.version_cid == version
    assert row.metadata_match is True
    assert row.similarity_pct is None


def test_get_check_result_is_none_for_an_unknown_or_invalid_version():
    assert checks.get_check_result(new_version_cid()) is None
    assert checks.get_check_result("not a cid") is None
    assert checks.get_check_result(None) is None  # type: ignore[arg-type]


# --- concurrency ----------------------------------------------------------------------


def test_concurrent_metadata_writes_leave_one_consistent_row():
    version = new_version_cid()
    errors: list[BaseException] = []

    def save() -> None:
        try:
            checks.save_metadata_match(version, TITLE, TITLE)
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    checks.ensure_check_results_table()
    threads = [threading.Thread(target=save) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert stored_result(version) == (version, None, None, None, True)


# --- table shape and module discovery -------------------------------------------------


def test_table_has_the_specified_columns():
    checks.ensure_check_results_table()
    inspector = inspect(db.engine)

    columns = {c["name"]: c for c in inspector.get_columns("check_results")}

    assert list(columns) == [
        "version_cid",
        "similarity_pct",
        "references_total",
        "references_unresolved",
        "metadata_match",
    ]
    assert inspector.get_pk_constraint("check_results")["constrained_columns"] == [
        "version_cid"
    ]
    assert columns["version_cid"]["nullable"] is False
    assert all(
        columns[name]["nullable"]
        for name in ("similarity_pct", "references_total", "references_unresolved", "metadata_match")
    )
    assert {name: str(c["type"]) for name, c in columns.items()} == {
        "version_cid": "TEXT",
        "similarity_pct": "FLOAT",
        "references_total": "INTEGER",
        "references_unresolved": "INTEGER",
        "metadata_match": "BOOLEAN",
    }


def test_module_is_discovered_and_registers_check_results_without_adding_routes():
    app = FastAPI()
    before = len(app.routes)

    loaded = module_loader.load_modules(app)

    assert checks in loaded
    assert "check_results" in db.Base.metadata.tables
    assert not hasattr(checks, "router")
    assert not any(getattr(r, "path", "").startswith("/v1/checks") for r in app.routes[before:])


def test_create_app_creates_the_check_results_table():
    from app.main import create_app

    create_app()

    assert inspect(db.engine).has_table("check_results")
