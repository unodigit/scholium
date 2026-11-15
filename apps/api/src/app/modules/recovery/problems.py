"""RFC 9457 problem documents raised by the recovery plugin.

Every builder imports :class:`app.errors.ProblemException` when it is called,
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
    "INVALID_KEY_ROTATION_TYPE",
    "guardians_required",
    "invalid_guardians",
    "invalid_key_rotation",
]

#: Problem type for a submission by an account that has not set its guardians.
GUARDIANS_REQUIRED_TYPE = "urn:scholium:problem:guardians-required"

#: Problem type for a guardian list that cannot be saved.
INVALID_GUARDIANS_TYPE = "urn:scholium:problem:invalid-guardians"

#: Problem type for a ``key.rotation`` record whose new key cannot be activated.
INVALID_KEY_ROTATION_TYPE = "urn:scholium:problem:invalid-key-rotation"


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


def invalid_key_rotation(errors: Sequence[dict[str, Any]]) -> Any:
    """The ``422`` raised for a ``key.rotation`` record that cannot be applied.

    ``errors`` are FastAPI-style error entries (``loc``, ``msg``, ``type``),
    reported as the document's ``errors`` member, one per fault.  Nothing is
    recorded in ``account_keys`` and no key window is touched.
    """
    from app.errors import ProblemException

    return ProblemException(
        422,
        "The key rotation record is not valid.",
        type=INVALID_KEY_ROTATION_TYPE,
        errors=list(errors),
    )
