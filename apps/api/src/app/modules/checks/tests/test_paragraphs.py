"""Tests for paragraph cleaning, normalization and stable ids (feature 65).

The id is ``sha256(normalized text)`` and annotations anchor to it, so the
rule is a permanent contract: ``test_pinned_digests`` fails if a change to
normalization would detach existing anchors.
"""

from __future__ import annotations

import hashlib
import re

import pytest

from app.modules.checks import (
    Paragraph,
    build_paragraphs,
    clean_text,
    normalize_paragraph,
    paragraph_id,
)

SAMPLES = [
    "Hello world",
    "  Leading and   trailing \n\n whitespace\t\there  ",
    "Ligature ﬁnd and ﬂow, full-width １２３, nbsp here",
    "Soft­hyphen and zero​width and bom﻿ gone",
    "Combining é versus precomposed é",
    "Accent ´ spacing ¨ marks",  # NFKC turns these into space + combining mark
    "Superscript m² and fraction ½",
    "NUL\x00 and bell\x07 and C1 \x85 controls",
    " em space 　 ideographic space",
    "Lone surrogate \ud800 in text",
    "Mixed مرحبا right-to-left",
]


def test_paragraph_id_is_sha256_hex_of_the_normalized_text():
    text = "The  quick\nbrown fox."

    pid = paragraph_id(text)

    assert re.fullmatch(r"[0-9a-f]{64}", pid)
    assert pid == hashlib.sha256(b"The quick brown fox.").hexdigest()


def test_pinned_digests():
    # Do not "fix" these: they are the permanent id contract.
    assert paragraph_id("Hello world") == (
        "64ec88ca00b268e5ba1a35678a1b5316d212f4f366b2477232534a8aeca37f3c"
    )
    assert paragraph_id("Hello\n  world ") == paragraph_id("Hello world")
    # NFKC: the fi ligature and the plain letters hash alike.
    assert paragraph_id("ﬁnd") == hashlib.sha256(b"find").hexdigest()


def test_id_ignores_whitespace_layout_and_extractor_noise():
    reference = paragraph_id("We study the effect of widgets on gadgets.")

    variants = [
        "We study the effect of widgets\non gadgets.",
        "  We  study the effect of widgets on gadgets.  ",
        "We study the effect\tof widgets on gadgets.",
        "We study the e­ffect of widgets on gadgets.",
        "We study the eﬀect of widgets on gadgets.",  # ff ligature
        "We study the effect of widgets on gadgets.\x00",
    ]

    assert {paragraph_id(v) for v in variants} == {reference}


def test_id_changes_with_the_words():
    ids = {
        paragraph_id("We study widgets."),
        paragraph_id("We study gadgets."),
        paragraph_id("We study widgets"),  # no full stop
        paragraph_id("we study widgets."),  # case is not folded
        paragraph_id("We study  widgets and gadgets."),
    }

    assert len(ids) == 5


def test_normalize_is_idempotent_and_clean_text_is_transparent_to_it():
    for sample in SAMPLES:
        once = normalize_paragraph(sample)
        assert normalize_paragraph(once) == once, sample
        assert normalize_paragraph(clean_text(sample)) == once, sample
        assert paragraph_id(clean_text(sample)) == paragraph_id(sample), sample


def test_clean_text_produces_storable_text():
    for sample in SAMPLES:
        cleaned = clean_text(sample)
        cleaned.encode("utf-8")  # no lone surrogates
        assert "\x00" not in cleaned
        assert cleaned == cleaned.strip()
        assert "  " not in cleaned
        assert not re.search(r"[\x00-\x1f\x7f-\x9f]", cleaned)


def test_clean_text_keeps_what_the_author_wrote():
    # Display text is not NFKC-folded: only the id is.
    assert clean_text("area in m²") == "area in m²"
    assert clean_text("ﬁnd") == "ﬁnd"
    # Composed and decomposed spellings are one stored form.
    assert clean_text("é") == "é"


def test_clean_text_removes_invisibles_and_splits_on_controls():
    assert clean_text("soft­hyphen") == "softhyphen"
    assert clean_text("zero​width") == "zerowidth"
    assert clean_text("tab\tseparated\nlines") == "tab separated lines"
    assert clean_text("a\x00b") == "a b"
    assert clean_text("bad \ud800 char") == "bad � char"


def test_case_is_preserved_in_stored_text():
    assert clean_text("  Gain   And LOSS ") == "Gain And LOSS"


def test_build_paragraphs_numbers_from_zero_and_drops_empties():
    paragraphs = build_paragraphs(["First.", "   ", "", "\x00​", "Second.\n"])

    assert paragraphs == [
        Paragraph(position=0, paragraph_id=paragraph_id("First."), text="First."),
        Paragraph(position=1, paragraph_id=paragraph_id("Second."), text="Second."),
    ]


def test_build_paragraphs_keeps_repeated_paragraphs_with_a_shared_id():
    paragraphs = build_paragraphs(["Table 1.", "Body.", "Table  1."])

    assert [p.position for p in paragraphs] == [0, 1, 2]
    assert paragraphs[0].paragraph_id == paragraphs[2].paragraph_id
    assert paragraphs[0].paragraph_id != paragraphs[1].paragraph_id


def test_build_paragraphs_stores_cleaned_text_and_hashes_the_normalized_form():
    (paragraph,) = build_paragraphs(["Find ﬁrst  \n m²"])

    assert paragraph.text == "Find ﬁrst m²"
    assert paragraph.paragraph_id == hashlib.sha256("Find first m2".encode()).hexdigest()


def test_build_paragraphs_accepts_any_iterable_and_empty_input():
    assert build_paragraphs(iter(["a", "b"])) == build_paragraphs(["a", "b"])
    assert build_paragraphs([]) == []


@pytest.mark.parametrize("bad", [None, 3, b"bytes", ["nested"]])
def test_build_paragraphs_rejects_non_strings(bad):
    with pytest.raises(TypeError):
        build_paragraphs(["ok", bad])
