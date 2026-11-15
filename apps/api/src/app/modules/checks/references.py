"""Extracting the references from a version's text (feature 67).

::

    from app.modules import checks

    refs = checks.extract_references(checks.get_version_text(version_cid))
    for ref in refs:
        ref.index, ref.text, ref.doi

The input is the paragraphs saved in ``version_texts`` (or plain strings).
Extraction works on the *reference list*, the bibliography at the end of a
paper, not on citations in the body: ``references_total`` is the number of
entries in that list.

Finding the list
    It starts after the last paragraph that is a references heading
    ("References", "7. Bibliography", "WORKS CITED", ...), and ends at the
    next heading of a trailing section ("Appendix", "Acknowledgements",
    ...) or the end of the text.  A text with no such heading has no
    references.  A heading the PDF extractor left in the same paragraph as
    a numbered first entry (``"References [1] A. Author ..."``) is
    recognized too.

Splitting it into entries
    * Numbered lists (``[1] ... [2] ...`` or ``1. ... 2. ...``) are split at
      the numbers, whether each entry is a paragraph of its own or several
      share one (the extractor only recovers paragraph breaks heuristically).
      A number counts only as the *next* in sequence, starting from 1, so a
      stray ``[3]`` inside an entry does not split it.  An entry that runs
      over a page break stays whole.
    * Otherwise (author-year lists) each paragraph is one entry.  A paragraph
      with no letters in it is page furniture (a page number) and is dropped.

DOIs
    The first DOI in an entry (``10.NNNN/suffix``, bare or in a ``doi:`` /
    ``https://doi.org/`` form) is its DOI, lowercased.  Trailing sentence
    punctuation is not part of the DOI, but a closing bracket is when the
    DOI opened one (``10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O``).

Known limits, all of which come from the text layer rather than from the list:
a DOI wrapped over two lines is cut at the break, a reference that spans a
page break in an unnumbered list counts as two, and running headers inside
the list count as entries.  Extraction is deterministic: the same text always
gives the same entries.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Optional, Union

from .paragraphs import Paragraph

__all__ = ["Reference", "extract_references", "find_doi"]


@dataclass(frozen=True)
class Reference:
    """One entry of a version's reference list."""

    #: 0-based position in the list.
    index: int
    #: The entry's text, whitespace collapsed, without its ``[n]`` / ``n.`` number.
    text: str
    #: The entry's DOI in lowercase, or ``None`` when it quotes none.
    doi: Optional[str]


# An optional section number ("7.", "VII.", "A)") then the heading words.
_NUMBER = r"(?:(?:\d+(?:\.\d+)*[.)]?|[A-Za-z]{1,4}[.)])\s+)?"
_REFERENCES_WORDS = (
    r"(?:references?(?:\s+list|\s+and\s+notes)?|notes\s+and\s+references"
    r"|bibliography|works\s+cited|literature\s+cited)"
)
_HEADING = re.compile(rf"^\W*{_NUMBER}{_REFERENCES_WORDS}\W*$", re.IGNORECASE)
# The heading and a numbered first entry in one paragraph.  Only when the
# rest opens with the number 1, or a body paragraph that begins with the word
# "References" ("References to earlier work are ...") would be taken for one.
_HEADING_THEN_ENTRY = re.compile(
    rf"^\W*{_NUMBER}{_REFERENCES_WORDS}\s*[:.]?\s+(?P<rest>(?:\[\s*1\s*\]|1[.)]\s).*)$",
    re.IGNORECASE | re.DOTALL,
)

# Headings of the sections that commonly follow a reference list.  Whole
# paragraphs only, and short ones: an entry such as "Funding for science.
# Nature 2020" must not end the list.
_TRAILING_WORDS = (
    r"(?:appendix\b.{0,60}|appendices|supplementary\s+(?:material|information|data)s?"
    r"|supporting\s+information|acknowledge?ments?|author\s+contributions?"
    r"|funding(?:\s+(?:statement|information))?|conflicts?\s+of\s+interests?"
    r"|competing\s+interests?|data\s+availability(?:\s+statement)?"
    r"|about\s+the\s+authors?)"
)
_TRAILING_HEADING = re.compile(rf"^\W*{_NUMBER}{_TRAILING_WORDS}\W*$", re.IGNORECASE)
_TRAILING_MAX = 80

_BRACKET_MARKER = re.compile(r"\[\s*(\d{1,4})\s*\]")
# "12." / "12)" opening an entry: after whitespace or at the start, before
# whitespace.  The sequence check below does the rest of the disambiguation.
_DOTTED_MARKER = re.compile(r"(?<!\S)(\d{1,4})[.)](?=\s)")

# ``10.`` + registrant code + ``/`` + suffix.  The suffix runs to whitespace;
# trailing punctuation is trimmed by ``_trim_doi``.  Linear in the input.
_DOI = re.compile(r"\b10\.\d{4,9}/\S+", re.IGNORECASE)
_BRACKETS = {")": "(", "]": "[", "}": "{", ">": "<"}
_TRAILING_PUNCTUATION = ".,;:!?'\"“”‘’"


def extract_references(
    paragraphs: Iterable[Union[Paragraph, str]],
) -> list[Reference]:
    """The entries of the reference list in ``paragraphs``, in order.

    Args:
        paragraphs: the version's paragraphs in reading order, as
            :class:`~app.modules.checks.paragraphs.Paragraph` objects (what
            :func:`~app.modules.checks.get_version_text` returns) or strings.

    Returns:
        The references (empty when the text has no reference list).

    Raises:
        TypeError: if an item is neither a ``Paragraph`` nor a string.
    """
    texts = [_text_of(item) for item in paragraphs]
    section = _reference_section(texts)
    return [
        Reference(index=i, text=text, doi=find_doi(text))
        for i, text in enumerate(_split_entries(section))
    ]


def find_doi(text: str) -> Optional[str]:
    """The first DOI in ``text`` (lowercase, without trailing punctuation), or ``None``."""
    for match in _DOI.finditer(text):
        doi = _trim_doi(match.group(0))
        # The pattern guarantees a "/"; trimming can leave an empty suffix ("10.1234/.").
        if doi.split("/", 1)[1]:
            return doi.lower()
    return None


def _text_of(item: object) -> str:
    if isinstance(item, Paragraph):
        return item.text
    if isinstance(item, str):
        return item
    raise TypeError(f"paragraph must be a Paragraph or a string, got {type(item).__name__}")


def _reference_section(texts: list[str]) -> list[str]:
    """The paragraphs of the reference list, without its heading."""
    start: Optional[int] = None
    first_entry: Optional[str] = None
    for i, text in enumerate(texts):
        stripped = text.strip()
        if _HEADING.match(stripped):
            start, first_entry = i + 1, None
            continue
        merged = _HEADING_THEN_ENTRY.match(stripped)
        if merged is not None:
            start, first_entry = i + 1, merged.group("rest")
    if start is None:
        return []

    section = [first_entry] if first_entry is not None else []
    for text in texts[start:]:
        stripped = text.strip()
        if len(stripped) <= _TRAILING_MAX and _TRAILING_HEADING.match(stripped):
            break
        section.append(text)
    return section


def _split_entries(section: list[str]) -> list[str]:
    """Cut the reference list's paragraphs into one text per entry."""
    if not section:
        return []
    joined = "\n".join(section)

    numbered = _split_numbered(joined, _BRACKET_MARKER, minimum=1)
    if numbered is None:
        numbered = _split_numbered(joined, _DOTTED_MARKER, minimum=2)
    if numbered is not None:
        return numbered

    entries = (" ".join(paragraph.split()) for paragraph in section)
    return [entry for entry in entries if any(char.isalpha() for char in entry)]


def _split_numbered(text: str, marker: re.Pattern[str], *, minimum: int) -> Optional[list[str]]:
    """Split ``text`` at ``marker`` numbers 1, 2, 3, ... or ``None`` if it has too few.

    A marker is accepted only when its number is the next in sequence, so
    ``[3]`` or ``12.`` inside an entry is left where it is.  Text before the
    first accepted marker is not part of any entry.
    """
    accepted: list[re.Match[str]] = []
    for match in marker.finditer(text):
        if int(match.group(1)) == len(accepted) + 1:
            accepted.append(match)
    if len(accepted) < minimum:
        return None

    entries: list[str] = []
    for current, following in zip(accepted, [*accepted[1:], None]):
        end = following.start() if following is not None else len(text)
        entry = " ".join(text[current.end():end].split())
        # An empty slice is a marker with nothing after it ("[2] [3] ..."): not an entry.
        if any(char.isalpha() for char in entry):
            entries.append(entry)
    return entries


def _trim_doi(candidate: str) -> str:
    """``candidate`` without trailing punctuation and unbalanced closing brackets."""
    doi = candidate
    while doi:
        last = doi[-1]
        if last in _TRAILING_PUNCTUATION:
            doi = doi[:-1]
        elif last in _BRACKETS and doi.count(last) > doi.count(_BRACKETS[last]):
            doi = doi[:-1]
        else:
            break
    return doi
