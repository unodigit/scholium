"""PDF text extraction and paragraph segmentation.

::

    paragraphs = extract_paragraphs(pdf_bytes)      # list[Paragraph]

Text comes from pypdf in its default ("plain") mode, which follows the order
the PDF draws its text in.  For papers that is reading order, including
two-column layouts, which pypdf's "layout" mode would interleave line by
line.  The cost is that plain mode marks no paragraph breaks, so they are
recovered here from three signals, in decreasing order of reliability:

1. **Vertical position.**  pypdf reports where each piece of text starts
   (``visitor_text``).  A gap well beyond the page's usual line pitch starts a
   paragraph (headings, spaced paragraphs, display equations), and so does the
   text position jumping *up* the page (the next column or block).
2. **A short sentence-final line.**  Most papers separate paragraphs by indent
   alone.  There the last line of a paragraph ends a sentence and falls short
   of the full column width, which is what this checks (line width is
   approximated by character count, against the document's typical full line).
3. **Blank lines** in the extracted text, should the PDF produce any.

Every page break is a paragraph break.  Known limits: a paragraph that spans a
page (or column) break is stored as two; running headers, footers and page
numbers appear as paragraphs of their own; a hyphen at a line end is kept
(``"re- sults"``).  None of these affects id stability: the same PDF always
yields the same paragraphs.
"""

from __future__ import annotations

import io
import math
import re
from collections.abc import Buffer, Sequence
from dataclasses import dataclass
from typing import Any, BinaryIO, Optional, Union

from pypdf import PasswordType, PdfReader

from .errors import PdfTextError
from .paragraphs import Paragraph, build_paragraphs

__all__ = ["extract_paragraphs"]

#: A vertical gap beyond this many usual line pitches starts a paragraph.
_GAP_FACTOR = 1.3
#: A sentence-final line shorter than this fraction of a full line ends its paragraph.
_SHORT_FRACTION = 0.7
#: Offsets under this many font sizes are the same line (super/subscripts).
_SAME_LINE = 0.5
#: Size assumed where the PDF gives none.
_DEFAULT_SIZE = 10.0
#: Line pitch, in font sizes, assumed on pages too sparse to measure one.
_DEFAULT_LEADING = 1.2

_SENTENCE_END = re.compile(r"""[.?!][)\]}"'’”»]*$""")


@dataclass(frozen=True)
class _Line:
    text: str
    #: Baseline height on the page; ``None`` when positions are unavailable.
    y: Optional[float]
    #: Effective font size in page units.
    size: float


def extract_paragraphs(pdf: Union[Buffer, BinaryIO]) -> list[Paragraph]:
    """The paragraphs of a PDF's text, in reading order, with their ids.

    Args:
        pdf: the PDF's bytes, or a seekable binary file object holding them.

    Returns:
        The paragraphs (empty for a PDF without a text layer).

    Raises:
        PdfTextError: if ``pdf`` is not a readable PDF, or needs a password.
    """
    stream = io.BytesIO(bytes(pdf)) if isinstance(pdf, Buffer) else pdf
    page_number = 0
    try:
        reader = PdfReader(stream)
        if reader.is_encrypted and reader.decrypt("") == PasswordType.NOT_DECRYPTED:
            raise PdfTextError("PDF is encrypted with a password")
        pages: list[list[_Line]] = []
        for page_number, page in enumerate(reader.pages, start=1):
            pages.append(_page_lines(page))
    except PdfTextError:
        raise
    except MemoryError:
        raise
    except Exception as exc:
        # pypdf raises anything from its own errors to KeyError, struct.error
        # and RecursionError on damaged input; none of it is the caller's bug.
        where = f" (page {page_number})" if page_number else ""
        raise PdfTextError(f"cannot read PDF text{where}: {exc}") from exc
    return build_paragraphs(_blocks(pages))


def _page_lines(page: Any) -> list[_Line]:
    """The lines of one page, with positions when pypdf's pieces line up."""
    pieces: list[tuple[str, Optional[float], float]] = []

    def visit(text: str, cm: Any, tm: Any, font: Any, size: Any) -> None:
        if text:
            pieces.append((text, *_geometry(cm, tm, size)))

    plain = page.extract_text(visitor_text=visit)
    if "".join(piece[0] for piece in pieces) != plain:
        # The positions cannot be trusted to line up with the text: use the
        # text alone, which still has its own line and blank-line structure.
        return [_Line(line, None, _DEFAULT_SIZE) for line in plain.split("\n")]

    lines: list[_Line] = []
    parts: list[str] = []
    origin: Optional[tuple[Optional[float], float]] = None

    def end_line() -> None:
        nonlocal parts, origin
        y, size = origin if origin is not None else (None, _DEFAULT_SIZE)
        lines.append(_Line("".join(parts), y, size))
        parts, origin = [], None

    for text, y, size in pieces:
        for index, part in enumerate(text.split("\n")):
            if index:
                end_line()
            if part:
                parts.append(part)
                if origin is None and part.strip():
                    origin = (y, size)
    end_line()
    return lines


def _geometry(cm: Any, tm: Any, font_size: Any) -> tuple[Optional[float], float]:
    """Baseline height and effective font size of a text piece.

    The piece sits at ``tm`` (text matrix) inside ``cm`` (current transform),
    and PDFs commonly draw at ``Tf 1`` with the real size in the matrices, so
    the vertical scale of the combined matrix is applied to the font size.
    """
    try:
        a1, b1, c1, d1, e1, f1 = (float(v) for v in tm[:6])
        a2, b2, c2, d2, e2, f2 = (float(v) for v in cm[:6])
        y = e1 * b2 + f1 * d2 + f2
        scale = math.hypot(c1 * a2 + d1 * c2, c1 * b2 + d1 * d2)
        size = abs(float(font_size)) * scale
    except (TypeError, ValueError, IndexError):
        return None, _DEFAULT_SIZE
    if not (math.isfinite(y) and math.isfinite(size)):
        return None, _DEFAULT_SIZE
    return y, size if size > 0 else _DEFAULT_SIZE


def _blocks(pages: Sequence[Sequence[_Line]]) -> list[str]:
    """Group each page's lines into paragraphs (one string per paragraph)."""
    full_width = _full_line_width(pages)
    blocks: list[str] = []
    for lines in pages:
        pitch = _line_pitch(lines)
        current: list[str] = []
        previous: Optional[_Line] = None
        for line in lines:
            text = line.text.strip()
            if not text:
                if current:
                    blocks.append(" ".join(current))
                    current = []
                previous = None
                continue
            if previous is not None and _starts_paragraph(previous, line, pitch, full_width):
                blocks.append(" ".join(current))
                current = []
            current.append(text)
            previous = line
        if current:
            blocks.append(" ".join(current))
    return blocks


def _starts_paragraph(
    previous: _Line, line: _Line, pitch: Optional[float], full_width: int
) -> bool:
    """Whether ``line`` begins a new paragraph after ``previous``."""
    if previous.y is not None and line.y is not None:
        drop = previous.y - line.y  # positive: ``line`` is lower on the page
        if drop < -_SAME_LINE * line.size:
            return True  # jumped up the page: next column or block
        usual = pitch if pitch is not None else _DEFAULT_LEADING * line.size
        if drop > _GAP_FACTOR * usual:
            return True
    return (
        _SENTENCE_END.search(previous.text.strip()) is not None
        and len(previous.text.strip()) < _SHORT_FRACTION * full_width
    )


def _line_pitch(lines: Sequence[_Line]) -> Optional[float]:
    """The page's usual distance between consecutive lines, if it has enough lines.

    A lower quartile of the downward gaps, so that paragraph gaps and the long
    drop to a footer do not drag it up on sparse pages.  ``None`` below four
    lines, where :func:`_starts_paragraph` assumes ``_DEFAULT_LEADING`` instead.
    """
    gaps: list[float] = []
    previous: Optional[_Line] = None
    for line in lines:
        if not line.text.strip():
            previous = None
            continue
        if previous is not None and previous.y is not None and line.y is not None:
            drop = previous.y - line.y
            if drop > _SAME_LINE * line.size:
                gaps.append(drop)
        previous = line
    if len(gaps) < 3:
        return None
    gaps.sort()
    return gaps[(len(gaps) - 1) // 4]


def _full_line_width(pages: Sequence[Sequence[_Line]]) -> int:
    """The document's typical full line, in characters (90th percentile)."""
    lengths = sorted(
        len(line.text.strip()) for lines in pages for line in lines if line.text.strip()
    )
    return lengths[int(0.9 * (len(lengths) - 1))] if lengths else 0
