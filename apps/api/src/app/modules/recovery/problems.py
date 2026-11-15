"""RFC 9457 problem documents raised by the recovery plugin.

Both builders import :class:`app.errors.ProblemException` when they are called,
not when this module loads: importing ``app.errors`` pulls in ``app.main``, and
if this package were imported before ``app.main`` the module loader would then
see ``app.modules.recovery`` half-initialized with no ``router`` attribute and
silently skip mounting it.
"""

from __future__ import annotations

from typing import Any, Sequence

__all__ = [
    "GUARDIANS_REQUIRED_TYPE",
    "INVALID_GUARDIANS_TYPE",
    "guardians_required",
    "invalid_guardians",
]

#: Problem type for a submission by an account that has not set its guardians.
GUARDIANS_REQUIRED_TYPE = "urn:scholium:problem:guardians-required"

#: Problem type for a guardian list that cannot be saved.
INVALID_GUARDIANS_TYPE = "urn:scholium:problem:invalid-guardians"


def guardians_required(required: int) -> Any:
    """The ``403`` raised when an account submits before setting its guardians."""
    from app.errors import ProblemException

    return ProblemException(
        403,
        f"Set your {required} recovery guardians with PUT /v1/me/guardians before submitting.",
        type=GUARDIANS_REQUIRED_TYPE,
    )


def invalid_guardians(problems: Sequence[dict[str, Any]]) -> Any:
    """The ``422`` raised for a guardian list that fails validation.

    ``problems`` are FastAPI-style error entries (``loc``, ``msg``, ``type``),
    reported as the document's ``errors`` member, one per fault.
    """
    from app.errors import ProblemException

    return ProblemException(
        422,
        "The guardian list is not valid.",
        type=INVALID_GUARDIANS_TYPE,
        errors=list(problems),
    )
