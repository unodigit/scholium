"""Errors raised by the import subsystem (plugin: imports).

Every error here is an :class:`app.errors.ProblemException`, so letting one
escape a route renders an ``application/problem+json`` response with no extra
wiring:

* :class:`InvalidArxivId` -- ``422``: the request does not name an arXiv paper;
* :class:`ArxivNotFound` -- ``404``: arXiv has no paper with that id;
* :class:`AlreadyImported` -- ``409``: this node already mirrors that paper;
* :class:`ArxivUnavailable` -- ``502``: arXiv could not be reached or answered
  with something unusable;
* :class:`NodeKeyUnavailable` -- ``503``: this node has no signing key.
"""

from __future__ import annotations

from typing import Optional

from app.errors import ProblemException

INVALID_ARXIV_ID = "urn:scholium:problem:invalid-arxiv-id"
ARXIV_NOT_FOUND = "urn:scholium:problem:arxiv-not-found"
ALREADY_IMPORTED = "urn:scholium:problem:already-imported"
ARXIV_UNAVAILABLE = "urn:scholium:problem:arxiv-unavailable"
#: Same URN the signed sync head uses for a node without a usable key.
NODE_KEY_UNAVAILABLE = "urn:scholium:problem:node-key-unavailable"

_MAX_ECHO = 64


def _show(value: object) -> str:
    """Echo a client-supplied value, clipped so a huge string cannot bloat a problem."""
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= _MAX_ECHO else text[: _MAX_ECHO - 3] + "..."


class InvalidArxivId(ProblemException, ValueError):
    """The submitted value is not an arXiv identifier: ``422`` problem details."""

    def __init__(self, value: object, reason: Optional[str] = None) -> None:
        self.value = value
        message = reason or (
            f"{_show(value)!r} is not an arXiv identifier. Use a new-style id "
            "such as '2401.00001' (optionally with a version, 'arXiv:' prefix or "
            "abs URL) or an old-style id such as 'hep-th/9901001'."
        )
        super().__init__(
            422,
            message,
            type=INVALID_ARXIV_ID,
            errors=[
                {
                    "loc": ["body", "arxiv_id"],
                    "msg": message,
                    "type": "invalid_arxiv_id",
                    "input": _show(value) if isinstance(value, str) else None,
                }
            ],
        )


class ArxivNotFound(ProblemException, LookupError):
    """arXiv has no paper with this id: ``404`` problem details."""

    def __init__(self, arxiv_id: str) -> None:
        self.arxiv_id = arxiv_id
        super().__init__(
            404,
            f"arXiv has no paper with id {arxiv_id!r}.",
            type=ARXIV_NOT_FOUND,
        )


class AlreadyImported(ProblemException, ValueError):
    """This node already mirrors the paper: ``409`` problem details.

    ``record_id`` is the cid of the ``external.mirror`` record that is already
    in the log; it is named in the problem's ``detail`` too, since the app's
    problem renderer does not carry extension members.
    """

    def __init__(self, source: str, record_id: str) -> None:
        self.source = source
        self.record_id = record_id
        super().__init__(
            409,
            f"{source} is already mirrored by this node (record {record_id}).",
            type=ALREADY_IMPORTED,
        )


class ArxivUnavailable(ProblemException, RuntimeError):
    """arXiv could not be reached or answered unusably: ``502`` problem details."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(
            502,
            f"The arXiv API could not provide this paper's metadata: {reason}",
            type=ARXIV_UNAVAILABLE,
        )


class NodeKeyUnavailable(ProblemException, RuntimeError):
    """This node has no usable signing key: ``503`` problem details."""

    def __init__(self, key_path: object = None) -> None:
        self.key_path = key_path
        where = f" at NODE_KEY_PATH ({key_path!r})" if key_path else ""
        super().__init__(
            503,
            "This node cannot sign records: no usable Ed25519 key was found"
            f"{where}.",
            type=NODE_KEY_UNAVAILABLE,
        )
