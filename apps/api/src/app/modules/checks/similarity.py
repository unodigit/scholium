"""The similarity check: word 5-gram shingle Jaccard (feature 66).

::

    from app.modules import checks

    checks.save_similarity_check(version_cid)
    checks.get_check_result(version_cid).similarity_pct

    # The metric on its own:
    checks.similarity_pct("a b c d e", "a b c d e")          # 100.0
    checks.jaccard_similarity("a b c d e f", "a b c d e g")  # 0.333...

The value saved is the **highest** Jaccard similarity between the version's
text and any listed paper, as a percentage from 0 to 100.  A submission's
similarity signal is how much of it overlaps *some other paper*; one similar
neighbour is what matters, so the maximum is reported rather than an average.

Shingles
--------
Each text is folded to lowercase, NFKC-normalized and split into words
(sequences of Unicode word characters: letters, digits and underscore).  A
text's shingles are its consecutive runs of
:data:`DEFAULT_SHINGLE_SIZE` (five) words.  Punctuation and whitespace are
separators, not tokens, so re-flowed text and changed punctuation do not move
a shingle.  A text shorter than five words has no shingles and so scores 0
against everything (there is no "partial" 5-gram to match).

Jaccard is ``|A ∩ B| / |A ∪ B|`` over the two texts' shingle *sets* -- repeated
shingles count once, which is what makes a copied paragraph count no more than
a coincidental one.  Two texts with no shingles at all score 0, not 100: no
evidence of overlap is not evidence of identity.

Which papers are compared
-------------------------
With no explicit list, the corpus is every *other* version whose text is saved
in ``version_texts`` (feature 65), except versions of the same paper.  A new
version overlapping its own predecessor is a revision, not a similar paper;
the moderation queue reads this percentage as similarity to *another* paper,
so an earlier (or later) version of the same paper is never counted.  The
paper relationship comes from ``paper_versions`` when this node has it; a
version that has saved text but no ``paper_versions`` row is treated as its
own paper, and the target version is always excluded from its own corpus.
A caller that knows the listing state -- the submission pipeline, or a
moderation queue -- can pass ``papers=`` explicitly (another version's cid,
raw text, ``(cid, text)`` pairs, mappings or :class:`PaperText` objects),
which both restricts and extends the corpus.  Comparing a version with no
saved text, or against an empty corpus, saves 0.

Writing
-------
:func:`save_similarity_check` writes ``check_results.similarity_pct`` through
:func:`~app.modules.checks.results.save_check_result`, so it fills in one column
of the version's row and leaves the reference and metadata checks' columns
alone.  Running it again replaces the value.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Optional

from multiformats import CID
from scholium_record_core import CID_BASE
from sqlalchemy import select

from app import db

from .models import VersionText, ensure_table
from .paragraphs import Paragraph
from .results import save_check_result
from .service import _check_version_cid, get_version_text

__all__ = [
    "DEFAULT_SHINGLE_SIZE",
    "PaperText",
    "SimilarityCheck",
    "compute_similarity_pct",
    "jaccard_index",
    "jaccard_similarity",
    "save_similarity_check",
    "save_similarity_pct",
    "shingles",
    "similarity_pct",
    "word_shingles",
]

#: Words per shingle.  The spec fixes it at five.
DEFAULT_SHINGLE_SIZE = 5

# A "word" is a run of Unicode word characters.  ``\w`` covers letters from
# every script, digits and underscore; everything else separates words.
_WORD = re.compile(r"\w+", re.UNICODE)

#: Keys a mapping may use for a paper's text, and for its cid.
_TEXT_KEYS = ("text", "texts", "paragraphs", "body", "content")
_CID_KEYS = ("version_cid", "cid", "paper_cid", "id")

#: Sentinel for "the mapping has no text key".
_MISSING = object()

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PaperText:
    """One listed paper's text, with its version cid when known."""

    #: The version's cid, or ``None`` for text passed without one.
    cid: Optional[str]
    #: The paper's full text.
    text: str


@dataclass(frozen=True)
class SimilarityCheck:
    """What :func:`save_similarity_check` saved."""

    #: Highest Jaccard similarity to a listed paper, as 0-100
    #: (``check_results.similarity_pct``).
    similarity_pct: float
    #: The cid of that paper, when it carried one and the score is above 0.
    closest_cid: Optional[str] = None
    #: How many papers were compared.
    compared: int = 0

    @property
    def pct(self) -> float:
        """Alias for :attr:`similarity_pct`."""
        return self.similarity_pct


# --------------------------------------------------------------------------- #
# The metric
# --------------------------------------------------------------------------- #


def word_shingles(text: str, n: int = DEFAULT_SHINGLE_SIZE) -> frozenset[tuple[str, ...]]:
    """The set of ``n``-word shingles of ``text``.

    Words are NFKC-normalized, case-folded runs of word characters.  A text
    with fewer than ``n`` words has no shingles, so the result is empty.

    Args:
        text: the text to shingle.
        n: words per shingle; must be a positive integer.

    Raises:
        TypeError: if ``text`` is not a string.
        ValueError: if ``n`` is less than one.
    """
    words = _words(text)
    size = _shingle_size(n)
    return frozenset(
        tuple(words[start : start + size]) for start in range(len(words) - size + 1)
    )


#: Short name for :func:`word_shingles`.
shingles = word_shingles


def jaccard_index(
    first: Iterable[Any], second: Iterable[Any],
) -> float:
    """Jaccard index of two already-shingled sets, from 0 to 1.

    ``|first ∩ second| / |first ∪ second|``.  Two empty sets give 0.0: with no
    shared shingle evidence there is nothing to call similar.

    Args:
        first: the first set (or any iterable) of hashable shingles.
        second: the second set (or any iterable) of hashable shingles.

    Raises:
        TypeError: if an item is unhashable.
    """
    left = set(first)
    right = set(second)
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def jaccard_similarity(
    first: str, second: str, n: int = DEFAULT_SHINGLE_SIZE,
) -> float:
    """Word ``n``-gram shingle Jaccard similarity of two texts, from 0 to 1.

    Raises:
        TypeError: if a text is not a string.
        ValueError: if ``n`` is less than one.
    """
    return jaccard_index(word_shingles(first, n), word_shingles(second, n))


def similarity_pct(
    first: str, second: str, n: int = DEFAULT_SHINGLE_SIZE,
) -> float:
    """:func:`jaccard_similarity` as a percentage from 0 to 100."""
    return jaccard_similarity(first, second, n) * 100.0


#: Longer name for :func:`similarity_pct`.
compute_similarity_pct = similarity_pct


def _words(text: str) -> list[str]:
    """The case-folded, NFKC-normalized word tokens of ``text``."""
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text).__name__}")
    return _WORD.findall(unicodedata.normalize("NFKC", text).casefold())


def _shingle_size(n: object) -> int:
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"shingle size must be an integer, got {type(n).__name__}")
    if n < 1:
        raise ValueError(f"shingle size must be at least 1, got {n}")
    return n


# --------------------------------------------------------------------------- #
# Choosing the corpus
# --------------------------------------------------------------------------- #


def save_similarity_check(
    version_cid: str,
    papers: Optional[Any] = None,
    *,
    texts: Optional[Any] = None,
    n: int = DEFAULT_SHINGLE_SIZE,
) -> SimilarityCheck:
    """Compute ``version_cid``'s similarity to listed papers and save the score.

    The version's text is read from ``version_texts`` (feature 65 must have run
    for it).  The percentage saved is the highest word ``n``-gram shingle
    Jaccard similarity to any compared paper, times 100, or 0 when there is no
    text or no paper to compare against.

    Args:
        version_cid: the version's record cid (canonical base32).
        papers: the papers to compare against.  When ``None`` (the default),
            every *other* version of a *different* paper with text saved in
            ``version_texts`` (see "Which papers are compared" above).  When
            given, an iterable (or mapping) whose items are any of:
            another version's cid string (its saved text is read), a raw text
            string, a ``Paragraph``, a ``(cid, text)`` pair, a mapping with a
            text key (``text``/``texts``/``paragraphs``/``body``/``content``)
            and optionally a cid key (``version_cid``/``cid``/``paper_cid``/
            ``id``), an iterable of paragraphs, or a :class:`PaperText`.  An
            empty iterable compares against nothing.
        texts: alias for ``papers``.
        n: words per shingle.

    Returns:
        The saved score, the closest paper's cid (when known) and how many
        papers were compared.

    Raises:
        InvalidVersionCid: if ``version_cid`` is not a canonical CID.
        TypeError: if a paper item or a text is not usable (nothing is saved).
        ValueError: if ``n`` is less than one.
    """
    version_cid = _check_version_cid(version_cid)
    if papers is not None and texts is not None:
        raise TypeError("pass either papers or texts, not both")
    if papers is None:
        papers = texts
    size = _shingle_size(n)

    target = _saved_text(version_cid)
    target_shingles = word_shingles(target, size)
    candidates = _candidates(papers, exclude=version_cid)

    best_pct = 0.0
    best_cid: Optional[str] = None
    compared = 0
    for paper in candidates:
        if paper.cid is not None and paper.cid == version_cid:
            continue
        pct = jaccard_index(target_shingles, word_shingles(paper.text, size)) * 100.0
        if pct > best_pct:
            best_pct, best_cid = pct, paper.cid
        compared += 1

    save_check_result(version_cid, similarity_pct=best_pct)
    return SimilarityCheck(similarity_pct=best_pct, closest_cid=best_cid, compared=compared)


#: Name for :func:`save_similarity_check` that names the column it writes.
save_similarity_pct = save_similarity_check


def _saved_text(version_cid: str) -> str:
    """The whole saved text of ``version_cid`` as one string ("" when none)."""
    return " ".join(paragraph.text for paragraph in get_version_text(version_cid))


def _candidates(papers: Optional[Any], *, exclude: str) -> list[PaperText]:
    """The papers to compare against, in a deterministic order."""
    if papers is None:
        return _saved_papers(exclude, also_exclude=_same_paper_versions(exclude))
    return [_paper_text(item) for item in _items(papers)]


def _saved_papers(
    exclude: str, *, also_exclude: frozenset[str] = frozenset()
) -> list[PaperText]:
    """Every saved version's text, except ``exclude`` and ``also_exclude``, by cid."""
    ensure_table()
    grouped: dict[str, list[str]] = {}
    with db.SessionLocal() as session:
        statement = select(VersionText.version_cid, VersionText.text).where(
            VersionText.version_cid != exclude
        )
        if also_exclude:
            statement = statement.where(
                VersionText.version_cid.notin_(sorted(also_exclude))
            )
        rows = session.execute(
            statement.order_by(VersionText.version_cid, VersionText.position)
        )
        for cid, text in rows:
            grouped.setdefault(cid, []).append(text)
    return [PaperText(cid=cid, text=" ".join(parts)) for cid, parts in grouped.items()]


def _same_paper_versions(version_cid: str) -> frozenset[str]:
    """Every version cid of the paper ``version_cid`` belongs to.

    A paper's own earlier (or later) version is a revision, not another
    paper: counting its overlap as similarity would flag every updated
    submission as plagiarising its predecessor.  The default corpus therefore
    leaves them out.  An explicit ``papers=`` list is still the caller's
    choice, so a caller that deliberately asks for one can get it.

    Empty when this node has no ``paper_versions`` row for ``version_cid``
    (text saved through this library alone): then only the target itself is
    excluded.
    """
    paper_cid = _paper_cid(version_cid)
    if paper_cid is None:
        return frozenset()
    from app.modules.submissions.models import PaperVersion

    with db.SessionLocal() as session:
        rows = session.execute(
            select(PaperVersion.version_cid).where(
                PaperVersion.paper_cid == paper_cid
            )
        )
        return frozenset(row[0] for row in rows)


def _paper_cid(version_cid: str) -> Optional[str]:
    """The paper ``version_cid`` is a version of, when the node knows."""
    try:
        from app.modules import submissions

        row = submissions.get_version(version_cid)
    except Exception:  # pragma: no cover - a missing/damaged table is not a normal path
        logger.warning(
            "could not read the paper of version %r", version_cid, exc_info=True
        )
        return None
    value = getattr(row, "paper_cid", None) if row is not None else None
    return value if isinstance(value, str) and value else None


def _items(papers: Any) -> Iterator[Any]:
    """Iterate the items of a ``papers`` argument, treating one item as one."""
    if isinstance(papers, Mapping):
        if _text_key(papers) is not _MISSING:
            # A single paper mapping ({"cid": ..., "text": ...}), not a corpus.
            return iter((papers,))
        return iter(papers.items())
    if isinstance(papers, (str, bytes, bytearray, Paragraph, PaperText)):
        return iter((papers,))
    if hasattr(papers, "text") and isinstance(getattr(papers, "text"), str):
        return iter((papers,))
    try:
        return iter(papers)
    except TypeError as exc:
        raise TypeError(
            f"papers must be an iterable of papers, got {type(papers).__name__}"
        ) from exc


def _paper_text(item: Any) -> PaperText:
    """Turn one ``papers`` item into a :class:`PaperText`.

    Raises:
        TypeError: if the item is not a recognised paper or text.
    """
    if isinstance(item, PaperText):
        return item
    if isinstance(item, str):
        if _is_canonical_cid(item):
            # Another version's cid: compare against its saved text.
            return PaperText(cid=item, text=_saved_text(item))
        return PaperText(cid=None, text=item)
    if isinstance(item, Paragraph):
        return PaperText(cid=None, text=item.text)
    if isinstance(item, Mapping):
        value = _text_key(item)
        if value is _MISSING:
            raise TypeError(
                "a paper mapping must have a text key "
                f"({', '.join(_TEXT_KEYS)}), got {sorted(item)!r}"
            )
        return PaperText(cid=_cid_of(item), text=_text_value(value))
    if isinstance(item, tuple) and len(item) == 2:
        cid, value = item
        if cid is not None and not isinstance(cid, str):
            raise TypeError(
                f"a paper cid must be a string or None, got {type(cid).__name__}"
            )
        return PaperText(cid=cid, text=_text_value(value))
    if isinstance(item, (bytes, bytearray)):
        raise TypeError("a paper text must be a string, not bytes")
    text = getattr(item, "text", _MISSING)
    if isinstance(text, str):
        return PaperText(cid=None, text=text)
    if isinstance(item, Iterable):
        return PaperText(cid=None, text=_text_value(item))
    raise TypeError(
        f"a paper must be a cid, text, (cid, text) pair or mapping, "
        f"got {type(item).__name__}"
    )


def _text_key(item: Mapping[Any, Any]) -> Any:
    """The value of the first text key in ``item``, or :data:`_MISSING`."""
    for key in _TEXT_KEYS:
        if key in item:
            return item[key]
    return _MISSING


def _cid_of(item: Mapping[Any, Any]) -> Optional[str]:
    for key in _CID_KEYS:
        value = item.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise TypeError(
                f"a paper cid must be a string or None, got {type(value).__name__}"
            )
        return value
    return None


def _text_value(value: Any) -> str:
    """A paper's text from a string, a paragraph, or a sequence of either."""
    if isinstance(value, str):
        return value
    if isinstance(value, Paragraph):
        return value.text
    if isinstance(value, (bytes, bytearray)):
        raise TypeError("a paper text must be a string, not bytes")
    if isinstance(value, Mapping):
        raise TypeError("a paper text must be a string, not a mapping")
    if isinstance(value, Iterable):
        return " ".join(_text_value(part) for part in value)
    text = getattr(value, "text", _MISSING)
    if isinstance(text, str):
        return text
    raise TypeError(f"a paper text must be a string, got {type(value).__name__}")


def _is_canonical_cid(value: str) -> bool:
    """Whether ``value`` is a canonical base32 CID string."""
    try:
        return CID.decode(value).encode(CID_BASE) == value
    except (ValueError, KeyError):
        return False
