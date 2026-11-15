"""Automated checks module (plugin: checks).

Feature 65: the extracted text of a version's PDF is saved to the
``version_texts`` table, split into paragraphs with stable ids::

    from app.modules import checks

    paragraphs = checks.save_version_text(version_cid, pdf_cid)
    for p in checks.get_version_text(version_cid):
        p.position, p.paragraph_id, p.text

``pdf_cid`` is the PDF's file id in the content store
(:mod:`app.modules.content`).  A paragraph's id is the lowercase hex sha256 of
its *normalized* text (Unicode NFKC, control and invisible characters removed,
whitespace collapsed), so it is the same for the same words wherever they sit
-- in another version, after a re-flow, after the extractor changes -- and
different as soon as the words change.  Annotations anchor to these ids and
version comparison matches by them.  See :mod:`app.modules.checks.paragraphs`
for the exact rule and :mod:`app.modules.checks.extract` for how a PDF is cut
into paragraphs.

This package exposes no ``router``.  The module loader still discovers it,
which registers the ``VersionText`` model on the shared declarative base
before ``create_app`` creates tables.  Later checks of this plugin (similarity,
references, metadata match) read the paragraphs saved here.
"""

from __future__ import annotations

from .errors import ChecksError, InvalidVersionCid, PdfTextError
from .extract import extract_paragraphs
from .models import VersionText, ensure_table
from .paragraphs import (
    Paragraph,
    build_paragraphs,
    clean_text,
    normalize_paragraph,
    paragraph_id,
)
from .service import get_version_text, save_paragraphs, save_version_text

__all__ = [
    "ChecksError",
    "InvalidVersionCid",
    "Paragraph",
    "PdfTextError",
    "VersionText",
    "build_paragraphs",
    "clean_text",
    "ensure_table",
    "extract_paragraphs",
    "get_version_text",
    "normalize_paragraph",
    "paragraph_id",
    "save_paragraphs",
    "save_version_text",
]
