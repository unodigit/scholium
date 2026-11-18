"""Automated checks module (plugin: checks).

Feature 65: the extracted text of a version's PDF is saved to the
``version_texts`` table, split into paragraphs with stable ids::

    from app.modules import checks

    paragraphs = checks.save_version_text(version_cid, pdf_cid)
    for p in checks.get_version_text(version_cid):
        p.position, p.paragraph_id, p.text

Feature 66: the version's similarity to every listed paper (excluding the
paper's own other versions, which are revisions rather than overlaps), as
the highest word 5-gram shingle Jaccard percentage, is saved to
``check_results.similarity_pct``::

    checks.save_similarity_check(version_cid)   # corpus: other papers' versions
    checks.save_similarity_check(version_cid, papers=[other_cid, other_text])
    checks.get_check_result(version_cid).similarity_pct    # 0-100
    checks.similarity_pct(text_a, text_b)                  # the metric alone

Feature 68: whether the version's signed title appears in the first page text
is saved to ``check_results.metadata_match``::

    checks.save_metadata_match(version_cid, signed_title, first_page_text)
    checks.save_metadata_match(version_cid, signed_title, pdf_cid=pdf_cid)
    checks.save_metadata_match(version_cid)   # from the signed record in the log
    checks.get_check_result(version_cid).metadata_match

Feature 67: the references in the version's saved text are counted into
``check_results.references_total``, and -- only when ``CROSSREF_ENABLED=1`` --
their DOIs are resolved through Crossref into ``references_unresolved``::

    checks.save_reference_check(version_cid)        # needs save_version_text first
    checks.extract_references(checks.get_version_text(version_cid))
    row = checks.get_check_result(version_cid)
    row.references_total, row.references_unresolved

A reference is unresolved unless Crossref confirms its DOI, so without the flag
no request is made and ``references_unresolved`` equals ``references_total``.
If Crossref is enabled but cannot answer, ``CrossrefError`` is raised and
nothing is saved.  See :mod:`app.modules.checks.references` for
how the list is found and split and :mod:`app.modules.checks.crossref` for how
a DOI is resolved.

The checks run by themselves: when a version passes the sanitizer and enters
``moderation`` (or is listed without having passed through it), the
``checks.extract_text`` background job extracts its manuscript PDF, indexes
the body for full-text search, and saves the similarity, reference and
metadata-match columns::

    checks.extract_version_text(version_cid)   # what the job calls
    checks.enqueue_extraction(version_cid)     # explicit, e.g. a re-run

The trigger is a subscription to the existing ``version.state_changed`` event
(see :mod:`app.modules.checks.pipeline`), so nothing in the submissions plugin
had to change.

``GET /v1/papers/{id}/v/{n}/checks`` (see :mod:`app.modules.checks.router`)
returns the advisory report the submit wizard's Checks step polls; it is a 404
problem until the checks have run.

``pdf_cid`` is the PDF's file id in the content store
(:mod:`app.modules.content`).  A paragraph's id is the lowercase hex sha256 of
its *normalized* text (Unicode NFKC, control and invisible characters removed,
whitespace collapsed), so it is the same for the same words wherever they sit
-- in another version, after a re-flow, after the extractor changes -- and
different as soon as the words change.  Annotations anchor to these ids and
version comparison matches by them.  See :mod:`app.modules.checks.paragraphs`
for the exact rule and :mod:`app.modules.checks.extract` for how a PDF is cut
into paragraphs.  See :mod:`app.modules.checks.metadata` for how a title is
matched, :mod:`app.modules.checks.similarity` for how similarity is measured,
and :mod:`app.modules.checks.results` for the ``check_results`` row.

The module loader discovers this package, which registers the ``VersionText``
and ``CheckResult`` models on the shared declarative base before
``create_app`` creates tables, mounts :data:`router`, and registers the
extraction job and its ``version.state_changed`` subscription (through
:mod:`app.modules.checks.pipeline`).  Every check of this plugin writes its
own column of the shared ``check_results`` row.
"""

from __future__ import annotations

from .crossref import crossref_enabled, resolve_dois
from .errors import (
    ChecksError,
    CrossrefError,
    InvalidVersionCid,
    MetadataMatchError,
    PdfTextError,
)
from .extract import extract_first_page_text, extract_paragraphs
from .metadata import metadata_match, normalize_for_match
from .models import (
    CheckResult,
    VersionText,
    ensure_check_results_table,
    ensure_table,
)
from .paragraphs import (
    Paragraph,
    build_paragraphs,
    clean_text,
    normalize_paragraph,
    paragraph_id,
)
from .pipeline import (
    JOB_KIND,
    enqueue_extraction,
    ensure_subscribed,
    extract_version_job,
    extract_version_text,
    manifest_entries,
    manuscript_pdf_cid,
)
from .references import Reference, extract_references, find_doi
from .results import (
    ReferenceCheck,
    get_check_result,
    save_check_result,
    save_metadata_match,
    save_reference_check,
)
from .router import router
from .service import get_version_text, save_paragraphs, save_version_text
from .similarity import (
    DEFAULT_SHINGLE_SIZE,
    PaperText,
    SimilarityCheck,
    compute_similarity_pct,
    jaccard_index,
    jaccard_similarity,
    save_similarity_check,
    save_similarity_pct,
    shingles,
    similarity_pct,
    word_shingles,
)

__all__ = [
    "CheckResult",
    "ChecksError",
    "CrossrefError",
    "DEFAULT_SHINGLE_SIZE",
    "JOB_KIND",
    "InvalidVersionCid",
    "MetadataMatchError",
    "PaperText",
    "Paragraph",
    "PdfTextError",
    "Reference",
    "ReferenceCheck",
    "SimilarityCheck",
    "VersionText",
    "build_paragraphs",
    "clean_text",
    "compute_similarity_pct",
    "crossref_enabled",
    "enqueue_extraction",
    "ensure_check_results_table",
    "ensure_subscribed",
    "ensure_table",
    "extract_first_page_text",
    "extract_paragraphs",
    "extract_references",
    "extract_version_job",
    "extract_version_text",
    "find_doi",
    "get_check_result",
    "get_version_text",
    "jaccard_index",
    "jaccard_similarity",
    "manifest_entries",
    "manuscript_pdf_cid",
    "metadata_match",
    "normalize_for_match",
    "normalize_paragraph",
    "paragraph_id",
    "resolve_dois",
    "router",
    "save_check_result",
    "save_metadata_match",
    "save_paragraphs",
    "save_reference_check",
    "save_similarity_check",
    "save_similarity_pct",
    "save_version_text",
    "shingles",
    "similarity_pct",
    "word_shingles",
]
