"""Tests for the references check (feature 67).

The check extracts the reference list from a version's saved text and saves
``references_total`` and ``references_unresolved`` to ``check_results``,
resolving DOIs through Crossref only when ``CROSSREF_ENABLED=1``.

Covers finding and splitting the list (numbered and author-year styles, the
heading variants, trailing sections), reading DOIs, the persisted row and its
upsert semantics (both columns in one write, other checks' columns untouched),
the Crossref switch (off: no client, no request, ``NULL``; on: 404 and
DOI-less references are unresolved, outages save nothing), and one run from a
real PDF through ``version_texts``.

Crossref is never contacted: requests go to ``httpx.MockTransport``, and a
test that must prove "no network" makes creating a client an error.

Isolation: tests share the worker's tables, so each uses a fresh random
version cid and asserts on its own rows.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from scholium_record_core import compute_record_id
from sqlalchemy import text

from app import db
from app.modules import checks, content
from app.modules.checks import crossref

from .pdfs import build_pdf, lines_stream

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


def stored_row(version_cid: str) -> tuple | None:
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
    return (version, similarity, total, unresolved, None if matched is None else bool(matched))


@pytest.fixture(autouse=True)
def crossref_off(monkeypatch):
    """Start every test with Crossref disabled, whatever the ambient environment."""
    monkeypatch.delenv("CROSSREF_ENABLED", raising=False)


@pytest.fixture
def crossref_on(monkeypatch):
    monkeypatch.setenv("CROSSREF_ENABLED", "1")


@pytest.fixture
def no_network(monkeypatch):
    """Creating an HTTP client at all is a failure: nothing may leave the process."""

    def boom(*args, **kwargs):
        raise AssertionError("an HTTP client was created while Crossref is disabled")

    monkeypatch.setattr(crossref.httpx, "Client", boom)


class FakeCrossref:
    """A mock Crossref: ``known`` DOIs answer 200, everything else 404."""

    def __init__(self, known=(), *, status_for=None, raises=None):
        self.known = {doi.lower() for doi in known}
        self.status_for = status_for or {}
        self.raises = raises
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.raises is not None:
            raise self.raises
        doi = request.url.path.removeprefix("/works/").removesuffix("/agency")
        if doi in self.status_for:
            return httpx.Response(self.status_for[doi])
        if doi.lower() in self.known:
            return httpx.Response(200, json={"status": "ok"})
        return httpx.Response(404)

    @property
    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    @property
    def asked(self) -> list[str]:
        return [r.url.path.removeprefix("/works/").removesuffix("/agency") for r in self.requests]


def save_text(version_cid: str, *paragraphs: str) -> None:
    checks.save_paragraphs(version_cid, paragraphs)


# --- finding the reference list ------------------------------------------------------


def test_each_paragraph_after_the_heading_is_a_reference():
    refs = checks.extract_references(
        [
            "Introduction text that cites Smith (2020).",
            "References",
            "Smith, J. (2020). Widgets. Journal of Widgets, 1(2), 3-4.",
            "Jones, K. (2021). Gadgets. Gadget Letters, 5, 6-7.",
        ]
    )

    assert [r.index for r in refs] == [0, 1]
    assert refs[0].text.startswith("Smith, J. (2020)")
    assert refs[1].text.startswith("Jones, K. (2021)")


def test_a_text_without_a_references_heading_has_no_references():
    assert checks.extract_references(["Just a body.", "[1] looks like a ref but is not."]) == []
    assert checks.extract_references([]) == []


@pytest.mark.parametrize(
    "heading",
    ["References", "REFERENCES", "7. References", "VII. Bibliography", "Works Cited",
     "Literature cited:", "Notes and References", "Reference list", "  References  "],
)
def test_heading_variants_are_recognized(heading):
    refs = checks.extract_references(["Body.", heading, "Smith, J. (2020). Widgets. Press."])

    assert len(refs) == 1


def test_a_body_paragraph_that_starts_with_the_word_references_is_not_a_heading():
    refs = checks.extract_references(
        ["References to earlier work are collected below.", "Smith, J. (2020). Widgets."]
    )

    assert refs == []


def test_the_last_heading_wins_over_an_earlier_mention():
    refs = checks.extract_references(
        [
            "References",  # e.g. a table of contents line
            "Body text.",
            "References",
            "Smith, J. (2020). Widgets.",
        ]
    )

    assert [r.text for r in refs] == ["Smith, J. (2020). Widgets."]


def test_the_list_ends_at_a_trailing_section_heading():
    refs = checks.extract_references(
        [
            "References",
            "Smith, J. (2020). Widgets.",
            "Jones, K. (2021). Gadgets.",
            "Appendix A: Proofs",
            "Lemma 1 holds. Therefore the claim.",
            "Acknowledgements",
            "We thank the reviewers.",
        ]
    )

    assert len(refs) == 2


def test_a_reference_that_merely_starts_like_a_trailing_heading_does_not_end_the_list():
    refs = checks.extract_references(
        [
            "References",
            "Smith, J. (2020). Widgets.",
            "Funding for science. Nature, 2020.",
            "Jones, K. (2021). Gadgets.",
        ]
    )

    assert len(refs) == 3


def test_a_heading_in_the_same_paragraph_as_a_numbered_first_entry():
    refs = checks.extract_references(
        ["Body.", "References [1] A. Author. Widgets. 2020. [2] B. Author. Gadgets. 2021."]
    )

    assert [r.text for r in refs] == ["A. Author. Widgets. 2020.", "B. Author. Gadgets. 2021."]


def test_page_numbers_inside_the_list_are_not_references():
    refs = checks.extract_references(
        ["References", "Smith, J. (2020). Widgets.", "12", "Jones, K. (2021). Gadgets."]
    )

    assert len(refs) == 2


def test_paragraph_objects_and_strings_are_both_accepted():
    paragraphs = checks.build_paragraphs(["References", "Smith, J. (2020). Widgets."])

    assert len(checks.extract_references(paragraphs)) == 1


def test_other_item_types_are_type_errors():
    with pytest.raises(TypeError):
        checks.extract_references(["References", 3])  # type: ignore[list-item]


# --- splitting the list --------------------------------------------------------------


def test_numbered_entries_in_separate_paragraphs_lose_their_numbers():
    refs = checks.extract_references(
        ["References", "[1] A. Author. Widgets. 2020.", "[2] B. Author. Gadgets. 2021."]
    )

    assert [r.text for r in refs] == ["A. Author. Widgets. 2020.", "B. Author. Gadgets. 2021."]


def test_numbered_entries_sharing_one_paragraph_are_split():
    refs = checks.extract_references(
        ["References", "[1] A. Author. Widgets. 2020. [2] B. Author. Gadgets. 2021. [3] C. Author. 2022."]
    )

    assert len(refs) == 3


def test_a_stray_bracketed_number_inside_an_entry_does_not_split_it():
    refs = checks.extract_references(
        [
            "References",
            "[1] A. Author. Widgets, see also [7] for details. 2020.",
            "[2] B. Author. Gadgets. 2021.",
        ]
    )

    assert len(refs) == 2
    assert "[7]" in refs[0].text


def test_dotted_numbers_split_a_list_whose_entries_share_a_paragraph():
    refs = checks.extract_references(
        ["References", "1. A. Author. Widgets. 2020. 2. B. Author. Gadgets. 2021. 3. C. Author. 2022."]
    )

    assert len(refs) == 3
    assert refs[1].text == "B. Author. Gadgets. 2021."


def test_one_dotted_number_is_not_a_numbered_list():
    refs = checks.extract_references(["References", "Smith, J. 1. Widgets.", "Jones, K. Gadgets."])

    assert len(refs) == 2


def test_an_entry_split_over_a_page_break_stays_whole_in_a_numbered_list():
    refs = checks.extract_references(
        ["References", "[1] A. Author. A very long title that runs", "over the page. 2020.", "[2] B. Author. 2021."]
    )

    assert len(refs) == 2
    assert refs[0].text == "A. Author. A very long title that runs over the page. 2020."


def test_whitespace_inside_entries_is_collapsed():
    refs = checks.extract_references(["References", "[1] A.   Author.\n Widgets.\t2020."])

    assert refs[0].text == "A. Author. Widgets. 2020."


# --- reading DOIs --------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry, doi",
    [
        ("Smith. Widgets. doi:10.1000/abc.123.", "10.1000/abc.123"),
        ("Smith. Widgets. https://doi.org/10.1000/abc.123", "10.1000/abc.123"),
        ("Smith. Widgets. DOI: 10.1000/ABC.123, 2020.", "10.1000/abc.123"),
        ("Smith. Widgets. (doi:10.1000/abc)", "10.1000/abc"),
        ("Smith. Widgets. [https://dx.doi.org/10.1000/abc].", "10.1000/abc"),
        ("Smith. Widgets. 10.1016/S0021-9797(03)00123-4;", "10.1016/s0021-9797(03)00123-4"),
        (
            "Smith. Widgets. 10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O.",
            "10.1002/(sici)1097-4571(199806)49:8<693::aid-asi4>3.0.co;2-o",
        ),
        ("Smith. Widgets. 10.1000/first and 10.2000/second", "10.1000/first"),
    ],
)
def test_the_first_doi_is_read_and_trimmed(entry, doi):
    assert checks.find_doi(entry) == doi


@pytest.mark.parametrize(
    "entry",
    [
        "Smith. Widgets. 2020.",
        "Smith. Widgets. 10.1000",  # no suffix
        "Smith. Widgets. 10.1234/.",  # nothing left once punctuation is trimmed
        "Smith. Widgets. 10.100/abc",  # registrant code too short to be a DOI prefix
    ],
)
def test_entries_without_a_doi_have_none(entry):
    assert checks.find_doi(entry) is None


def test_references_carry_their_doi():
    refs = checks.extract_references(
        ["References", "[1] A. Author. 2020. doi:10.1000/abc.", "[2] B. Author. 2021."]
    )

    assert [r.doi for r in refs] == ["10.1000/abc", None]


# --- saving: Crossref off ------------------------------------------------------------


def test_both_counts_are_saved_without_crossref_and_nothing_counts_as_resolved(no_network):
    cid = new_version_cid()
    save_text(
        cid,
        "Body.",
        "References",
        "[1] A. Author. 2020. doi:10.1000/abc.",  # has a DOI, but Crossref is not asked
        "[2] B. Author. 2021.",
        "[3] C. Author. 2022. https://doi.org/10.2000/xyz",
    )

    result = checks.save_reference_check(cid)

    # Not confirmed by Crossref means unresolved, whether or not a DOI is quoted.
    assert result == checks.ReferenceCheck(total=3, unresolved=3)
    assert stored_row(cid) == (cid, None, 3, 3, None)


def test_an_injected_client_does_not_enable_the_network():
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. 2020. doi:10.1000/abc.")
    fake = FakeCrossref(known=["10.1000/abc"])

    checks.save_reference_check(cid, client=fake.client)

    assert fake.requests == []
    assert stored_row(cid)[2:4] == (1, 1)


@pytest.mark.parametrize("value", ["", "0", "true", "yes", "2", "on"])
def test_only_the_value_1_enables_crossref(monkeypatch, value):
    monkeypatch.setenv("CROSSREF_ENABLED", value)

    assert checks.crossref_enabled() is False


def test_the_value_1_enables_crossref(monkeypatch):
    monkeypatch.setenv("CROSSREF_ENABLED", " 1 ")

    assert checks.crossref_enabled() is True


def test_the_flag_is_read_on_every_call(monkeypatch):
    monkeypatch.setenv("CROSSREF_ENABLED", "1")
    assert checks.crossref_enabled() is True

    monkeypatch.setenv("CROSSREF_ENABLED", "0")
    assert checks.crossref_enabled() is False


def test_a_version_with_no_saved_text_has_zero_references(no_network):
    cid = new_version_cid()

    assert checks.save_reference_check(cid) == checks.ReferenceCheck(total=0, unresolved=0)
    assert stored_row(cid)[2:4] == (0, 0)


def test_a_text_without_a_reference_list_has_zero_references(no_network):
    cid = new_version_cid()
    save_text(cid, "Only a body.", "Nothing cited.")

    assert checks.save_reference_check(cid).total == 0


# --- saving: Crossref on -------------------------------------------------------------


def test_unresolved_counts_references_without_a_doi_and_dois_crossref_does_not_know(crossref_on):
    cid = new_version_cid()
    save_text(
        cid,
        "References",
        "[1] A. Author. 2020. doi:10.1000/known",
        "[2] B. Author. 2021. doi:10.1000/unknown",
        "[3] C. Author. 2022. No identifier at all.",
        "[4] D. Author. 2023. https://doi.org/10.2000/known2",
    )
    fake = FakeCrossref(known=["10.1000/known", "10.2000/known2"])

    result = checks.save_reference_check(cid, client=fake.client)

    assert result == checks.ReferenceCheck(total=4, unresolved=2)
    assert stored_row(cid) == (cid, None, 4, 2, None)


def test_every_reference_resolving_gives_zero_unresolved(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a", "[2] B. Author. doi:10.1000/b")
    fake = FakeCrossref(known=["10.1000/a", "10.1000/b"])

    assert checks.save_reference_check(cid, client=fake.client).unresolved == 0


def test_a_doi_cited_twice_is_looked_up_once_but_counted_per_reference(crossref_on):
    cid = new_version_cid()
    save_text(
        cid,
        "References",
        "[1] A. Author. doi:10.1000/dup",
        "[2] B. Author. https://doi.org/10.1000/DUP",
        "[3] C. Author. doi:10.1000/other",
    )
    fake = FakeCrossref(known=[])

    result = checks.save_reference_check(cid, client=fake.client)

    assert sorted(fake.asked) == ["10.1000/dup", "10.1000/other"]
    assert result == checks.ReferenceCheck(total=3, unresolved=3)


def test_dois_are_asked_about_at_the_agency_endpoint_with_a_quoted_path(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. 10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O")
    fake = FakeCrossref(known=[])

    checks.save_reference_check(cid, client=fake.client)

    (request,) = fake.requests
    assert request.method == "GET"
    assert request.url.host == "api.crossref.org"
    assert request.url.path.endswith("/agency")
    assert "<" not in request.url.raw_path.decode() and ">" not in request.url.raw_path.decode()


def test_no_doi_means_no_request_even_when_enabled(crossref_on, no_network):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. 2020.", "[2] B. Author. 2021.")

    # ``no_network`` would raise if a client were created for the (absent) lookups.
    assert checks.save_reference_check(cid) == checks.ReferenceCheck(total=2, unresolved=2)


def test_an_empty_reference_list_has_zero_unresolved_when_enabled(crossref_on):
    cid = new_version_cid()
    save_text(cid, "Only a body.")

    assert checks.save_reference_check(cid) == checks.ReferenceCheck(total=0, unresolved=0)


def test_dois_beyond_the_lookup_limit_are_not_asked_about_and_count_as_unresolved(
    crossref_on, monkeypatch
):
    monkeypatch.setattr(crossref, "MAX_LOOKUPS", 2)
    cid = new_version_cid()
    save_text(cid, "References", *(f"[{n}] Author. doi:10.1000/r{n}" for n in range(1, 5)))
    fake = FakeCrossref(known=[f"10.1000/r{n}" for n in range(1, 5)])

    result = checks.save_reference_check(cid, client=fake.client)

    assert fake.asked == ["10.1000/r1", "10.1000/r2"]
    assert result == checks.ReferenceCheck(total=4, unresolved=2)


# --- Crossref failures are not verdicts ----------------------------------------------


@pytest.mark.parametrize("status", [429, 500, 502, 503, 408])
def test_a_server_failure_or_rate_limit_raises_and_saves_nothing(crossref_on, status):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a", "[2] B. Author. doi:10.1000/b")
    fake = FakeCrossref(known=["10.1000/a"], status_for={"10.1000/b": status})

    with pytest.raises(checks.CrossrefError):
        checks.save_reference_check(cid, client=fake.client)

    assert stored_row(cid) is None


@pytest.mark.parametrize(
    "error",
    [httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), httpx.ConnectTimeout("slow")],
)
def test_an_unreachable_crossref_raises_and_saves_nothing(crossref_on, error):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a")
    fake = FakeCrossref(raises=error)

    with pytest.raises(checks.CrossrefError):
        checks.save_reference_check(cid, client=fake.client)

    assert stored_row(cid) is None


def test_a_failed_run_leaves_the_previous_counts_standing(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a")
    checks.save_reference_check(cid, client=FakeCrossref(known=["10.1000/a"]).client)
    assert stored_row(cid)[2:4] == (1, 0)

    with pytest.raises(checks.CrossrefError):
        checks.save_reference_check(cid, client=FakeCrossref(status_for={"10.1000/a": 503}).client)

    assert stored_row(cid)[2:4] == (1, 0)


def test_a_404_is_a_verdict_not_an_error(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/gone")

    result = checks.save_reference_check(cid, client=FakeCrossref().client)

    assert result.unresolved == 1


def test_resolve_dois_returns_a_verdict_per_distinct_doi():
    fake = FakeCrossref(known=["10.1000/a"])

    resolved = checks.resolve_dois(["10.1000/A", "10.1000/b", "10.1000/a", " "], client=fake.client)

    assert resolved == {"10.1000/a": True, "10.1000/b": False}
    assert checks.resolve_dois([], client=fake.client) == {}


def test_resolve_dois_closes_only_a_client_it_created(monkeypatch):
    created = []
    real_client = httpx.Client

    def make(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(FakeCrossref(known=["10.1000/a"]))
        client = real_client(*args, **kwargs)
        created.append(client)
        return client

    monkeypatch.setattr(crossref.httpx, "Client", make)

    checks.resolve_dois(["10.1000/a"])

    assert [c.is_closed for c in created] == [True]
    injected = FakeCrossref(known=["10.1000/a"]).client
    checks.resolve_dois(["10.1000/a"], client=injected)
    assert injected.is_closed is False


# --- the row -------------------------------------------------------------------------


def test_saving_again_replaces_both_columns_in_the_same_row(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a")
    checks.save_reference_check(cid, client=FakeCrossref().client)
    assert stored_row(cid)[2:4] == (1, 1)

    save_text(cid, "References", "[1] A. Author. doi:10.1000/a", "[2] B. Author. doi:10.1000/b")
    checks.save_reference_check(cid, client=FakeCrossref(known=["10.1000/a", "10.1000/b"]).client)

    assert stored_row(cid)[2:4] == (2, 0)
    with db.SessionLocal() as session:
        count = session.execute(
            text("SELECT COUNT(*) FROM check_results WHERE version_cid = :v"), {"v": cid}
        ).scalar_one()
    assert count == 1


def test_turning_crossref_off_replaces_a_stale_resolved_count(monkeypatch):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a")
    monkeypatch.setenv("CROSSREF_ENABLED", "1")
    checks.save_reference_check(cid, client=FakeCrossref(known=["10.1000/a"]).client)
    assert stored_row(cid)[2:4] == (1, 0)

    monkeypatch.setenv("CROSSREF_ENABLED", "0")
    checks.save_reference_check(cid)

    # The earlier "resolved" verdict does not outlive the run that did not check it.
    assert stored_row(cid)[2:4] == (1, 1)


def test_the_other_checks_columns_are_left_alone():
    cid = new_version_cid()
    checks.save_check_result(cid, similarity_pct=12.5, metadata_match=True)
    save_text(cid, "References", "[1] A. Author. 2020.")

    checks.save_reference_check(cid)

    assert stored_row(cid) == (cid, 12.5, 1, 1, True)


def test_the_metadata_check_does_not_clear_the_reference_counts():
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. 2020.")
    checks.save_reference_check(cid)

    checks.save_metadata_match(cid, "A Title", "A Title and more")

    assert stored_row(cid) == (cid, None, 1, 1, True)


def test_the_saved_counts_are_readable_through_get_check_result(crossref_on):
    cid = new_version_cid()
    save_text(cid, "References", "[1] A. Author. doi:10.1000/a", "[2] B. Author.")
    checks.save_reference_check(cid, client=FakeCrossref(known=["10.1000/a"]).client)

    row = checks.get_check_result(cid)

    assert (row.references_total, row.references_unresolved) == (2, 1)


@pytest.mark.parametrize("bad", ["", "not-a-cid", None, 7])
def test_an_invalid_version_cid_is_rejected_before_anything_is_saved(bad):
    with pytest.raises(checks.InvalidVersionCid):
        checks.save_reference_check(bad)  # type: ignore[arg-type]


def test_a_non_canonical_cid_is_rejected():
    cid = new_version_cid()

    with pytest.raises(checks.InvalidVersionCid):
        checks.save_reference_check(cid.upper())


# --- from a real PDF -----------------------------------------------------------------


def test_references_are_counted_from_a_pdf_saved_through_version_texts(crossref_on):
    page_one = lines_stream(
        [
            (720, "A Study of Widgets"),
            (700, "Widgets are cited by Smith [1] and Jones [2]."),
            (680, "We conclude that widgets matter."),
        ]
    )
    page_two = lines_stream(
        [
            (720, "References"),
            (690, "[1] A. Author. Widgets. Journal of Widgets, 2020. doi:10.1000/known."),
            (670, "[2] B. Author. Gadgets. Gadget Letters, 2021. doi:10.1000/missing."),
            (650, "[3] C. Author. Gizmos. Gizmo Review, 2022."),
        ]
    )
    pdf_cid = str(content.store_bytes(build_pdf([page_one, page_two]), media_type="application/pdf").cid)
    cid = new_version_cid()
    checks.save_version_text(cid, pdf_cid)
    fake = FakeCrossref(known=["10.1000/known"])

    result = checks.save_reference_check(cid, client=fake.client)

    assert result == checks.ReferenceCheck(total=3, unresolved=2)
    assert sorted(fake.asked) == ["10.1000/known", "10.1000/missing"]
    assert stored_row(cid)[2:4] == (3, 2)
