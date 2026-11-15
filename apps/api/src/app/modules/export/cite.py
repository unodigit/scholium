"""``GET /v1/papers/{id}/cite`` -- a paper's citation as BibTeX or RIS (feature 90).

The module loader mounts this package's ``router`` under ``/v1``, so a reader
copies a citation with::

    GET /v1/papers/sch:xxxx-xxxx-xxxx/cite?format=bibtex

    200 OK
    Content-Type: application/x-bibtex; charset=utf-8

    @misc{sch-xxxx-xxxx-xxxx-v2,
      title = {{...}},
      ...
      eprint = {sch:xxxx-xxxx-xxxx/v2},
    }

``format`` is ``bibtex`` (the default) or ``ris`` -- any letter case.  Anything
else is ``422`` problem details, the app's answer for a bad query parameter.

``{id}`` is every spelling ``GET /v1/papers/{id}`` accepts: a paper ``sch:`` id
(the citation names the paper's latest listed version), a version id
``sch:xxxx-xxxx-xxxx/vN`` (that version) or a version cid.  The OAI identifier
this node mints (``oai:scholium:sch:...``) works too.  The path parameter takes
slashes, which is what lets a version id sit in it unescaped.

The citation always carries the ``sch:`` *version* id of the text it describes,
and a retraction note when the paper is retracted; what each format holds is in
:mod:`app.modules.export.citation`.  Citing is public, like reading: an unlisted
paper is indistinguishable from an unknown one and answers ``404`` problem
details, exactly as ``GET /v1/papers/{id}`` does.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Query, Response

from .citation import CITATION_FORMATS, DEFAULT_FORMAT
from .records import find_listed

__all__ = [
    "PAPER_NOT_FOUND_TYPE",
    "UNSUPPORTED_FORMAT_TYPE",
    "router",
]

#: Problem-details type URN for an id that names no listed paper.
PAPER_NOT_FOUND_TYPE = "urn:scholium:problem:paper-not-found"

#: Problem-details type URN for a ``format`` this endpoint does not serve.
UNSUPPORTED_FORMAT_TYPE = "urn:scholium:problem:unsupported-citation-format"

#: Router the module loader mounts under ``/v1`` (serves the cite route).
router = APIRouter(tags=["export"])


def _shown(text: str) -> str:
    """``text`` shortened for an error message."""
    return text if len(text) <= 60 else text[:57] + "..."


def _not_found(identifier: str):
    # Imported at raise time, not module load: importing app.errors pulls in
    # app.main, and doing that while the module loader imports packages would
    # leave this package half-initialized without a `router` attribute (the
    # same care the other plugins take).
    from app.errors import ProblemException

    return ProblemException(
        404,
        f"No listed paper {_shown(identifier)!r} is on this node.",
        type=PAPER_NOT_FOUND_TYPE,
    )


def _unsupported_format(requested: str):
    from app.errors import ProblemException

    supported = " or ".join(repr(name) for name in CITATION_FORMATS)
    return ProblemException(
        422,
        f"Unsupported citation format {_shown(requested)!r}: use {supported}.",
        type=UNSUPPORTED_FORMAT_TYPE,
    )


def _filename(version_id: str, extension: str) -> str:
    """A safe download filename: ``sch-xxxx-xxxx-xxxx-v2.bib``."""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", version_id.replace("/", "-")).strip("-")
    return f"{stem or 'paper'}.{extension}"


# ``{paper_id:path}`` rather than ``{paper_id}``: a version id contains a slash.
# The catalog's ``/papers/{paper_id}``, ``/papers/{paper_id}/v{n}`` and
# ``/papers/{paper_id}/versions`` cannot claim ``.../cite``, so there is no
# ordering to maintain between the two plugins.
@router.get(
    "/papers/{paper_id:path}/cite",
    response_class=Response,
    summary="Cite a paper version as BibTeX or RIS",
)
def cite_paper(
    paper_id: str,
    format: str = Query(
        DEFAULT_FORMAT,
        description="citation format: bibtex or ris",
    ),
) -> Response:
    """Return the citation of the version ``paper_id`` names, in ``format``."""
    chosen = CITATION_FORMATS.get(format.strip().lower())
    if chosen is None:
        raise _unsupported_format(format)

    record = find_listed(paper_id)
    if record is None:
        raise _not_found(paper_id)

    return Response(
        content=chosen.render(record),
        media_type=chosen.media_type,
        headers={
            "Content-Disposition": (
                f'inline; filename="{_filename(record.version_id, chosen.extension)}"'
            ),
        },
    )
