"""Saving and reading a version's extracted text (``version_texts``).

::

    from app.modules import checks

    paragraphs = checks.save_version_text(version_cid, pdf_cid)   # from the blob store
    checks.get_version_text(version_cid)                          # [Paragraph, ...]

``save_version_text`` reads the PDF a version is made of from the content
store, extracts its text, splits it into paragraphs and replaces the
version's rows in ``version_texts`` -- every row of the version in a single
transaction, so readers see the old text or the new text, never a mixture, and
a PDF that cannot be read leaves the previous text alone.

Ids and positions are computed here from the text, never accepted from a
caller (:func:`save_paragraphs` takes plain strings for that reason).  Saving
is idempotent: a version cid names its content, so the same PDF gives the same
rows, and saving again changes nothing.

Whether the PDF has been cleared by the sanitizer is the caller's decision;
this module does not look at ``blobs.scan_status``.
"""

from __future__ import annotations

from collections.abc import Iterable

from multiformats import CID
from scholium_record_core import CID_BASE
from sqlalchemy import delete, insert, select
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules import content

from .errors import InvalidVersionCid
from .extract import extract_paragraphs
from .models import VersionText, ensure_table
from .paragraphs import Paragraph, build_paragraphs

__all__ = [
    "get_version_text",
    "save_paragraphs",
    "save_version_text",
]

# Two saves of one version racing on PostgreSQL can each delete nothing and
# then collide on the primary key; the loser's retry sees the winner's rows
# and replaces them.  One retry is enough: a third writer would have to arrive
# inside the retry's own transaction.
_ATTEMPTS = 2

_SHOW_LIMIT = 60


def _show(value: object) -> str:
    text = repr(value)
    return text if len(text) <= _SHOW_LIMIT else text[: _SHOW_LIMIT - 3] + "..."


def _check_version_cid(value: object) -> str:
    """``value`` if it is a canonical base32 CID string, else :class:`InvalidVersionCid`.

    Canonical only, so one version can never have rows under two spellings
    of its cid that no lookup would find together.
    """
    if not isinstance(value, str):
        raise InvalidVersionCid(f"version cid must be a string, got {type(value).__name__}")
    try:
        canonical = CID.decode(value).encode(CID_BASE)
    except (ValueError, KeyError) as exc:
        raise InvalidVersionCid(f"version cid {_show(value)} is not a valid CID") from exc
    if canonical != value:
        raise InvalidVersionCid(
            f"version cid {_show(value)} is not in canonical base32 form; expected {canonical}"
        )
    return value


def save_version_text(version_cid: str, pdf_cid: str) -> list[Paragraph]:
    """Extract the text of the stored PDF ``pdf_cid`` and save it as ``version_cid``'s text.

    Replaces any text already saved for the version.  A PDF without a text
    layer saves no paragraphs (and so clears the old ones).

    Args:
        version_cid: the version's record cid (canonical base32).
        pdf_cid: the file id of the version's PDF in the content store.

    Returns:
        The saved paragraphs, in reading order.

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        content.BlobNotFound: if ``pdf_cid`` has no ``blobs`` row.
        PdfTextError: if the blob is not a readable PDF (nothing is changed).
    """
    _check_version_cid(version_cid)
    if content.get_blob(pdf_cid) is None:
        raise content.BlobNotFound(f"no blob with cid {_show(pdf_cid)}")
    with content.open_blob(pdf_cid) as pdf:
        paragraphs = extract_paragraphs(pdf)
    _replace(version_cid, paragraphs)
    return paragraphs


def save_paragraphs(version_cid: str, texts: Iterable[str]) -> list[Paragraph]:
    """Save ``texts`` as the paragraphs of ``version_cid``, replacing any already saved.

    For text that did not come from a PDF in the content store.  Each text is
    cleaned, empty ones are dropped, and positions and ids are assigned (see
    :func:`~.paragraphs.build_paragraphs`).

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        TypeError: if an item of ``texts`` is not a string (nothing is changed).
    """
    _check_version_cid(version_cid)
    paragraphs = build_paragraphs(texts)
    _replace(version_cid, paragraphs)
    return paragraphs


def get_version_text(version_cid: str) -> list[Paragraph]:
    """The saved paragraphs of ``version_cid`` in reading order (empty when none).

    A ``version_cid`` that is not a valid cid has no text, so it also gives
    an empty list.
    """
    if not isinstance(version_cid, str):
        return []
    ensure_table()
    with db.SessionLocal() as session:
        rows = session.execute(
            select(VersionText.position, VersionText.paragraph_id, VersionText.text)
            .where(VersionText.version_cid == version_cid)
            .order_by(VersionText.position)
        )
        return [Paragraph(position=p, paragraph_id=i, text=t) for p, i, t in rows]


def _replace(version_cid: str, paragraphs: list[Paragraph]) -> None:
    """Make ``paragraphs`` the whole of ``version_cid``'s rows, atomically."""
    ensure_table()
    values = [
        {
            "version_cid": version_cid,
            "paragraph_id": paragraph.paragraph_id,
            "position": paragraph.position,
            "text": paragraph.text,
        }
        for paragraph in paragraphs
    ]
    for attempt in range(_ATTEMPTS):
        try:
            with db.SessionLocal() as session:
                # Concurrent saves of one version replace each other in turn
                # (PostgreSQL would otherwise let them all delete, then collide
                # on the inserts).
                db.lock_transaction(session, f"version_texts:{version_cid}")
                session.execute(delete(VersionText).where(VersionText.version_cid == version_cid))
                if values:
                    session.execute(insert(VersionText), values)
                session.commit()
            return
        except IntegrityError:
            if attempt == _ATTEMPTS - 1:
                raise
