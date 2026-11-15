"""Errors raised by the record ingest subsystem.

Every error here is an :class:`app.errors.ProblemException`, so letting one
escape the ``POST /v1/records`` route renders an ``application/problem+json``
response with no extra wiring:

* :class:`UnknownRecordType` and :class:`InvalidRecord` and
  :class:`RecordIdMismatch` -- ``422``;
* :class:`InvalidRecordSignature` -- ``401``;
* :class:`DuplicateRecord` -- ``409``.

The classes are also plain Python exceptions (``LookupError``, ``ValueError``
and ``RuntimeError`` respectively) for callers that would rather catch them
without FastAPI.
"""

from __future__ import annotations

from typing import Any, Sequence

from app.errors import ProblemException

UNKNOWN_RECORD_TYPE = "urn:scholium:problem:unknown-record-type"
INVALID_RECORD = "urn:scholium:problem:invalid-record"
RECORD_ID_MISMATCH = "urn:scholium:problem:record-id-mismatch"
INVALID_RECORD_SIGNATURE = "urn:scholium:problem:record-signature-invalid"
DUPLICATE_RECORD = "urn:scholium:problem:duplicate-record"

_MAX_ECHO = 64


def _show(value: object) -> object:
    """Echo a client-supplied value, clipped so a huge string cannot bloat a problem."""
    if isinstance(value, str) and len(value) > _MAX_ECHO:
        return value[: _MAX_ECHO - 3] + "..."
    return value


def _error(loc: Sequence[Any], msg: str, kind: str, value: object = None) -> dict[str, Any]:
    """One FastAPI-shaped field error entry."""
    return {
        "loc": list(loc),
        "msg": msg,
        "type": kind,
        "input": _show(value),
    }


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


class InvalidRecord(ProblemException, ValueError):
    """The submission is not a valid signed record envelope: ``422`` problem details.

    ``errors`` is a list of field errors in the same shape FastAPI uses for a
    request-body validation failure, so a client can point at the offending
    field.  Each entry is either a ready-made mapping (as produced by the
    record core's body validator, folded into ``body``) or a message string.
    """

    def __init__(self, errors: Sequence[Any] | str, detail: str = "The record envelope is invalid.") -> None:
        if isinstance(errors, str):
            errors = [errors]
        self.record_errors = [
            error
            if isinstance(error, dict)
            else _error(["body"], str(error), "invalid_record", None)
            for error in errors
        ]
        super().__init__(422, detail, type=INVALID_RECORD, errors=self.record_errors)


class RecordIdMismatch(ProblemException, ValueError):
    """A record's ``id`` is not the CID of its content: ``422`` problem details."""

    def __init__(self, claimed: object, recomputed: str) -> None:
        self.claimed = claimed
        self.recomputed = recomputed
        message = (
            "The record's 'id' does not match the CID recomputed from its "
            f"content ({recomputed})."
        )
        super().__init__(
            422,
            message,
            type=RECORD_ID_MISMATCH,
            errors=[_error(["body", "id"], message, "record_id_mismatch", claimed)],
        )


class InvalidRecordSignature(ProblemException, ValueError):
    """The record's signature does not verify against its author's key: ``401``.

    A record is self-authenticating: this refusal is about the signature, not
    about the caller's access token, so no ``WWW-Authenticate`` challenge is
    attached.
    """

    def __init__(self, author: object = None) -> None:
        self.author = author
        message = (
            "The record's 'sig' does not verify against the author's active "
            "signing key."
        )
        super().__init__(401, message, type=INVALID_RECORD_SIGNATURE)


class DuplicateRecord(ProblemException, ValueError):
    """A record with this CID is already in the event log: ``409`` problem details."""

    def __init__(self, record_id: object = None) -> None:
        self.record_id = record_id
        message = "A record with this id is already in this node's event log."
        super().__init__(409, message, type=DUPLICATE_RECORD)
