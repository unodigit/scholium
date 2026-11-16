"""Rendering one paper version as a BibTeX or RIS citation (plugin: export, feature 90).

:func:`render` turns a :class:`~app.modules.export.records.ListedPaper` -- the
listed version ``GET /v1/papers/{id}`` would answer with -- into the text a
reference manager imports.  Both formats carry the same facts:

* the **title** of the version cited;
* the **authors** in byline order.  An author with a readable profile is
  cited by that profile's display name, as ``Family, Given`` -- the form a
  reference manager parses; one without a profile (never saved, erased, or
  saved with a blank name) is cited as the DID the signed version lists,
  which is how the public catalog and the OAI-PMH endpoint name authors;
* the **year** the version was listed, when this node recorded it;
* the **version id** -- ``sch:xxxx-xxxx-xxxx/vN`` -- which is what makes the
  citation resolve to exactly the text that was read, not to whatever the
  paper says after a later version;
* the paper's **categories**, as keywords;
* a **retraction note** when the paper is retracted.

A paper is retracted when its stored status says so (the ``status`` plugin
computes ``retracted`` from a ``retraction`` notice and nothing outranks it) or
when it carries a ``retraction`` notice -- either signal is enough, so a note
is never missed because one of the two derived rows lags the other.  The note
quotes every retraction notice's date and reason.  Withdrawals and corrections
are not retractions and add no note.

Everything written into a citation comes from signed records authored by other
people, so each value is made inert for its format before it is placed in the
output.  BibTeX values are LaTeX-escaped (braces and backslashes included, so a
title cannot close its field and open a new entry); RIS values are single lines
(so a title cannot start a new ``TY``/``ER`` record).  Control characters and
line breaks become spaces in both.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

from app.modules.status import STATUS_RETRACTED
from app.modules.submissions import RETRACTION_TYPE, Notice

from .records import ListedPaper, display_name

__all__ = [
    "BIBTEX",
    "CITATION_FORMATS",
    "CitationFormat",
    "DEFAULT_FORMAT",
    "RIS",
    "citation_key",
    "is_retracted",
    "render",
    "retraction_note",
]

#: Publisher named in every citation (the same name the OAI-PMH endpoint uses).
PUBLISHER = "Scholium"

#: The format served when ``?format=`` is absent.
DEFAULT_FORMAT = "bibtex"


@dataclass(frozen=True)
class CitationFormat:
    """One citation format the endpoint can serve."""

    #: The ``?format=`` value that selects it.
    name: str
    #: The response's ``Content-Type`` (UTF-8: titles are not ASCII-only).
    media_type: str
    #: Filename extension, for ``Content-Disposition``.
    extension: str
    #: Render one listed paper in this format.
    render: Callable[[ListedPaper], str]


# --------------------------------------------------------------------------- #
# What the citation says
# --------------------------------------------------------------------------- #


def _plain(value: object) -> str:
    """``value`` as one line of text: whitespace collapsed, control characters gone."""
    text = " ".join(str(value).split())
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cc")


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is not None:
        return moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


def _listed_at(record: ListedPaper) -> Optional[datetime]:
    """When the cited version was listed (naive UTC), or ``None`` if unrecorded.

    Unlike the OAI datestamp this has no epoch fallback: a citation with no
    year is honest, one dated 1970 is not.
    """
    moment = record.version.listed_at or record.paper.listed_at
    return None if moment is None else _utc(moment)


def retraction_notices(record: ListedPaper) -> tuple[Notice, ...]:
    """The paper's ``retraction`` notices, oldest first."""
    return tuple(notice for notice in record.notices if notice.kind == RETRACTION_TYPE)


def is_retracted(record: ListedPaper) -> bool:
    """Whether the paper is retracted (see the module docstring)."""
    return record.paper.status == STATUS_RETRACTED or bool(retraction_notices(record))


def retraction_note(record: ListedPaper) -> Optional[str]:
    """The sentence a retracted paper's citation carries, or ``None`` if it is not retracted."""
    if not is_retracted(record):
        return None
    parts = ["RETRACTED: this paper has been retracted."]
    for notice in retraction_notices(record):
        reason = _plain(notice.reason)
        when = _utc(notice.created_at).strftime("%Y-%m-%d")
        parts.append(f"Notice of {when}: {reason}")
    return " ".join(parts)


def citation_key(record: ListedPaper) -> str:
    """A BibTeX key for the cited version: ``sch-xxxx-xxxx-xxxx-vN``.

    The ``sch:`` id's colon and the version id's slash are replaced so the key
    survives every BibTeX and biber setting; the exact ids are in the entry.
    """
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", record.short_id).strip("-") or "paper"
    return f"{stem}-v{int(record.version.n)}"


def _family_first(name: str) -> str:
    """A profile display name as ``Family, Given``.

    The last whitespace-separated word is read as the family name and the rest
    as given names, the convention a profile's single free-text name field
    carries ("Ada Lovelace" becomes "Lovelace, Ada").  A name that already
    holds a comma, or a single word, is left exactly as saved.
    """
    text = _plain(name)
    if "," in text:
        return text
    words = text.split()
    if len(words) < 2:
        return text
    return f"{words[-1]}, {' '.join(words[:-1])}"


def _author_entries(record: ListedPaper) -> list[tuple[str, Optional[str]]]:
    """Each author as ``(did, display name)``, in byline order.

    The display name is ``None`` when there is no readable profile (never
    saved, erased, or blank); the citation then names the author by DID.  The
    name is public data -- ``GET /v1/profiles/{did}`` shows it to every
    reader; only the email is the owner's alone.
    """
    return [(did, display_name(did)) for did in record.authors]


# --------------------------------------------------------------------------- #
# BibTeX
# --------------------------------------------------------------------------- #

_BIBTEX_ESCAPES = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def _bibtex(value: object) -> str:
    """``value`` made safe to put between the braces of a BibTeX field."""
    return "".join(_BIBTEX_ESCAPES.get(ch, ch) for ch in _plain(value))


def _braced(text: str) -> str:
    return "{" + text + "}"


def render_bibtex(record: ListedPaper) -> str:
    """``record`` as one BibTeX ``@misc`` entry (biblatex ``eprint`` fields included)."""
    # Every value below is the complete, braced right-hand side of one field.
    fields: list[tuple[str, str]] = [
        # The inner braces stop a style from changing the title's capitalisation.
        ("title", _braced("{" + _bibtex(record.version.title) + "}")),
    ]
    if record.authors:
        # A braced name is a literal: BibTeX will not split a DID into first
        # and last names.  A profile name is left unbraced in "Family, Given"
        # form, which BibTeX itself parses into family and given names.
        names = " and ".join(
            "{" + _bibtex(did) + "}" if name is None else _bibtex(_family_first(name))
            for did, name in _author_entries(record)
        )
        fields.append(("author", _braced(names)))
    listed = _listed_at(record)
    if listed is not None:
        fields.append(("year", _braced(str(listed.year))))
    fields.append(("publisher", _braced(PUBLISHER)))
    fields.append(("version", _braced(str(int(record.version.n)))))
    fields.append(("eprint", _braced(_bibtex(record.version_id))))
    fields.append(("eprinttype", _braced(PUBLISHER)))
    categories = [_bibtex(category) for category in record.paper.categories or []]
    if categories:
        fields.append(("eprintclass", _braced(categories[0])))
        fields.append(("keywords", _braced(", ".join(categories))))
    note = retraction_note(record)
    if note is not None:
        fields.append(("note", _braced(_bibtex(note))))

    lines = [f"@misc{{{citation_key(record)},"]
    lines.extend(f"  {name} = {value}," for name, value in fields)
    lines.append("}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# RIS
# --------------------------------------------------------------------------- #


def _ris_line(tag: str, value: object) -> str:
    return f"{tag}  - {_plain(value)}"


def render_ris(record: ListedPaper) -> str:
    """``record`` as one RIS ``UNPB`` (unpublished work) record.

    Lines end in LF; every importer in common use accepts that, and the text
    pastes cleanly from a browser.  ``ER`` closes the record.
    """
    lines = [
        _ris_line("TY", "UNPB"),
        _ris_line("ID", record.version_id),
        _ris_line("TI", record.version.title),
    ]
    lines.extend(
        _ris_line("AU", did if name is None else _family_first(name))
        for did, name in _author_entries(record)
    )
    listed = _listed_at(record)
    if listed is not None:
        lines.append(_ris_line("PY", listed.year))
        lines.append(_ris_line("DA", listed.strftime("%Y/%m/%d/")))
    lines.append(_ris_line("PB", PUBLISHER))
    lines.append(_ris_line("ET", int(record.version.n)))
    lines.extend(_ris_line("KW", category) for category in record.paper.categories or [])
    note = retraction_note(record)
    if note is not None:
        lines.append(_ris_line("N1", note))
    lines.append("ER  - ")
    return "\n".join(lines) + "\n"


BIBTEX = CitationFormat(
    name="bibtex",
    media_type="application/x-bibtex; charset=utf-8",
    extension="bib",
    render=render_bibtex,
)

RIS = CitationFormat(
    name="ris",
    media_type="application/x-research-info-systems; charset=utf-8",
    extension="ris",
    render=render_ris,
)

#: Every format ``?format=`` accepts, by name.
CITATION_FORMATS: dict[str, CitationFormat] = {BIBTEX.name: BIBTEX, RIS.name: RIS}


def render(record: ListedPaper, format_name: str) -> str:
    """``record`` rendered in the format ``format_name`` names.

    Raises:
        KeyError: ``format_name`` is not in :data:`CITATION_FORMATS`.
    """
    return CITATION_FORMATS[format_name].render(record)
