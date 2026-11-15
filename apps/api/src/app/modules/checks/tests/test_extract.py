"""Tests for PDF text extraction and paragraph segmentation (feature 65).

PDFs are built byte by byte (``pdfs.py``).  Text layout is controlled exactly,
so each test pins one of the signals paragraphs are recovered from: vertical
gaps, the jump to the next column, the short sentence-final line, blank lines.
"""

from __future__ import annotations

import io

import pytest
from pypdf import PdfReader, PdfWriter

from app.modules.checks import PdfTextError, extract_paragraphs, paragraph_id
from app.modules.checks import extract as extract_module

from .pdfs import build_pdf, lines_stream, simple_pdf, stack


def texts(pdf) -> list[str]:
    return [p.text for p in extract_paragraphs(pdf)]


# Lines of about the same width, none ending a sentence: a justified paragraph.
FULL = [
    "We study the effect of widgets on gadgets in a controlled",
    "laboratory setting, using the protocol described by the",
    "original authors and several additional controls that we",
    "introduce here for the first time in this experiment",
]


def test_vertical_gaps_and_page_breaks_separate_paragraphs():
    pdf = simple_pdf(
        [
            (720, "Introduction"),
            (700, "We study the effect of widgets on"),
            (686, "gadgets in a controlled setting."),
            (658, "Second paragraph starts here and"),
            (644, "continues on this line."),
        ],
        [(720, "and the next page starts here.")],
    )

    assert texts(pdf) == [
        "Introduction",
        "We study the effect of widgets on gadgets in a controlled setting.",
        "Second paragraph starts here and continues on this line.",
        "and the next page starts here.",
    ]


def test_positions_and_ids_follow_reading_order():
    pdf = simple_pdf([(720, "One."), (680, "Two."), (640, "Three.")])

    paragraphs = extract_paragraphs(pdf)

    assert [p.position for p in paragraphs] == [0, 1, 2]
    assert [p.paragraph_id for p in paragraphs] == [
        paragraph_id("One."),
        paragraph_id("Two."),
        paragraph_id("Three."),
    ]


def test_a_sparse_title_page_splits_on_gaps_without_a_measurable_line_pitch():
    pdf = simple_pdf([(700, "A Study of Widgets"), (650, "Jane Doe and John Roe"), (630, "Somewhere University")])

    assert texts(pdf) == ["A Study of Widgets", "Jane Doe and John Roe", "Somewhere University"]


def test_a_double_spaced_page_measures_its_own_line_pitch():
    # Every gap is 24pt: twice the usual leading, but the page's own pitch.
    pdf = simple_pdf(stack([*FULL, "and it ends here."], pitch=24))

    assert texts(pdf) == [" ".join([*FULL, "and it ends here."])]


def test_evenly_spaced_lines_are_one_paragraph_joined_by_single_spaces():
    pdf = simple_pdf(stack([*FULL, "and it ends here."]))

    assert texts(pdf) == [" ".join([*FULL, "and it ends here."])]


def test_a_short_sentence_final_line_ends_an_indent_style_paragraph():
    # No extra spacing between paragraphs, as in most LaTeX papers.
    first = [*FULL[:3], "That is the end of it."]
    second = [*FULL[1:3], "A second, shorter paragraph."]
    pdf = simple_pdf(stack([*first, *second]))

    assert texts(pdf) == [" ".join(first), " ".join(second)]


def test_a_full_width_line_that_ends_a_sentence_does_not_split():
    # A justified line can end with a full stop and still continue.
    lines = [FULL[0], FULL[1].rstrip() + ".", FULL[2], FULL[3]]

    assert texts(simple_pdf(stack(lines))) == [" ".join(lines)]


def test_two_columns_keep_reading_order_and_split_at_the_column_jump():
    left = stack([f"left column line {i} runs on without ending" for i in range(8)])
    right = stack([f"right column line {i} runs on without ending" for i in range(8)])
    # The PDF draws the whole left column, then the whole right one.
    pdf = build_pdf([lines_stream(left, x=72) + "\n" + lines_stream(right, x=320)])

    result = texts(pdf)

    assert len(result) == 2
    assert result[0].startswith("left column line 0") and result[0].endswith("line 7 runs on without ending")
    assert result[1].startswith("right column line 0")


def test_blank_lines_in_the_text_separate_paragraphs_when_positions_are_unusable():
    class Page:
        def extract_text(self, visitor_text=None):
            return "first paragraph\nstill the first\n\nsecond paragraph\n"

    lines = extract_module._page_lines(Page())

    assert [line.y for line in lines] == [None] * len(lines)
    assert [b for b in extract_module._blocks([lines])] == [
        "first paragraph still the first",
        "second paragraph",
    ]


def test_scaled_matrices_give_the_effective_font_size():
    # LaTeX-style: ``Tf 1`` with the real size in the text matrix.  A 3 unit
    # superscript offset is under half the 11pt size, so it is the same line;
    # read as a 1pt font it would look like a jump up the page and split.
    stream = (
        "q 1 0 0 1 72 0 cm BT /F1 1 Tf\n"
        "11 0 0 11 0 700 Tm (Energy scales as x) Tj\n"
        "11 0 0 11 70 703 Tm (2) Tj\n"
        "11 0 0 11 80 700 Tm ( in the first regime) Tj\n"
        "11 0 0 11 0 686 Tm (and more text on the next line) Tj\n"
        "ET Q"
    )

    result = texts(build_pdf([stream]))

    assert len(result) == 1
    assert result[0].startswith("Energy scales as x")
    assert result[0].endswith("and more text on the next line")


def test_tj_arrays_and_kerning_are_extracted_as_words():
    stream = (
        "BT /F1 11 Tf 1 0 0 1 72 700 Tm "
        "[(Hel) -20 (lo) -400 (wor) 15 (ld)] TJ ET"
    )

    assert texts(build_pdf([stream])) == ["Hello world"]


def test_non_ascii_text_survives():
    assert texts(simple_pdf([(700, "A café naïve résumé.")])) == [
        "A café naïve résumé."
    ]


def test_same_words_wrapped_differently_get_the_same_paragraph_id():
    words = "We study the effect of widgets on gadgets in a controlled laboratory setting."
    wrapped_wide = ["We study the effect of widgets on gadgets in a", "controlled laboratory setting."]
    wrapped_narrow = [
        "We study the effect of",
        "widgets on gadgets in a",
        "controlled laboratory setting.",
    ]

    wide = extract_paragraphs(simple_pdf(stack(wrapped_wide)))
    narrow = extract_paragraphs(simple_pdf(stack(wrapped_narrow)))

    assert [p.text for p in wide] == [p.text for p in narrow] == [words]
    assert wide[0].paragraph_id == narrow[0].paragraph_id == paragraph_id(words)


def test_extraction_is_deterministic():
    pdf = simple_pdf(stack([*FULL, "End."]), [(700, "Page two.")])

    assert extract_paragraphs(pdf) == extract_paragraphs(pdf)


def test_pdf_without_text_has_no_paragraphs():
    assert extract_paragraphs(build_pdf(["", ""])) == []

    blank = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(blank)
    assert extract_paragraphs(blank.getvalue()) == []


def test_pdf_with_zero_pages_has_no_paragraphs():
    assert extract_paragraphs(build_pdf([])) == []


def test_accepts_bytes_bytearray_memoryview_and_file_objects(tmp_path):
    pdf = simple_pdf([(700, "Same text everywhere.")])
    path = tmp_path / "paper.pdf"
    path.write_bytes(pdf)
    expected = ["Same text everywhere."]

    assert texts(pdf) == expected
    assert texts(bytearray(pdf)) == expected
    assert texts(memoryview(pdf)) == expected
    assert texts(io.BytesIO(pdf)) == expected
    with path.open("rb") as handle:
        assert texts(handle) == expected


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"not a pdf at all",
        b"%PDF-1.4\nthis is nonsense\n%%EOF\n",
        bytes(range(256)) * 8,
    ],
)
def test_unreadable_input_raises_pdf_text_error(data):
    with pytest.raises(PdfTextError):
        extract_paragraphs(data)


def test_text_mode_streams_raise_pdf_text_error():
    with pytest.raises(PdfTextError):
        extract_paragraphs(io.StringIO("%PDF-1.4"))


def _encrypted(pdf: bytes, *, user_password: str, owner_password: str) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf)))
    writer.encrypt(user_password=user_password, owner_password=owner_password, algorithm="AES-128")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_pdf_encrypted_with_an_empty_user_password_is_readable():
    # The common "restricted editing" PDF: opens for anyone, owner password set.
    pdf = _encrypted(
        simple_pdf([(700, "Readable despite restrictions.")]),
        user_password="",
        owner_password="owner-secret",
    )

    assert texts(pdf) == ["Readable despite restrictions."]


def test_pdf_that_needs_a_password_raises_pdf_text_error():
    pdf = _encrypted(
        simple_pdf([(700, "Secret.")]), user_password="open-sesame", owner_password="owner"
    )

    with pytest.raises(PdfTextError, match="password"):
        extract_paragraphs(pdf)


def test_errors_name_the_failing_page(monkeypatch):
    def boom(page):
        raise KeyError("/Font")

    monkeypatch.setattr(extract_module, "_page_lines", boom)

    with pytest.raises(PdfTextError, match=r"page 1"):
        extract_paragraphs(simple_pdf([(700, "Text.")]))


def test_memory_errors_are_not_swallowed(monkeypatch):
    def boom(page):
        raise MemoryError

    monkeypatch.setattr(extract_module, "_page_lines", boom)

    with pytest.raises(MemoryError):
        extract_paragraphs(simple_pdf([(700, "Text.")]))
