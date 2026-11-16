"""Tests for saving extracted PDF text to ``version_texts`` (feature 65).

Covers: rows (version_cid, paragraph_id, position, text) written from a PDF in
the content store, ids that are sha256 of the normalized paragraph text and
the same wherever the paragraph sits, replace-on-save semantics (atomic, and a
failed extraction leaves the old text), input validation, the table shape, and
discovery by the module loader.

Isolation note: xdist workers get their own database file but tests in a worker
share the ``version_texts`` table, so every test uses a fresh random version
cid and asserts on its own rows rather than on table totals.  ``CONTENT_DIR``
is fresh per test (see ``conftest.py``).
"""

from __future__ import annotations

import hashlib
import threading
import uuid

import pytest
from fastapi import FastAPI
from multiformats import CID
from scholium_record_core import compute_file_id, compute_record_id
from sqlalchemy import inspect, text

from app import db, module_loader
from app.modules import checks, content

from .pdfs import build_pdf, simple_pdf

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"


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


def rows(version_cid: str) -> list[tuple]:
    """The raw ``version_texts`` rows of a version: (version_cid, paragraph_id, position, text)."""
    with db.SessionLocal() as session:
        return [
            tuple(row)
            for row in session.execute(
                text(
                    "SELECT version_cid, paragraph_id, position, text FROM version_texts "
                    "WHERE version_cid = :v ORDER BY position"
                ),
                {"v": version_cid},
            )
        ]


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


PDF_ONE = simple_pdf(
    [
        (720, "Introduction"),
        (700, "We study the effect of widgets on"),
        (686, "gadgets in a controlled setting."),
        (658, "Second paragraph starts here and"),
        (644, "continues on this line."),
    ],
    [(720, "A paragraph on the next page.")],
)
PARAGRAPHS_ONE = [
    "Introduction",
    "We study the effect of widgets on gadgets in a controlled setting.",
    "Second paragraph starts here and continues on this line.",
    "A paragraph on the next page.",
]


# --- saving from the content store ------------------------------------------------


def test_save_version_text_writes_one_row_per_paragraph():
    version = new_version_cid()

    saved = checks.save_version_text(version, store_pdf(PDF_ONE))

    assert rows(version) == [
        (version, sha256_hex(paragraph), position, paragraph)
        for position, paragraph in enumerate(PARAGRAPHS_ONE)
    ]
    assert [(p.position, p.text) for p in saved] == list(enumerate(PARAGRAPHS_ONE))


def test_paragraph_ids_are_sha256_of_the_normalized_paragraph_text():
    version = new_version_cid()
    pdf = simple_pdf([(700, "Spaces   and\tcafé  here."), (650, "Second.")])

    checks.save_version_text(version, store_pdf(pdf))

    stored = rows(version)
    assert [row[3] for row in stored] == ["Spaces and café here.", "Second."]
    for _, paragraph_id, _, paragraph_text in stored:
        assert paragraph_id == sha256_hex(checks.normalize_paragraph(paragraph_text))
    assert stored[0][1] == sha256_hex("Spaces and café here.")


def test_the_same_paragraph_has_the_same_id_in_another_version_and_position():
    first, second = new_version_cid(), new_version_cid()
    shared = "A paragraph that survives from version one to version two."
    checks.save_version_text(first, store_pdf(simple_pdf([(700, "Opening."), (650, shared)])))
    checks.save_version_text(
        second, store_pdf(simple_pdf([(700, "A new first."), (650, "Opening."), (600, shared)]))
    )

    ids_first = {row[3]: (row[1], row[2]) for row in rows(first)}
    ids_second = {row[3]: (row[1], row[2]) for row in rows(second)}

    assert ids_first[shared][0] == ids_second[shared][0] == sha256_hex(shared)
    assert (ids_first[shared][1], ids_second[shared][1]) == (1, 2)  # moved, same id
    assert ids_first["Opening."][0] == ids_second["Opening."][0]


def test_a_repeated_paragraph_keeps_both_rows_with_one_id():
    version = new_version_cid()
    pdf = simple_pdf([(700, "Table 1."), (650, "Body text."), (600, "Table 1.")])

    checks.save_version_text(version, store_pdf(pdf))

    stored = rows(version)
    assert [row[2] for row in stored] == [0, 1, 2]
    assert stored[0][1] == stored[2][1] != stored[1][1]


def test_saving_again_replaces_rather_than_duplicates():
    version = new_version_cid()
    pdf_cid = store_pdf(PDF_ONE)

    checks.save_version_text(version, pdf_cid)
    before = rows(version)
    checks.save_version_text(version, pdf_cid)

    assert rows(version) == before


def test_saving_different_text_replaces_the_old_text_entirely():
    version = new_version_cid()
    checks.save_version_text(version, store_pdf(PDF_ONE))

    checks.save_version_text(version, store_pdf(simple_pdf([(700, "Only this now.")])))

    assert rows(version) == [(version, sha256_hex("Only this now."), 0, "Only this now.")]


def test_other_versions_are_untouched():
    mine, other = new_version_cid(), new_version_cid()
    checks.save_version_text(other, store_pdf(PDF_ONE))
    before = rows(other)

    checks.save_version_text(mine, store_pdf(simple_pdf([(700, "Mine.")])))
    checks.save_version_text(mine, store_pdf(simple_pdf([(700, "Mine again.")])))

    assert rows(other) == before


def test_pdf_without_text_saves_nothing_and_clears_old_text():
    version = new_version_cid()
    checks.save_version_text(version, store_pdf(PDF_ONE))

    saved = checks.save_version_text(version, store_pdf(build_pdf(["", ""])))

    assert saved == []
    assert rows(version) == []


def test_unreadable_pdf_raises_and_keeps_the_previous_text():
    version = new_version_cid()
    checks.save_version_text(version, store_pdf(PDF_ONE))
    before = rows(version)
    not_a_pdf = content.store_bytes(b"definitely not a pdf " + uuid.uuid4().bytes).cid

    with pytest.raises(checks.PdfTextError):
        checks.save_version_text(version, not_a_pdf)

    assert rows(version) == before


def test_unknown_or_malformed_pdf_cid_raises_blob_not_found():
    version = new_version_cid()
    unknown = compute_file_id(b"never stored " + uuid.uuid4().bytes)

    for bad in (unknown, "not-a-cid", "", None):
        with pytest.raises(content.BlobNotFound):
            checks.save_version_text(version, bad)

    assert rows(version) == []


def test_invalid_version_cid_raises_and_saves_nothing():
    pdf_cid = store_pdf(PDF_ONE)
    canonical = new_version_cid()

    for bad in ("", "abc", "not a cid", canonical.upper(), canonical[:-3], None, 12, b"bytes"):
        with pytest.raises(checks.InvalidVersionCid):
            checks.save_version_text(bad, pdf_cid)
        with pytest.raises(checks.InvalidVersionCid):
            checks.save_paragraphs(bad, ["text"])

    assert rows(canonical) == []


def test_a_version_cid_in_another_base_is_rejected_as_non_canonical():
    canonical = new_version_cid()
    base58 = CID.decode(canonical).encode("base58btc")

    with pytest.raises(checks.InvalidVersionCid, match="canonical"):
        checks.save_paragraphs(base58, ["text"])


# --- saving paragraphs directly ------------------------------------------------------


def test_save_paragraphs_numbers_and_hashes_the_given_texts():
    version = new_version_cid()

    saved = checks.save_paragraphs(version, ["First  one.", "", "Second\none."])

    assert rows(version) == [
        (version, sha256_hex("First one."), 0, "First one."),
        (version, sha256_hex("Second one."), 1, "Second one."),
    ]
    assert [p.position for p in saved] == [0, 1]


def test_save_paragraphs_rejects_non_strings_before_touching_the_rows():
    version = new_version_cid()
    checks.save_paragraphs(version, ["Keep me."])

    with pytest.raises(TypeError):
        checks.save_paragraphs(version, ["new", 5])

    assert [row[3] for row in rows(version)] == ["Keep me."]


def test_stored_text_is_always_utf8_and_nul_free():
    version = new_version_cid()

    checks.save_paragraphs(version, ["bad \ud800 surrogate and \x00 nul"])

    (row,) = rows(version)
    assert row[3] == "bad � surrogate and nul"


# --- reading ------------------------------------------------------------------------


def test_get_version_text_returns_paragraphs_in_reading_order():
    version = new_version_cid()
    checks.save_version_text(version, store_pdf(PDF_ONE))

    paragraphs = checks.get_version_text(version)

    assert [p.text for p in paragraphs] == PARAGRAPHS_ONE
    assert [p.position for p in paragraphs] == [0, 1, 2, 3]
    assert [p.paragraph_id for p in paragraphs] == [sha256_hex(t) for t in PARAGRAPHS_ONE]


def test_get_version_text_is_empty_for_an_unknown_or_invalid_version():
    assert checks.get_version_text(new_version_cid()) == []
    assert checks.get_version_text("not a cid") == []
    assert checks.get_version_text(None) == []  # type: ignore[arg-type]


def test_many_paragraphs_round_trip_in_order():
    version = new_version_cid()
    texts = [f"Paragraph number {i}." for i in range(250)]

    checks.save_paragraphs(version, texts)

    assert [p.text for p in checks.get_version_text(version)] == texts


# --- concurrency ----------------------------------------------------------------------


def test_concurrent_saves_of_one_version_leave_a_single_consistent_text():
    version = new_version_cid()
    pdf_cid = store_pdf(PDF_ONE)
    errors: list[BaseException] = []

    def save() -> None:
        try:
            checks.save_version_text(version, pdf_cid)
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    checks.ensure_table()
    threads = [threading.Thread(target=save) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert [row[3] for row in rows(version)] == PARAGRAPHS_ONE


# --- table shape and module discovery ------------------------------------------------


def test_table_has_the_specified_columns_and_a_primary_key_on_version_and_position():
    checks.ensure_table()
    inspector = inspect(db.engine)

    columns = {c["name"]: c for c in inspector.get_columns("version_texts")}
    primary_key = inspector.get_pk_constraint("version_texts")["constrained_columns"]

    assert list(columns) == ["version_cid", "paragraph_id", "position", "text"]
    assert all(not c["nullable"] for c in columns.values())
    assert {name: str(c["type"]) for name, c in columns.items()} == {
        "version_cid": "TEXT",
        "paragraph_id": "TEXT",
        "position": "INTEGER",
        "text": "TEXT",
    }
    assert set(primary_key) == {"version_cid", "position"}


def test_module_is_discovered_and_registers_version_texts_and_its_routes():
    app = FastAPI()

    loaded = module_loader.load_modules(app)

    assert checks in loaded
    assert "version_texts" in db.Base.metadata.tables
    # The extraction bug added the advisory checks report route to this package.
    assert hasattr(checks, "router")
    assert "/v1/papers/{paper_id}/v/{n}/checks" in app.openapi()["paths"]


def test_create_app_creates_the_version_texts_table():
    from app.main import create_app

    create_app()

    assert inspect(db.engine).has_table("version_texts")
