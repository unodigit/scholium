"""Build small PDFs for tests, byte by byte (no PDF-writing dependency).

A page is a raw content stream; :func:`lines_stream` makes the common one,
Helvetica lines placed with absolute text matrices::

    build_pdf([lines_stream([(720, "Title"), (700, "A line of body text.")])])

pypdf reads these as the text-layer PDFs real papers are, which is all the
extraction tests need.  Text is Latin-1 (WinAnsi encoded, so ``é`` works).
"""

from __future__ import annotations

from collections.abc import Sequence


def escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def lines_stream(
    lines: Sequence[tuple[float, str]], *, x: float = 72, size: float = 11
) -> str:
    """A content stream drawing each ``(y, text)`` line at ``x``, in order."""
    body = "".join(f"1 0 0 1 {x} {y} Tm ({escape(text)}) Tj\n" for y, text in lines)
    return f"BT /F1 {size} Tf\n{body}ET"


def build_pdf(streams: Sequence[str]) -> bytes:
    """A PDF with one page per content stream."""
    count = len(streams)
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(count))
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    for i, stream in enumerate(streams):
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>"
        )
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")

    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return out


def simple_pdf(*pages: Sequence[tuple[float, str]]) -> bytes:
    """A PDF whose pages are the given ``(y, text)`` line lists."""
    return build_pdf([lines_stream(lines) for lines in pages])


def stack(texts: Sequence[str], *, top: float = 700, pitch: float = 12) -> list[tuple[float, str]]:
    """Lay ``texts`` out as consecutive lines ``pitch`` apart, from ``top`` down."""
    return [(top - pitch * i, text) for i, text in enumerate(texts)]
