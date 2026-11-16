"""Keep review records on the review endpoints (plugin: reviews).

A ``review.commit`` is signed by the reviewer's pseudonymous per-paper key, so
the record itself says nothing about who is asking.  The rules that make a
review acceptable -- a tier-3 caller, not an author of the paper, one review per
person and paper, and an identity escrowed for the committee -- therefore live
on ``POST /v1/reviews/commit`` (and, for the other review types, on their own
routes), where the access token supplies that caller.

``POST /v1/records`` has no caller identity to offer.  A review record arriving
there would otherwise be validated only for its envelope, signature and author
tier -- never for the caller-level rules -- so the ingest handlers refuse one
unless the request came from the dedicated endpoint.  The dedicated endpoints
enter :func:`dedicated_ingest` around their call to
:func:`app.modules.ingest.service.ingest`; the handler checks it before doing
anything else.

The marker is a :class:`~contextvars.ContextVar`, so it is per request (and per
thread, which is how FastAPI runs these synchronous endpoints) and cannot leak
from one caller to the next.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

__all__ = [
    "REVIEW_RECORD_ROUTE",
    "dedicated_ingest",
    "in_dedicated_route",
    "require_dedicated_route",
]

#: Problem-details type URN for a review record submitted to ``POST /v1/records``.
REVIEW_RECORD_ROUTE = "urn:scholium:problem:review-record-route"

#: True only while the current request is inside a review endpoint's ingest call.
_IN_DEDICATED_ROUTE: ContextVar[bool] = ContextVar(
    "reviews_in_dedicated_route", default=False
)


@contextmanager
def dedicated_ingest() -> Iterator[None]:
    """Mark the enclosed :func:`ingest` call as coming from a review endpoint."""
    token = _IN_DEDICATED_ROUTE.set(True)
    try:
        yield
    finally:
        _IN_DEDICATED_ROUTE.reset(token)


def in_dedicated_route() -> bool:
    """Whether the current ingest call came from a review endpoint."""
    return _IN_DEDICATED_ROUTE.get()


def require_dedicated_route(record_type: str, endpoint: str) -> None:
    """Refuse a review record that did not arrive through its own endpoint (``422``).

    Raises:
        ProblemException: ``422`` -- the record type is only accepted on
            ``endpoint``, which is where the caller-level review rules run.
    """
    if _IN_DEDICATED_ROUTE.get():
        return
    # Imported at raise time: importing app.errors pulls in app.main, and the
    # module loader must not see a half-initialized package during app assembly.
    from app.errors import ProblemException

    message = (
        f"A {record_type} is a review record and must be submitted to {endpoint}, "
        "not to POST /v1/records: only the review endpoints know the caller the "
        "review rules are checked against."
    )
    raise ProblemException(
        422,
        message,
        type=REVIEW_RECORD_ROUTE,
        errors=[
            {
                "loc": ["body", "type"],
                "msg": message,
                "type": "dedicated_review_route_required",
                "input": record_type,
            }
        ],
    )
