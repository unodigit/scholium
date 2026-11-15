"""Tests for the PDF active-content scan (feature 60).

Covers: each hazard named by the spec (JavaScript, embedded files, Launch and
OpenAction), the failed row saved per finding in ``scan_reports``, the cid the
row is keyed by, clean PDFs writing nothing, idempotent re-scans, every input
shape (bytes, stream, path, blob cid) and unreadable input failing safe.

Isolation note: xdist workers get their own database file but tests in a
worker share the ``scan_reports`` table, so every PDF carries random metadata
and asserts on its own cid rather than on table totals.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    NameObject,
    TextStringObject,
)
from scholium_record_core import compute_file_id
from sqlalchemy import inspect as sqlalchemy_inspect

from app import db
from app.modules import content, sanitizer
from app.modules.sanitizer import (
    CHECK_EMBEDDED_FILES,
    CHECK_JAVASCRIPT,
    CHECK_LAUNCH_ACTION,
    CHECK_OPEN_ACTION,
    CHECK_UNREADABLE,
    RESULT_FAILED,
)


def new_writer() -> PdfWriter:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    # Random metadata keeps every test's PDF bytes (and so its cid) unique.
    writer.add_metadata({"/Title": f"scan-{os.urandom(8).hex()}"})
    return writer


def pdf_bytes(writer: PdfWriter) -> bytes:
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def with_javascript_open_action() -> bytes:
    writer = new_writer()
    writer._root_object[NameObject("/OpenAction")] = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('pwned')"),
        }
    )
    return pdf_bytes(writer)


def with_javascript_name_tree() -> bytes:
    writer = new_writer()
    writer._root_object[NameObject("/Names")] = DictionaryObject(
        {
            NameObject("/JavaScript"): DictionaryObject(
                {
                    NameObject("/Names"): ArrayObject(
                        [
                            TextStringObject("evil"),
                            DictionaryObject(
                                {
                                    NameObject("/S"): NameObject("/JavaScript"),
                                    NameObject("/JS"): TextStringObject(
                                        "app.alert('pwned')"
                                    ),
                                }
                            ),
                        ]
                    )
                }
            )
        }
    )
    return pdf_bytes(writer)


def with_embedded_file() -> bytes:
    writer = new_writer()
    writer.add_attachment("payload.bin", os.urandom(32))
    return pdf_bytes(writer)


def with_launch_action() -> bytes:
    writer = new_writer()
    # Additional-actions dictionary on the catalog: a Launch action that
    # opens an external program.  No /OpenAction, so only the Launch check
    # should fire.
    writer._root_object[NameObject("/AA")] = DictionaryObject(
        {
            NameObject("/WC"): DictionaryObject(
                {
                    NameObject("/S"): NameObject("/Launch"),
                    NameObject("/F"): TextStringObject("calc.exe"),
                }
            )
        }
    )
    return pdf_bytes(writer)


def with_open_action_destination() -> bytes:
    writer = new_writer()
    # A plain destination (not an action dict) still lands in /OpenAction.
    writer.open_destination = writer.pages[0]
    return pdf_bytes(writer)


def clean_pdf() -> bytes:
    return pdf_bytes(new_writer())


def saved_rows(cid: str) -> list[sanitizer.ScanReport]:
    return sanitizer.reports_for(cid)


# --------------------------------------------------------------------------- #
# Each hazard named by the spec                                                #
# --------------------------------------------------------------------------- #


def test_open_action_javascript_is_failed_and_saved():
    data = with_javascript_open_action()
    result = sanitizer.scan_pdf_bytes(data)

    assert result.failed is True
    assert set(result.check_names) == {CHECK_JAVASCRIPT, CHECK_OPEN_ACTION}
    assert result.cid == compute_file_id(data)

    rows = saved_rows(result.cid)
    assert {row.check_name for row in rows} == set(result.check_names)
    assert all(row.result == RESULT_FAILED for row in rows)
    javascript = result.finding(CHECK_JAVASCRIPT)
    assert javascript is not None
    assert "javascript" in javascript.detail.lower()


def test_document_javascript_name_tree_is_failed_and_saved():
    result = sanitizer.scan_pdf_bytes(with_javascript_name_tree())

    assert result.failed is True
    assert result.check_names == (CHECK_JAVASCRIPT,)
    rows = saved_rows(result.cid)
    assert [(row.check_name, row.result) for row in rows] == [
        (CHECK_JAVASCRIPT, RESULT_FAILED)
    ]


def test_embedded_file_is_failed_and_saved():
    result = sanitizer.scan_pdf_bytes(with_embedded_file())

    assert result.failed is True
    assert result.check_names == (CHECK_EMBEDDED_FILES,)
    rows = saved_rows(result.cid)
    assert len(rows) == 1
    assert rows[0].check_name == CHECK_EMBEDDED_FILES
    assert rows[0].result == RESULT_FAILED
    assert "embedded" in rows[0].detail.lower()


def test_launch_action_is_failed_and_saved():
    result = sanitizer.scan_pdf_bytes(with_launch_action())

    assert result.failed is True
    assert result.check_names == (CHECK_LAUNCH_ACTION,)
    rows = saved_rows(result.cid)
    assert [(row.check_name, row.result) for row in rows] == [
        (CHECK_LAUNCH_ACTION, RESULT_FAILED)
    ]
    assert "launch" in rows[0].detail.lower()


def test_open_action_is_failed_and_saved():
    result = sanitizer.scan_pdf_bytes(with_open_action_destination())

    assert result.failed is True
    assert result.check_names == (CHECK_OPEN_ACTION,)
    rows = saved_rows(result.cid)
    assert [(row.check_name, row.result) for row in rows] == [
        (CHECK_OPEN_ACTION, RESULT_FAILED)
    ]


def test_one_failed_row_per_hazard_for_a_pdf_with_several():
    writer = new_writer()
    writer.add_attachment("payload.bin", os.urandom(16))
    writer._root_object[NameObject("/OpenAction")] = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('pwned')"),
        }
    )
    data = pdf_bytes(writer)

    result = sanitizer.scan_pdf_bytes(data)

    assert set(result.check_names) == {
        CHECK_JAVASCRIPT,
        CHECK_EMBEDDED_FILES,
        CHECK_OPEN_ACTION,
    }
    rows = saved_rows(result.cid)
    assert {row.check_name for row in rows} == set(result.check_names)
    assert all(row.result == RESULT_FAILED for row in rows)
    # The composite key keeps one current verdict per check.
    assert len(rows) == len(result.check_names)


def test_repeated_javascript_actions_are_one_finding():
    writer = new_writer()
    writer._root_object[NameObject("/OpenAction")] = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("one()"),
            NameObject("/Next"): DictionaryObject(
                {
                    NameObject("/S"): NameObject("/JavaScript"),
                    NameObject("/JS"): TextStringObject("two()"),
                }
            ),
        }
    )
    result = sanitizer.scan_pdf_bytes(pdf_bytes(writer))

    javascript_rows = [
        row for row in saved_rows(result.cid) if row.check_name == CHECK_JAVASCRIPT
    ]
    assert len(javascript_rows) == 1
    assert result.check_names.count(CHECK_JAVASCRIPT) == 1


def test_javascript_in_a_form_field_action_is_failed_and_saved():
    writer = new_writer()
    field = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/T"): TextStringObject("name"),
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/AA"): DictionaryObject(
                {
                    NameObject("/K"): DictionaryObject(
                        {
                            NameObject("/S"): NameObject("/JavaScript"),
                            NameObject("/JS"): TextStringObject("steal()"),
                        }
                    )
                }
            ),
        }
    )
    writer._root_object[NameObject("/AcroForm")] = DictionaryObject(
        {NameObject("/Fields"): ArrayObject([field])}
    )

    result = sanitizer.scan_pdf_bytes(pdf_bytes(writer))

    assert CHECK_JAVASCRIPT in result.check_names
    assert any(
        row.check_name == CHECK_JAVASCRIPT
        for row in saved_rows(result.cid)
        if row.result == RESULT_FAILED
    )


def test_encrypted_pdf_fails_safe():
    writer = new_writer()
    writer.encrypt("secret")

    result = sanitizer.scan_pdf_bytes(pdf_bytes(writer))

    assert result.check_names == (CHECK_UNREADABLE,)
    rows = saved_rows(result.cid)
    assert [(row.check_name, row.result) for row in rows] == [
        (CHECK_UNREADABLE, RESULT_FAILED)
    ]


# --------------------------------------------------------------------------- #
# Clean and unreadable input                                                   #
# --------------------------------------------------------------------------- #


def test_clean_pdf_writes_no_reports():
    data = clean_pdf()
    result = sanitizer.scan_pdf_bytes(data)

    assert result.passed is True
    assert result.result == "passed"
    assert result.findings == ()
    assert result.reports == ()
    assert result.cid == compute_file_id(data)
    assert saved_rows(result.cid) == []


def test_unreadable_input_fails_safe_and_is_saved():
    result = sanitizer.scan_pdf_bytes(b"this is not a PDF")

    assert result.failed is True
    assert result.check_names == (CHECK_UNREADABLE,)
    rows = saved_rows(result.cid)
    assert len(rows) == 1
    assert rows[0].check_name == CHECK_UNREADABLE
    assert rows[0].result == RESULT_FAILED


def test_analyze_pdf_never_writes():
    data = with_javascript_open_action()
    findings = sanitizer.analyze_pdf(data)

    assert {finding.check_name for finding in findings} == {
        CHECK_JAVASCRIPT,
        CHECK_OPEN_ACTION,
    }
    assert saved_rows(compute_file_id(data)) == []


def test_record_false_is_a_dry_run():
    data = with_embedded_file()
    result = sanitizer.scan_pdf_bytes(data, record=False)

    assert result.failed is True
    assert result.reports == ()
    assert saved_rows(result.cid) == []


# --------------------------------------------------------------------------- #
# cid handling and idempotence                                                 #
# --------------------------------------------------------------------------- #


def test_explicit_cid_is_used_for_the_saved_rows():
    data = with_javascript_open_action()
    explicit = compute_file_id(b"some other content")

    result = sanitizer.scan_pdf_bytes(data, cid=explicit)

    assert result.cid == explicit
    rows = saved_rows(explicit)
    assert rows
    assert all(row.cid == explicit for row in rows)


def test_rescan_updates_the_same_row():
    data = with_javascript_open_action()
    first = sanitizer.scan_pdf_bytes(data)
    second = sanitizer.scan_pdf_bytes(data)

    assert first.cid == second.cid
    rows = saved_rows(first.cid)
    assert len(rows) == len(first.check_names)
    assert {row.check_name for row in rows} == set(first.check_names)
    assert all(row.cid == first.cid for row in rows)


def test_reports_for_unknown_cid_is_empty():
    assert sanitizer.reports_for("not-a-stored-cid") == []
    assert sanitizer.has_failure("not-a-stored-cid") is False
    assert sanitizer.first_failure("not-a-stored-cid") is None


# --------------------------------------------------------------------------- #
# Input shapes                                                                 #
# --------------------------------------------------------------------------- #


def test_scan_pdf_accepts_bytes_stream_and_path(tmp_path: Path):
    data = with_embedded_file()
    expected = compute_file_id(data)

    from_bytes = sanitizer.scan_pdf(data)
    from_stream = sanitizer.scan_pdf(io.BytesIO(data))
    path = tmp_path / "upload.pdf"
    path.write_bytes(data)
    from_path = sanitizer.scan_pdf(path)

    assert from_bytes.cid == from_stream.cid == from_path.cid == expected
    for result in (from_bytes, from_stream, from_path):
        assert result.check_names == (CHECK_EMBEDDED_FILES,)


def test_scan_pdf_rejects_unsupported_input():
    with pytest.raises(TypeError):
        sanitizer.scan_pdf(42)


def test_scan_blob_reads_the_content_store():
    data = with_javascript_open_action()
    blob = content.store_bytes(data, media_type="application/pdf")

    result = sanitizer.scan_blob(blob.cid)

    assert result.cid == blob.cid
    assert set(result.check_names) == {CHECK_JAVASCRIPT, CHECK_OPEN_ACTION}
    rows = saved_rows(blob.cid)
    assert {(row.cid, row.check_name, row.result) for row in rows} == {
        (blob.cid, CHECK_JAVASCRIPT, RESULT_FAILED),
        (blob.cid, CHECK_OPEN_ACTION, RESULT_FAILED),
    }
    # Scanning reports a verdict; the background job owns blobs.scan_status.
    assert content.get_blob(blob.cid).scan_status == content.SCAN_SCANNING


def test_scan_pdf_accepts_a_blob_cid_string():
    blob = content.store_bytes(clean_pdf(), media_type="application/pdf")

    result = sanitizer.scan_pdf(blob.cid)

    assert result.cid == blob.cid
    assert result.passed is True


# --------------------------------------------------------------------------- #
# Table and helpers                                                            #
# --------------------------------------------------------------------------- #


def test_check_names_use_the_spec_vocabulary():
    assert sanitizer.CHECK_JAVASCRIPT == "javascript"
    assert sanitizer.CHECK_EMBEDDED_FILES == "embedded_files"
    assert sanitizer.CHECK_LAUNCH_ACTION == "launch"
    assert sanitizer.CHECK_OPEN_ACTION == "openaction"


def test_model_is_registered_on_the_shared_metadata():
    assert "scan_reports" in db.Base.metadata.tables


def test_scan_reports_table_has_the_spec_columns():
    sanitizer.ensure_table()
    columns = {
        column["name"]: column
        for column in sqlalchemy_inspect(db.engine).get_columns("scan_reports")
    }

    assert set(columns) == {"cid", "check_name", "result", "detail"}
    assert columns["cid"]["nullable"] is False
    assert columns["check_name"]["nullable"] is False
    assert columns["result"]["nullable"] is False
    assert columns["detail"]["nullable"] is True


def test_record_report_validates_required_fields():
    with pytest.raises(sanitizer.InvalidScanReport):
        sanitizer.record_report("", CHECK_JAVASCRIPT)
    with pytest.raises(sanitizer.InvalidScanReport):
        sanitizer.record_report("cid", "")
    with pytest.raises(sanitizer.InvalidScanReport):
        sanitizer.record_report("cid", CHECK_JAVASCRIPT, result="maybe")


def test_delete_reports_removes_the_cid_rows():
    result = sanitizer.scan_pdf_bytes(with_launch_action())
    assert saved_rows(result.cid)

    removed = sanitizer.delete_reports(result.cid)

    assert removed == 1
    assert saved_rows(result.cid) == []
