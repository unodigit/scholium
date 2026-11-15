"""Demo manuscripts: small, valid, deterministic PDFs.

A paper on the node is a signed record that points at manuscript bytes by their
content id, and the node scans, sanitizes and reads those bytes.  The demo
papers therefore need real PDFs.  These are plain text pages written by hand --
no scripts, no embedded files, no actions, black text at a readable size -- so
the node's scanner passes them, and its text extraction recovers their
paragraphs.

The output has no timestamp, producer string or random id, so the same paper
always yields the same bytes and therefore the same content id.  That is what
lets ``seed-demo`` be run twice without duplicating anything.

One constraint on what the manuscripts say.  The node finds paragraphs by comparing
the gap between lines with the page's *usual* line pitch, which it takes from the
lower quartile of all the gaps on the page.  A page that is mostly headings and
one-line paragraphs has mostly large gaps, so its "usual" pitch comes out too big
and its paragraph breaks are missed.  A demo paper therefore needs enough
multi-line paragraphs for ordinary line gaps to dominate; the test for this module
reads every cast manuscript back through the node's extractor to keep that true.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass, field

__all__ = ["Manuscript", "build_pdf"]

_PAGE_WIDTH, _PAGE_HEIGHT = 612, 792
_MARGIN = 72
_BOTTOM = _MARGIN
_WRAP_COLUMNS = 84

#: ``F1`` is regular, ``F2`` bold: both are standard PDF fonts that need no embedding.
_REGULAR, _BOLD = "F1", "F2"

_NOTICE = "Demo manuscript. The authors, institutions and results in it are fictional."



@dataclass(frozen=True)
class Manuscript:
    """What a demo manuscript says."""

    title: str
    authors: tuple[str, ...]
    categories: tuple[str, ...]
    abstract: str
    #: ``(heading, paragraphs)`` in reading order.
    sections: tuple[tuple[str, tuple[str, ...]], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class _Line:
    text: str
    font: str
    size: int
    #: Blank space above the line, in points, on top of the normal leading.
    before: int = 0


def _escape(text: str) -> bytes:
    data = text.encode("latin-1", "replace")
    return data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _lines(manuscript: Manuscript) -> list[_Line]:
    lines: list[_Line] = []

    def block(text: str, font: str, size: int, columns: int, gap: int) -> None:
        # Never break inside a hyphenated word: extraction rejoins lines with a
        # space, which would turn "meta-agent" into "meta- agent".
        wrapped = textwrap.wrap(text, width=columns, break_on_hyphens=False) or [""]
        for index, piece in enumerate(wrapped):
            lines.append(_Line(piece, font, size, before=gap if index == 0 else 0))

    # The node's text extraction starts a paragraph where the drop between lines
    # is well over the page's usual line pitch (1.3x), so every gap that should
    # separate two paragraphs is at least 8pt on top of the leading.
    byline = f"{', '.join(manuscript.authors)}  |  {' '.join(manuscript.categories)}"
    block(manuscript.title, _BOLD, 16, 56, 0)
    block(byline, _REGULAR, 10, _WRAP_COLUMNS, 10)
    block(_NOTICE, _REGULAR, 9, _WRAP_COLUMNS, 8)
    block("Abstract", _BOLD, 12, _WRAP_COLUMNS, 18)
    block(manuscript.abstract, _REGULAR, 11, _WRAP_COLUMNS, 8)
    for heading, paragraphs in manuscript.sections:
        block(heading, _BOLD, 12, _WRAP_COLUMNS, 18)
        for paragraph in paragraphs:
            block(paragraph, _REGULAR, 11, _WRAP_COLUMNS, 8)
    return lines


def _paginate(lines: list[_Line]) -> list[bytes]:
    """Lay ``lines`` out top to bottom, one content stream per page."""
    pages: list[list[bytes]] = [[]]
    y = _PAGE_HEIGHT - _MARGIN
    for line in lines:
        leading = round(line.size * 1.3)
        y -= leading + line.before
        if y < _BOTTOM and pages[-1]:
            pages.append([])
            y = _PAGE_HEIGHT - _MARGIN - leading
        if line.text:
            pages[-1].append(
                b"BT /%s %d Tf 1 0 0 1 %d %d Tm (%s) Tj ET"
                % (line.font.encode(), line.size, _MARGIN, y, _escape(line.text))
            )
    return [b"\n".join(page) for page in pages]


def build_pdf(manuscript: Manuscript) -> bytes:
    """The manuscript as PDF bytes (the same input always gives the same bytes)."""
    streams = _paginate(_lines(manuscript))
    first_page_obj = 5
    page_objects = [first_page_obj + 2 * i for i in range(len(streams))]

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>"
        % (b" ".join(b"%d 0 R" % number for number in page_objects), len(streams)),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    ]
    for number, stream in zip(page_objects, streams):
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
            b"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>"
            % (_PAGE_WIDTH, _PAGE_HEIGHT, number + 1)
        )
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref_at)
    return bytes(out)
