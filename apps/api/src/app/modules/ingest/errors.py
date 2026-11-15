"""Errors raised by the record ingest subsystem."""

from __future__ import annotations

from app.errors import ProblemException

UNKNOWN_RECORD_TYPE = "urn:scholium:problem:unknown-record-type"

_MAX_ECHO = 64


class UnknownRecordType(ProblemException, LookupError):
    """No handler is registered for a record type: ``422`` problem details.

    It is an ``HTTPException`` (through :class:`app.errors.ProblemException`),
    so letting it escape a route renders an ``application/problem+json``
    response with no extra wiring. It is also a ``LookupError`` for callers
    that would rather catch it in plain Python.

    The offending value is reported the way FastAPI reports a bad request
    field, as an ``errors`` entry located at ``body.type``, and it is also kept
    on :attr:`record_type`. Only strings are echoed back, and long ones are
    truncated, since the value comes straight from the client.
    """

    def __init__(self, record_type: object) -> None:
        self.record_type = record_type
        if isinstance(record_type, str):
            shown = record_type if len(record_type) <= _MAX_ECHO else record_type[: _MAX_ECHO - 3] + "..."
            message = f"No handler is registered for record type {shown!r}."
            echoed: object = shown
        else:
            message = f"A record type must be a string, got {type(record_type).__name__}."
            echoed = None
        super().__init__(
            422,
            message,
            type=UNKNOWN_RECORD_TYPE,
            errors=[
                {
                    "loc": ["body", "type"],
                    "msg": message,
                    "type": "unknown_record_type",
                    "input": echoed,
                }
            ],
        )
