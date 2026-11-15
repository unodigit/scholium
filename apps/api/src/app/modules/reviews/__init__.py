"""Reviews plugin (plugin: reviews).

Feature 105: ``POST /v1/papers/{id}/review-invitations`` saves an invitation
to the ``review_invitations`` table, from an author or tier-4 member to a
tier-3 reviewer in the paper category.

Feature 106: ``GET /v1/papers/{id}/coi-check`` returns the conflict-of-interest
checks for the calling reviewer -- not an author, no co-authorship with an
author in the last 3 years, and a different institution from every author.
See :mod:`app.modules.reviews.coi`.

Feature 107: ``POST /v1/reviews/commit`` accepts a signed ``review.commit``
(target version, commitment, per-paper review key, nullifier) from a tier-3
member, saves it to the ``review`` table, and refuses a second review by the
same person on the same paper (``409``) or an author reviewing their own
paper (``403``).  See :mod:`app.modules.reviews.service`.

Feature 108: each committed review's reviewer identity -- the authenticated
caller, not the record's pseudonymous author -- is saved to the
``review_escrows`` table only as a sealed box ``Enc(committee_public_key,
reviewer_did)``.  Uniqueness is tracked by an HMAC token over the DID and the
paper cid, never by a plaintext mapping.  See
:mod:`app.modules.reviews.escrow`.

Feature 109: ``POST /v1/reviews/reveal`` accepts a signed ``review.formal``
that opens a sealed review.  The rubric must be complete -- a score 1-5 with a
justification for soundness, evidence, reproducibility, novelty, clarity and
limitations, plus a confidence and a recommendation -- or the review is refused
(``422``), as free text alone is; and the record must match its commitment: the
review key sealed a review on the version, the record carries that commit's
``commitment`` and the revealed content hashes to it (``422``).  An accepted
reveal fills in the ``review`` row's revealed columns.  See
:mod:`app.modules.reviews.reveal`.

Feature 113: ``POST /v1/reviews/{cid}/rating`` records a tier-3 member's
quality rating of a review in ``review_ratings``.

Feature 114: ``POST /v1/reviews/{cid}/response`` accepts a signed
``review.response`` from a paper author -- one reply per rubric dimension,
answering the review point by point -- and saves the replies to
``review_responses``.  A caller who is not on the paper's byline is refused
(``403``), and the replies are served with the review by
``GET /v1/papers/{id}/reviews``.  See :mod:`app.modules.reviews.response`.

The module loader discovers packages under ``app.modules`` automatically, so
importing this package mounts the router under ``/v1`` and registers the
``review.commit``, ``review.formal``, ``review.rating`` and
``review.response`` handlers with the ingest pipeline.
"""

from __future__ import annotations

from .coi import COI_WINDOW_YEARS, CoiCheck, CoiReport, check_conflicts
from .errors import (
    REVIEW_ALREADY_COMMITTED,
    REVIEW_ALREADY_REVEALED,
    REVIEW_COMMITMENT_MISMATCH,
    REVIEW_NOT_AUTHORIZED,
    REVIEW_NOT_COMMITTED,
    REVIEW_RESPONSE_NOT_AUTHORIZED,
    UNKNOWN_REVIEW_TARGET,
    ReviewAlreadyCommitted,
    ReviewAlreadyRevealed,
    ReviewCommitmentMismatch,
    ReviewNotAuthorized,
    ReviewNotCommitted,
    ReviewResponseNotAuthorized,
    UnknownReviewTarget,
)
from .escrow import (
    CommitteeKeyError,
    EscrowDecryptionError,
    committee_public_key,
    open_identity,
    seal_identity,
    uniqueness_token,
)
from .models import (
    Review,
    ReviewEscrow,
    ReviewInvitation,
    ReviewRating,
    ReviewResponse,
    ensure_table,
    ensure_tables,
)
from .reveal import (
    CONFIDENCE_LEVELS,
    RECOMMENDATIONS,
    REVEALED,
    REVIEW_FORMAL_TYPE,
    REVIEW_REVEAL_MIN_TIER,
    RUBRIC_DIMENSIONS,
    ReviewRevealFields,
    apply_review_reveal,
    commitment_digest,
    find_sealed_review,
    handle_review_reveal,
    normalise_recommendation,
    persist_review_reveal,
    review_reveal_fields,
)
from .response import (
    ACCEPTED,
    REVIEW_RESPONSE_MIN_TIER,
    REVIEW_RESPONSE_TYPE,
    ReviewResponseFields,
    apply_review_response,
    get_review_response,
    handle_review_response,
    is_paper_author,
    list_review_responses,
    persist_review_response,
    response_fields,
)
from .router import router
from .service import (
    COMMITTED,
    REVIEW_COMMIT_MIN_TIER,
    REVIEW_COMMIT_TYPE,
    ReviewCommitFields,
    apply_review_commit,
    create_invitation,
    create_review_invitation,
    escrow_review,
    find_escrow_by_token,
    find_review_by_nullifier,
    get_escrow,
    get_invitation,
    get_review,
    get_review_invitation,
    handle_review_commit,
    handle_review_rating,
    is_review_author,
    is_review_reviewer,
    rating_value_from_body,
    resolve_review,
    save_review_rating,
    is_author_or_moderator,
    is_tier3_reviewer,
    list_invitations,
    list_review_invitations,
    nullifier_bytes,
    persist_review_commit,
    require_not_author,
    require_unique_reviewer,
    resolve_paper,
    resolve_review_target,
    resolve_version,
    review_commit_fields,
    save_invitation,
    save_review_escrow,
    save_review_invitation,
)

__all__ = [
    "ACCEPTED",
    "COI_WINDOW_YEARS",
    "COMMITTED",
    "CONFIDENCE_LEVELS",
    "CommitteeKeyError",
    "CoiCheck",
    "CoiReport",
    "EscrowDecryptionError",
    "RECOMMENDATIONS",
    "REVEALED",
    "REVIEW_ALREADY_COMMITTED",
    "REVIEW_ALREADY_REVEALED",
    "REVIEW_COMMITMENT_MISMATCH",
    "REVIEW_COMMIT_MIN_TIER",
    "REVIEW_COMMIT_TYPE",
    "REVIEW_FORMAL_TYPE",
    "REVIEW_NOT_AUTHORIZED",
    "REVIEW_NOT_COMMITTED",
    "REVIEW_RESPONSE_MIN_TIER",
    "REVIEW_RESPONSE_NOT_AUTHORIZED",
    "REVIEW_RESPONSE_TYPE",
    "REVIEW_REVEAL_MIN_TIER",
    "RUBRIC_DIMENSIONS",
    "Review",
    "ReviewAlreadyCommitted",
    "ReviewAlreadyRevealed",
    "ReviewCommitFields",
    "ReviewCommitmentMismatch",
    "ReviewEscrow",
    "ReviewInvitation",
    "ReviewNotAuthorized",
    "ReviewNotCommitted",
    "ReviewResponse",
    "ReviewResponseFields",
    "ReviewResponseNotAuthorized",
    "ReviewRevealFields",
    "UNKNOWN_REVIEW_TARGET",
    "UnknownReviewTarget",
    "apply_review_commit",
    "apply_review_response",
    "apply_review_reveal",
    "check_conflicts",
    "commitment_digest",
    "committee_public_key",
    "create_invitation",
    "create_review_invitation",
    "ensure_table",
    "ensure_tables",
    "escrow_review",
    "find_escrow_by_token",
    "find_review_by_nullifier",
    "find_sealed_review",
    "get_escrow",
    "get_invitation",
    "get_review",
    "get_review_invitation",
    "get_review_response",
    "handle_review_commit",
    "handle_review_response",
    "handle_review_reveal",
    "is_author_or_moderator",
    "is_paper_author",
    "is_tier3_reviewer",
    "handle_review_rating",
    "is_review_author",
    "is_review_reviewer",
    "list_review_responses",
    "rating_value_from_body",
    "resolve_review",
    "response_fields",
    "save_review_rating",
    "list_invitations",
    "list_review_invitations",
    "normalise_recommendation",
    "nullifier_bytes",
    "open_identity",
    "persist_review_commit",
    "persist_review_response",
    "persist_review_reveal",
    "require_not_author",
    "require_unique_reviewer",
    "resolve_paper",
    "resolve_review_target",
    "resolve_version",
    "review_commit_fields",
    "review_reveal_fields",
    "router",
    "save_invitation",
    "save_review_escrow",
    "save_review_invitation",
    "seal_identity",
    "uniqueness_token",
]


def _install_ledger_subscriber() -> None:
    """Save every ``review.commit``, response and rating; open every ``review.formal``."""
    from app.modules import ledger

    ledger.subscribe(REVIEW_COMMIT_TYPE, persist_review_commit)
    ledger.subscribe(REVIEW_FORMAL_TYPE, persist_review_reveal)
    ledger.subscribe(REVIEW_RESPONSE_TYPE, persist_review_response)


def _register_record_type() -> None:
    """Register the review record types with the ingest pipeline.

    An existing registration is left alone rather than conflicted with, so
    re-importing the package is harmless.
    """
    from app.modules import ingest

    if ingest.get(REVIEW_COMMIT_TYPE) is None:
        ingest.register(
            REVIEW_COMMIT_TYPE,
            handle_review_commit,
            min_tier=REVIEW_COMMIT_MIN_TIER,
        )
    if ingest.get(REVIEW_FORMAL_TYPE) is None:
        ingest.register(
            REVIEW_FORMAL_TYPE,
            handle_review_reveal,
            min_tier=REVIEW_REVEAL_MIN_TIER,
        )
    if ingest.get(REVIEW_RESPONSE_TYPE) is None:
        ingest.register(
            REVIEW_RESPONSE_TYPE,
            handle_review_response,
            min_tier=REVIEW_RESPONSE_MIN_TIER,
        )
    from .service import REVIEW_RATING_MIN_TIER, REVIEW_RATING_TYPE

    if ingest.get(REVIEW_RATING_TYPE) is None:
        ingest.register(
            REVIEW_RATING_TYPE,
            handle_review_rating,
            min_tier=REVIEW_RATING_MIN_TIER,
        )


_install_ledger_subscriber()
_register_record_type()
