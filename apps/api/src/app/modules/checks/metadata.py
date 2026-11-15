"""Does a version's signed title appear in the first page text?

::

    from app.modules import checks

    checks.metadata_match("A Study of Widgets", "A Study of Widgets\nA. Author")
    # True

The comparison is deliberately forgiving about everything a PDF text layer
does to a title without changing the words a reader sees:

* case is folded, so a title set in caps at the top of the page matches the
  sentence-case title in the signed record;
* Unicode is NFKC-normalized (ligatures, full-width forms) and whitespace is
  collapsed, so a title wrapped over two lines still matches;
* a word hyphenated across a line break (``"re- sults"``, which
  :mod:`app.modules.checks.extract` keeps as written) matches the unhyphenated
  word in the title.

It is not fuzzy: every word must be present, in order.  "Appears" means a
substring of the page text, so a title quoted inside another sentence on
page one also counts -- that is still the signed title on the first page,
which is the signal the check exists to give.

An empty or whitespace-only title never matches: it would otherwise be a
substring of every page and turn missing metadata into a passing check.
"""

from __future__ import annotations

import re
import unicodedata

__all__ = ["metadata_match", "normalize_for_match"]

_WHITESPACE = re.compile(r"\s+")
# A hyphen (of any common form) followed by whitespace: what a PDF line break
# leaves in the middle of a hyphenated word.  Removing the hyphen as well as
# the space is what lets "re- sults" match "results"; a real compound
# ("state-of-the-art") has no space after its hyphens and is left alone.
_LINE_BREAK_HYPHEN = re.compile(r"[-‐‑‒–]\s+")


def normalize_for_match(text: str) -> str:
    """Fold ``text`` to the form the comparison uses (case, width, whitespace)."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return _WHITESPACE.sub(" ", folded).strip()


def _without_line_break_hyphens(text: str) -> str:
    """``text`` with hyphens that only existed because of a line break removed."""
    return _WHITESPACE.sub(" ", _LINE_BREAK_HYPHEN.sub("", text)).strip()


def metadata_match(title: str, first_page_text: str) -> bool:
    """Whether ``title`` appears in ``first_page_text``.

    Args:
        title: the title from the version's signed record.
        first_page_text: the text of the PDF's first page (see
            :func:`~app.modules.checks.extract.extract_first_page_text`).

    Returns:
        ``True`` when the normalized title is a substring of the normalized
        page text, also after removing line-break hyphenation from both.

    Raises:
        TypeError: if either argument is not a string.
    """
    if not isinstance(title, str):
        raise TypeError(f"title must be a string, got {type(title).__name__}")
    if not isinstance(first_page_text, str):
        raise TypeError(
            f"first page text must be a string, got {type(first_page_text).__name__}"
        )

    needle = normalize_for_match(title)
    if not needle:
        return False
    haystack = normalize_for_match(first_page_text)
    if needle in haystack:
        return True
    return _without_line_break_hyphens(needle) in _without_line_break_hyphens(haystack)
