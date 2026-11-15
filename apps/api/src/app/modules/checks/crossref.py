"""Resolving DOIs through Crossref (feature 67), only when ``CROSSREF_ENABLED=1``.

::

    from app.modules.checks import crossref

    crossref.crossref_enabled()              # True only for CROSSREF_ENABLED=1
    crossref.resolve_dois(["10.1038/nature12373"])
    # {"10.1038/nature12373": True}

A DOI is *resolved* when Crossref's agency lookup (``/works/{doi}/agency``)
knows it.  That endpoint answers for every DOI Crossref can route, including
those registered with another agency (arXiv's DataCite DOIs are common in
reference lists), where ``/works/{doi}`` would answer 404 for a perfectly good
citation.  An unknown DOI is a 404 and is *unresolved*.

Network use is opt-in.  The flag is read from the environment on every call
(``settings.py`` does not carry it), and only the exact value ``1`` enables
it, like the ``*_MOCK`` switches.  :func:`resolve_dois` does not look at the
flag itself -- callers decide whether to resolve at all (see
:func:`~app.modules.checks.results.save_reference_check`) -- so it is also
usable from a script with an explicit client.

Failure is not a verdict.  A timeout, an unreachable host, a 429 or a 5xx
raises :class:`~app.modules.checks.errors.CrossrefError` and no partial answer
is returned: a DOI that could not be asked about must never be reported as
unresolved, or an outage would be recorded against the author.  Lookups are
sequential, which keeps within Crossref's public rate limit, and each distinct
DOI is asked about once however often it is cited.

Requests identify the client generically (no contact address).  Operators who
want Crossref's "polite pool" can inject a client that sends their own
``User-Agent`` or ``mailto``.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Optional
from urllib.parse import quote

import httpx

from .errors import CrossrefError

__all__ = [
    "CROSSREF_API",
    "MAX_LOOKUPS",
    "crossref_enabled",
    "resolve_dois",
]

#: Base URL of the Crossref REST API.
CROSSREF_API = "https://api.crossref.org"

#: Distinct DOIs looked up per call.  A reference list is a few dozen to a few
#: hundred entries; a text with thousands of DOIs is padding, and should not
#: turn one check into thousands of requests against a third party.  DOIs
#: beyond the limit are *not* looked up, so they count as unresolved.
MAX_LOOKUPS = 1000

_TIMEOUT = 10.0
_USER_AGENT = "scholium-checks/0.1 (reference check)"

#: Statuses that mean "try again later", not "no such DOI".
_TRANSIENT = frozenset({408, 425, 429})


def crossref_enabled() -> bool:
    """Whether DOIs may be resolved through Crossref (``CROSSREF_ENABLED=1``)."""
    return os.getenv("CROSSREF_ENABLED", "").strip() == "1"


def resolve_dois(
    dois: Iterable[str], *, client: Optional[httpx.Client] = None
) -> dict[str, bool]:
    """Ask Crossref about each DOI.

    Args:
        dois: DOIs as found in text (``10.1000/xyz``).  Case is ignored (DOIs
            are case-insensitive) and repeats are asked about once.
        client: an ``httpx.Client`` to use, e.g. with a mock transport.  By
            default one is created for this call and closed afterwards.

    Returns:
        ``{doi: resolved}`` for every distinct DOI, keyed by its lowercase
        form.  DOIs beyond :data:`MAX_LOOKUPS` are included as ``False``
        without a request.

    Raises:
        CrossrefError: if Crossref cannot be asked or does not answer
            properly for some DOI (nothing is returned).
    """
    wanted = list(dict.fromkeys(doi.strip().lower() for doi in dois if doi.strip()))
    if not wanted:
        return {}

    owned = client is None
    http = client if client is not None else httpx.Client(
        timeout=_TIMEOUT, headers={"User-Agent": _USER_AGENT}
    )
    try:
        results = {doi: False for doi in wanted}
        for doi in wanted[:MAX_LOOKUPS]:
            results[doi] = _lookup(http, doi)
        return results
    finally:
        if owned:
            http.close()


def _lookup(client: httpx.Client, doi: str) -> bool:
    """Whether Crossref's agency lookup knows ``doi``."""
    url = f"{CROSSREF_API}/works/{quote(doi, safe='/')}/agency"
    try:
        response = client.get(url)
    except httpx.HTTPError as exc:
        # Timeouts, refused connections, TLS failures: all "could not ask".
        raise CrossrefError(
            f"cannot reach Crossref for DOI {doi!r}: {type(exc).__name__}: {exc}"
        ) from exc

    status = response.status_code
    if status == 200:
        return True
    if status >= 500 or status in _TRANSIENT:
        raise CrossrefError(f"Crossref answered {status} for DOI {doi!r}")
    if 400 <= status < 500:
        # 404 is "no such DOI"; Crossref answers a DOI it cannot parse the same
        # way (404/400), and neither is a DOI it can route.
        return False
    # 1xx/3xx never come from the API without a redirect we did not ask for.
    raise CrossrefError(f"Crossref answered an unexpected {status} for DOI {doi!r}")
