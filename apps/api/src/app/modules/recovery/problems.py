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
    "INVALID_RECOVERY_REQUEST_TYPE",
    "RECOVERY_ACCOUNT_NOT_FOUND_TYPE",
    "RECOVERY_GUARDIANS_NOT_SET_TYPE",
    "guardians_required",
    "invalid_guardians",
    "invalid_key_rotation",
    "invalid_recovery_request",
    "recovery_account_not_found",
    "recovery_guardians_not_set",
]

#: Problem type for a submission by an account that has not set its guardians.
GUARDIANS_REQUIRED_TYPE = "urn:scholium:problem:guardians-required"

#: Problem type for a guardian list that cannot be saved.
INVALID_GUARDIANS_TYPE = "urn:scholium:problem:invalid-guardians"

#: Problem type for a ``key.rotation`` record whose new key cannot be activated.
INVALID_KEY_ROTATION_TYPE = "urn:scholium:problem:invalid-key-rotation"

#: Problem type for a recovery request whose ORCID iD or new key is malformed.
INVALID_RECOVERY_REQUEST_TYPE = "urn:scholium:problem:invalid-recovery-request"

#: Problem type for a recovery request naming an ORCID iD no account is linked to.
RECOVERY_ACCOUNT_NOT_FOUND_TYPE = "urn:scholium:problem:recovery-account-not-found"

#: Problem type for a recovery request against an account with no guardians to ask.
RECOVERY_GUARDIANS_NOT_SET_TYPE = "urn:scholium:problem:recovery-guardians-not-set"


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


def invalid_recovery_request(errors: Sequence[dict[str, Any]]) -> Any:
    """The ``422`` raised for a recovery request that is not well formed.

    ``errors`` are FastAPI-style error entries (``loc``, ``msg``, ``type``),
    reported as the document's ``errors`` member, one per fault.  Nothing is
    saved and nobody is notified.
    """
    from app.errors import ProblemException

    return ProblemException(
        422,
        "The recovery request is not valid.",
        type=INVALID_RECOVERY_REQUEST_TYPE,
        errors=list(errors),
    )


def recovery_account_not_found() -> Any:
    """The ``404`` raised when no account is linked to the ORCID iD asked about.

    The iD is deliberately not echoed back, and the account's DID is never
    revealed: this endpoint is open to anyone who knows an iD.
    """
    from app.errors import ProblemException

    return ProblemException(
        404,
        "No account is linked to that ORCID iD.",
        type=RECOVERY_ACCOUNT_NOT_FOUND_TYPE,
    )


def recovery_guardians_not_set(required: int) -> Any:
    """The ``409`` raised when the account has no complete guardian set to notify.

    A recovery is approved by guardians, so an account that never named its
    ``required`` of them has nobody who could approve one.
    """
    from app.errors import ProblemException

    return ProblemException(
        409,
        f"That account has not set its {required} recovery guardians, so there is nobody to approve a recovery.",
        type=RECOVERY_GUARDIANS_NOT_SET_TYPE,
    )
