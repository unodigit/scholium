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
    "INVALID_APPROVAL_SIGNATURE_TYPE",
    "INVALID_GUARDIANS_TYPE",
    "INVALID_KEY_ROTATION_TYPE",
    "INVALID_RECOVERY_REQUEST_TYPE",
    "NOT_A_GUARDIAN_TYPE",
    "RECOVERY_ACCOUNT_NOT_FOUND_TYPE",
    "RECOVERY_GUARDIANS_NOT_SET_TYPE",
    "RECOVERY_REQUEST_NOT_FOUND_TYPE",
    "UNSIGNED_GUARDIAN_CHANGE_TYPE",
    "guardians_required",
    "invalid_approval_signature",
    "invalid_guardians",
    "invalid_key_rotation",
    "invalid_recovery_request",
    "not_a_guardian",
    "recovery_account_not_found",
    "recovery_guardians_not_set",
    "recovery_request_not_found",
    "unsigned_guardian_change",
]

#: Problem type for a submission by an account that has not set its guardians.
GUARDIANS_REQUIRED_TYPE = "urn:scholium:problem:guardians-required"

#: Problem type for a guardian-set change that carries no valid signature.
UNSIGNED_GUARDIAN_CHANGE_TYPE = "urn:scholium:problem:unsigned-guardian-change"

#: Problem type for an approval signed by the wrong key, or not signed at all.
INVALID_APPROVAL_SIGNATURE_TYPE = "urn:scholium:problem:invalid-approval-signature"

#: Problem type for an approval by an account that is not one of the guardians.
NOT_A_GUARDIAN_TYPE = "urn:scholium:problem:not-a-guardian"

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

#: Problem type for a recovery request id that does not exist.
RECOVERY_REQUEST_NOT_FOUND_TYPE = "urn:scholium:problem:recovery-request-not-found"


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


def recovery_request_not_found() -> Any:
    """The ``404`` raised when no recovery request has the given id."""
    from app.errors import ProblemException

    return ProblemException(
        404,
        "No recovery request with that id.",
        type=RECOVERY_REQUEST_NOT_FOUND_TYPE,
    )


def not_a_guardian() -> Any:
    """The ``403`` raised when the caller is not one of the account's guardians.

    An approval must come from a guardian's own session and be signed by that
    guardian's active key; naming somebody else's DID in the body is refused.
    """
    from app.errors import ProblemException

    return ProblemException(
        403,
        "The caller is not a current guardian of this account.",
        type=NOT_A_GUARDIAN_TYPE,
    )


def invalid_approval_signature() -> Any:
    """The ``403`` raised for an approval with no valid guardian signature.

    The signature must be an Ed25519 signature by the caller's active key over
    the request id, the account DID and the new key.
    """
    from app.errors import ProblemException

    return ProblemException(
        403,
        "The approval signature is missing or does not verify against the caller's active key.",
        type=INVALID_APPROVAL_SIGNATURE_TYPE,
    )


def unsigned_guardian_change() -> Any:
    """The ``403`` raised for replacing a set of guardians without a signature.

    A stolen access token must not be enough to redirect an account's
    recovery: changing an existing guardian set requires an Ed25519 signature
    by the account's active key over the new list.
    """
    from app.errors import ProblemException

    return ProblemException(
        403,
        "Changing recovery guardians requires a signature by the account's active key.",
        type=UNSIGNED_GUARDIAN_CHANGE_TYPE,
    )
