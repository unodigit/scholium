"""Paragraph cleaning, normalization and stable paragraph ids.

A paragraph's id is the lowercase hex sha256 of its *normalized* text::

    paragraph_id("The  quick\\nbrown fox.") == paragraph_id("The quick brown fox.")

That is the whole contract, and it is permanent: annotations anchor to these
ids (``paragraph_id`` in a ``discussion.post`` anchor) and versions are
compared by them, so changing :func:`normalize_paragraph` would silently
detach every existing anchor.  The tests pin a known digest for that reason.

Two forms of a paragraph's text exist:

* the *stored* form (:func:`clean_text`) is what lands in ``version_texts``
  and is shown to readers: control characters and invisible format
  characters are gone, whitespace is collapsed to single spaces, and the text
  is NFC.  It keeps what the author wrote (``m²`` stays ``m²``);
* the *normalized* form (:func:`normalize_paragraph`) is that text folded
  further by NFKC, so ``ﬁnd`` (ligature) and ``find``, or ``１２`` and ``12``,
  hash alike.  PDF extractors disagree about exactly these things, which is
  what makes the id stable across extractor versions and re-flowed layouts.

Case is *not* folded: changing "Gain" to "gain" is an edit, not noise.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass

__all__ = [
    "Paragraph",
    "build_paragraphs",
    "clean_text",
    "normalize_paragraph",
    "paragraph_id",
]

# Invisible characters PDF text layers produce unpredictably.  They never
# separate words, so they are removed rather than turned into a space.
_INVISIBLE = re.compile("[­​⁠﻿]")
# C0/C1 controls (NUL, tab, newline, form feed, ...).  PostgreSQL cannot store
# NUL in TEXT, and a control character in a PDF is a broken glyph or a layout
# separator, so each becomes a space and is collapsed with the rest.
_CONTROLS = re.compile("[\x00-\x1f\x7f-\x9f]")
# Lone surrogates come out of broken font encodings; they cannot be encoded as
# UTF-8, so neither hashed nor stored.
_SURROGATES = re.compile("[\ud800-\udfff]")


@dataclass(frozen=True)
class Paragraph:
    """One paragraph of a version's text, as stored in ``version_texts``."""

    #: 0-based index in reading order.
    position: int
    #: sha256 hex of the normalized text; equal text gives an equal id
    #: wherever it appears, in any version.
    paragraph_id: str
    #: The stored form of the text (see :func:`clean_text`).
    text: str


def clean_text(text: str) -> str:
    """The stored form of paragraph ``text`` (see the module docstring)."""
    text = _INVISIBLE.sub("", text)
    text = _CONTROLS.sub(" ", text)
    text = _SURROGATES.sub("�", text)
    return " ".join(unicodedata.normalize("NFC", text).split())


def normalize_paragraph(text: str) -> str:
    """The text a paragraph id is computed from.

    Idempotent, and ``normalize_paragraph(clean_text(x)) ==
    normalize_paragraph(x)``, so an id can be recomputed from the stored text.
    """
    folded = unicodedata.normalize("NFKC", clean_text(text))
    return " ".join(folded.split())


def paragraph_id(text: str) -> str:
    """The stable id of a paragraph: sha256 hex of its normalized text."""
    return hashlib.sha256(normalize_paragraph(text).encode("utf-8")).hexdigest()


def build_paragraphs(texts: Iterable[str]) -> list[Paragraph]:
    """Number ``texts`` in order and give each its id.

    Each text is cleaned first.  Texts with nothing left after cleaning are
    dropped, so positions stay contiguous from 0.  A paragraph that occurs
    twice keeps both occurrences (same id, different positions).

    Raises:
        TypeError: if an item is not a string.
    """
    paragraphs: list[Paragraph] = []
    for item in texts:
        if not isinstance(item, str):
            raise TypeError(f"paragraph text must be a string, got {type(item).__name__}")
        text = clean_text(item)
        if not text:
            continue
        paragraphs.append(
            Paragraph(position=len(paragraphs), paragraph_id=paragraph_id(text), text=text)
        )
    return paragraphs
