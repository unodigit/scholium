"""Where arXiv metadata comes from (plugin: imports).

:func:`parse_arxiv_id` turns whatever a client typed into an :class:`ArxivId`,
and :func:`fetch_metadata` returns the ``external.mirror`` ``metadata`` object
for it:

``ARXIV_MOCK=1`` (the default, as for ORCID)
    No network.  Every well-formed id resolves to deterministic metadata derived
    from the id itself (see :func:`mock_metadata`), except ids whose sequence
    number is all nines (``2401.99999``, ``hep-th/9999999``), which arXiv
    "does not know" -- that gives tests a 404 without a second switch.

``ARXIV_MOCK=0``
    One request to the arXiv API (``ARXIV_API_URL``, default
    ``https://export.arxiv.org/api/query``) with ``id_list=<id>``; the Atom
    entry that comes back is reduced to the same metadata shape by
    :func:`parse_atom_entry`.

The id is validated against a strict grammar before it goes anywhere near a
URL, the endpoint is fixed by configuration (never by the client), the
response is size-capped, and a response that declares a DTD is refused, so an
unfriendly feed cannot expand entities.  Links in the metadata are rebuilt from
the validated id rather than copied from the feed.
"""

from __future__ import annotations

import os
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from app.settings import settings

from .errors import ArxivNotFound, ArxivUnavailable, InvalidArxivId

__all__ = [
    "ARXIV_API_URL",
    "ArxivId",
    "arxiv_api_url",
    "fetch_metadata",
    "mock_enabled",
    "mock_metadata",
    "parse_arxiv_id",
    "parse_atom_entry",
]

#: arXiv's query API, used unless ``ARXIV_API_URL`` is set in the environment.
ARXIV_API_URL = "https://export.arxiv.org/api/query"

#: Largest Atom response read from arXiv (one entry is a few KiB).
MAX_FEED_BYTES = 1024 * 1024

_TIMEOUT_SECONDS = 15.0

_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV = "{http://arxiv.org/schemas/atom}"

# New-style ids: YYMM.NNNN (2007-2014) or YYMM.NNNNN (2015 on).
_NEW_STYLE = r"\d{4}\.\d{4,5}"
# Old-style ids: archive[.SC]/YYMMNNN, e.g. hep-th/9901001, math.GT/0309136.
_OLD_STYLE = r"[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?/\d{7}"
_ID = re.compile(rf"^(?P<base>{_NEW_STYLE}|{_OLD_STYLE})(?:v(?P<version>[1-9]\d{{0,3}}))?$")
_URL_PREFIX = re.compile(r"^https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/", re.IGNORECASE)
_SCHEME_PREFIX = re.compile(r"^arxiv:", re.IGNORECASE)
_DTD = re.compile(rb"<!\s*(?:DOCTYPE|ENTITY)", re.IGNORECASE)


@dataclass(frozen=True)
class ArxivId:
    """A validated arXiv identifier."""

    #: The id without a version: ``2401.00001`` or ``hep-th/9901001``.
    base: str
    #: The version the client asked for, or ``None`` for "the latest".
    version: Optional[int] = None

    @property
    def source(self) -> str:
        """The ``external.mirror`` ``source``: ``arXiv:<base id>``."""
        return f"arXiv:{self.base}"

    @property
    def abs_url(self) -> str:
        return f"https://arxiv.org/abs/{self.base}"

    @property
    def pdf_url(self) -> str:
        return f"https://arxiv.org/pdf/{self.base}"

    @property
    def query_id(self) -> str:
        """The value for the API's ``id_list``: versioned when a version was asked for."""
        return self.base if self.version is None else f"{self.base}v{self.version}"


def parse_arxiv_id(value: object) -> ArxivId:
    """Return the :class:`ArxivId` ``value`` names, or raise :class:`InvalidArxivId`.

    Accepts the bare id, an ``arXiv:`` prefix, or an ``arxiv.org/abs|pdf`` URL
    (a trailing ``.pdf`` is dropped), each with an optional ``vN`` suffix.
    """
    if not isinstance(value, str):
        raise InvalidArxivId(value, "The arXiv id must be a string.")
    text = value.strip()
    text = _SCHEME_PREFIX.sub("", text, count=1)
    if _URL_PREFIX.match(text):
        text = _URL_PREFIX.sub("", text, count=1)
        if text.lower().endswith(".pdf"):
            text = text[: -len(".pdf")]
    match = _ID.match(text)
    if match is None:
        raise InvalidArxivId(value)
    version = match.group("version")
    return ArxivId(match.group("base"), int(version) if version else None)


def mock_enabled() -> bool:
    """Whether metadata is generated locally (``ARXIV_MOCK``), read on every call."""
    return bool(settings.ARXIV_MOCK)


def arxiv_api_url() -> str:
    """The arXiv API endpoint: ``ARXIV_API_URL`` when set, else :data:`ARXIV_API_URL`."""
    return os.getenv("ARXIV_API_URL", "").strip() or ARXIV_API_URL


# --------------------------------------------------------------------------- #
# Mock
# --------------------------------------------------------------------------- #


def _sequence(ident: ArxivId) -> str:
    return ident.base.rsplit("/", 1)[-1].rsplit(".", 1)[-1]


def _mock_published(ident: ArxivId) -> str:
    """The submission month encoded in the id (``YYMM``), as a timestamp."""
    yymm = ident.base.rsplit("/", 1)[-1][:4]
    year = int(yymm[:2])
    # arXiv ids carry a two-digit year: old-style ids run 91-07, new-style 07 on.
    century = 1900 if "/" in ident.base and year >= 91 else 2000
    month = int(yymm[2:]) or 1
    return f"{century + year:04d}-{min(month, 12):02d}-01T00:00:00Z"


def mock_metadata(ident: ArxivId) -> dict[str, Any]:
    """The deterministic metadata ``ARXIV_MOCK=1`` serves for ``ident``.

    Raises :class:`ArxivNotFound` for the all-nines sequence numbers the mock
    treats as unknown to arXiv.
    """
    if set(_sequence(ident)) == {"9"}:
        raise ArxivNotFound(ident.base)
    if "/" in ident.base:  # old-style: the archive is the category
        categories = [ident.base.split("/", 1)[0].split(".", 1)[0]]
    else:
        categories = ["cs.LG", "stat.ML"]
    published = _mock_published(ident)
    return {
        "title": f"Mock arXiv paper {ident.base}",
        "abstract": f"This is mock metadata for arXiv:{ident.base}, served because ARXIV_MOCK=1.",
        "authors": ["Ada Mock", "Grace Mock"],
        "categories": categories,
        "arxivId": ident.base,
        "version": f"v{ident.version or 1}",
        "published": published,
        "updated": published,
        "url": ident.abs_url,
        "pdfUrl": ident.pdf_url,
    }


# --------------------------------------------------------------------------- #
# Live
# --------------------------------------------------------------------------- #


def _fetch_atom(ident: ArxivId) -> bytes:
    """Ask the arXiv API for ``ident`` and return the raw Atom response."""
    params = {"id_list": ident.query_id, "max_results": "1"}
    chunks: list[bytes] = []
    size = 0
    try:
        with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
            with client.stream(
                "GET", arxiv_api_url(), params=params, headers={"User-Agent": "scholium-node"}
            ) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_FEED_BYTES:
                        raise ArxivUnavailable("the response is larger than expected.")
                    chunks.append(chunk)
    except httpx.HTTPStatusError as exc:
        raise ArxivUnavailable(f"arXiv answered HTTP {exc.response.status_code}.") from exc
    except httpx.HTTPError as exc:
        raise ArxivUnavailable(f"the request failed ({type(exc).__name__}).") from exc
    return b"".join(chunks)


def _text(element: Optional[ET.Element]) -> str:
    """The whitespace-normalised text of ``element`` ('' when absent)."""
    if element is None or element.text is None:
        return ""
    return " ".join(element.text.split())


def parse_atom_entry(data: bytes, ident: ArxivId) -> dict[str, Any]:
    """Reduce an arXiv Atom response for ``ident`` to ``external.mirror`` metadata.

    Raises :class:`ArxivNotFound` when the feed has no entry for the paper (or
    only arXiv's error entry), and :class:`ArxivUnavailable` when the response
    is not usable Atom or describes some other paper.
    """
    if _DTD.search(data):
        raise ArxivUnavailable("the response declares a DTD.")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ArxivUnavailable("the response is not valid Atom XML.") from exc

    entry = root.find(f"{_ATOM}entry")
    if entry is None:
        raise ArxivNotFound(ident.base)

    entry_id = _text(entry.find(f"{_ATOM}id"))
    if "/api/errors" in entry_id:
        # arXiv reports a bad or unknown id as a single error entry.
        raise ArxivNotFound(ident.base)
    try:
        answered = parse_arxiv_id(entry_id)
    except InvalidArxivId as exc:
        raise ArxivUnavailable("the entry carries no arXiv id.") from exc
    if answered.base != ident.base:
        raise ArxivUnavailable("the response describes a different paper.")

    title = _text(entry.find(f"{_ATOM}title"))
    if not title:
        raise ArxivUnavailable("the entry has no title.")

    authors = [name for name in (_text(a.find(f"{_ATOM}name")) for a in entry.findall(f"{_ATOM}author")) if name]
    categories: list[str] = []
    for category in entry.findall(f"{_ATOM}category"):
        term = (category.get("term") or "").strip()
        if term and term not in categories:
            categories.append(term)

    published = _text(entry.find(f"{_ATOM}published"))
    metadata: dict[str, Any] = {
        "title": title,
        "abstract": _text(entry.find(f"{_ATOM}summary")),
        "authors": authors,
        "categories": categories,
        "arxivId": ident.base,
        "version": f"v{answered.version or 1}",
        "published": published,
        "updated": _text(entry.find(f"{_ATOM}updated")) or published,
        "url": ident.abs_url,
        "pdfUrl": ident.pdf_url,
    }
    doi = _text(entry.find(f"{_ARXIV}doi"))
    if doi:
        metadata["doi"] = doi
    return metadata


def fetch_metadata(ident: ArxivId) -> dict[str, Any]:
    """Return the ``external.mirror`` ``metadata`` for ``ident`` (mock or live)."""
    if mock_enabled():
        return mock_metadata(ident)
    return parse_atom_entry(_fetch_atom(ident), ident)
