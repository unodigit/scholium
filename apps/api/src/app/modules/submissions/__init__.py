"""Submission record handlers (plugin: submissions).

Feature 48: a ``manifest`` record is accepted only when every file it lists
is present in the content store -- a row in ``blobs`` whose ``size`` matches
the size the manifest declares.  Otherwise the submission is refused with
``422`` problem details naming the offending file ``path``.

Feature 49: a ``paper.genesis`` record is accepted only from an author of
trust tier 2 or higher who holds an active endorsement in every category the
record lists (``403`` problem details otherwise, naming the categories they
lack).  Accepting it saves the paper to the ``papers`` table -- its categories,
its licence (``CC-BY-4.0`` when the record names none) and the ``sch:`` short
id derived from the record's cid.

Feature 51: a tier-2 account younger than 90 days may start only one paper per
rolling week.  A second genesis inside the window is refused with ``429``
problem details naming the next allowed instant
(:class:`GenesisRateLimited`); older and higher-tier accounts are not limited.

Feature 50: a ``paper.version`` record is accepted from a tier-2 author when
its envelope ``prev`` equals the paper's current latest version (the genesis
cid for the first version) and its body ``n`` is that version's number plus
one.  Accepting it saves the version to ``paper_versions`` -- title, abstract,
manifest cid, licence and change note -- in state ``awaiting_consent``, and
its listed authors to ``authorship`` with their byline positions and CRediT
roles.  A stale ``prev`` or a skipped/duplicated number is refused with
``409`` problem details (:class:`VersionOutOfSequence`).

Feature 52: every advance of ``paper_versions.state`` -- through
``awaiting_consent``, ``scanning``, ``moderation``, ``listed``, ``held`` and
``rejected`` -- is recorded with one ``version.state_changed`` event.
:func:`transition_version` writes the new state and publishes the event;
:func:`subscribe_version_state_changed` listens for it;
:func:`advance_version` walks the happy path.  A newly accepted version emits
its first event when it enters ``awaiting_consent``.  See
:mod:`app.modules.submissions.state` and
:mod:`app.modules.submissions.events`.

Feature 53: a ``withdrawal``, ``correction`` or ``retraction`` record is
accepted from an author of the paper or a tier-4 member (``403`` problem
details otherwise, :class:`NoticeNotAuthorized`) and saved to the ``notices``
table under the *paper's* cid, so every version shows it.  Its ``target`` must
be a paper or version this node holds (``422``, :class:`UnknownNoticeTarget`).
See :mod:`app.modules.submissions.notices`.

Each check runs as the record type's ingest handler, so it happens inside
``POST /v1/records`` before the record reaches the ledger.  Registering the
handlers is the only wiring needed: the module loader imports every package
under ``app.modules``, and this package registers at import time via
:func:`app.modules.ingest.register`.  There is no route of its own.

See :mod:`app.modules.submissions.manifest`,
:mod:`app.modules.submissions.genesis` and
:mod:`app.modules.submissions.versions` and
:mod:`app.modules.submissions.notices` for the handlers,
:mod:`app.modules.submissions.limits` for the weekly genesis limit,
:mod:`app.modules.submissions.models` for the ``papers``,
``paper_versions``, ``authorship`` and ``notices`` tables,
:mod:`app.modules.submissions.state` and
:mod:`app.modules.submissions.events` for version state transitions and
:mod:`app.modules.submissions.errors` for their refusals.
"""

from __future__ import annotations

from app.modules.ingest import PAPER_VERSION_TYPE, register

from .errors import (
    CATEGORY_NOT_ENDORSED,
    GENESIS_RATE_LIMITED,
    MANIFEST_FILE_NOT_STORED,
    MANIFEST_FILE_SIZE_MISMATCH,
    NOTICE_NOT_AUTHORIZED,
    SHORT_ID_COLLISION,
    UNKNOWN_NOTICE_TARGET,
    UNKNOWN_PAPER,
    VERSION_NOT_AUTHORIZED,
    VERSION_OUT_OF_SEQUENCE,
    CategoryNotEndorsed,
    GenesisRateLimited,
    InvalidVersionState,
    ManifestFileError,
    ManifestFileNotStored,
    ManifestFileSizeMismatch,
    NoticeNotAuthorized,
    ShortIdCollision,
    UnknownNoticeTarget,
    UnknownPaper,
    UnknownVersion,
    VersionNotAuthorized,
    VersionOutOfSequence,
)
from .events import (
    VERSION_STATE_CHANGED,
    VersionStateChanged,
    clear_state_changed_subscribers,
    emit_state_changed,
    emit_version_state_changed,
    state_changed_subscriber_count,
    subscribe_state_changed,
    subscribe_version_state_changed,
    unsubscribe_state_changed,
    unsubscribe_version_state_changed,
)
from .genesis import (
    GENESIS_MIN_TIER,
    PAPER_GENESIS_TYPE,
    genesis_categories,
    genesis_licence,
    get_paper,
    get_paper_by_short_id,
    handle_paper_genesis,
    require_endorsed,
    save_paper,
    unendorsed_categories,
)
from .limits import (
    GENESIS_WEEKLY_LIMIT,
    GENESIS_WINDOW,
    YOUNG_ACCOUNT_MAX_AGE,
    YOUNG_AUTHOR_TIER,
    account_created_at,
    enforce_genesis_quota,
    is_young_author,
    newest_recent_genesis,
)
from .manifest import (
    MANIFEST_MIN_TIER,
    MANIFEST_TYPE,
    handle_manifest,
    manifest_files,
    validate_manifest_files,
)
from .models import (
    DEFAULT_LICENCE,
    INITIAL_STATUS,
    Authorship,
    Notice,
    Paper,
    PaperVersion,
    ensure_tables,
)
from .notices import (
    CORRECTION_TYPE,
    MAX_REASON_BYTES,
    NOTICE_MIN_TIER,
    NOTICE_OVERRIDE_TIER,
    NOTICE_TYPES,
    RETRACTION_TYPE,
    WITHDRAWAL_TYPE,
    NoticeFields,
    NoticeTarget,
    get_notice,
    handle_correction,
    handle_retraction,
    handle_withdrawal,
    notice_fields,
    notices_for_paper,
    paper_authors,
    read_reason_file,
    require_authorized,
    resolve_target,
    save_notice,
)
from .versions import (
    AWAITING_CONSENT,
    VERSION_MIN_TIER,
    VERSION_STATES,
    VersionAuthor,
    VersionFields,
    authorship_for,
    expected_chain,
    get_version,
    handle_paper_version,
    latest_version,
    require_known_paper,
    save_version,
    version_authors,
    version_fields,
    versions_for_paper,
)
from .state import (
    ALLOWED_TRANSITIONS,
    DRAFT,
    HELD,
    KNOWN_STATES,
    LISTED,
    MODERATION,
    REJECTED,
    SCANNING,
    advance_version,
    can_transition,
    is_known_state,
    next_state,
    set_version_state,
    transition_version,
)

#: Register the handlers once, at import time.  ``register`` is a no-op when the
#: same handler and tier are already registered, so a module loader that
#: imports this package twice is harmless.
register(MANIFEST_TYPE, handle_manifest, min_tier=MANIFEST_MIN_TIER)
register(PAPER_GENESIS_TYPE, handle_paper_genesis, min_tier=GENESIS_MIN_TIER)
register(PAPER_VERSION_TYPE, handle_paper_version, min_tier=VERSION_MIN_TIER)
register(WITHDRAWAL_TYPE, handle_withdrawal, min_tier=NOTICE_MIN_TIER)
register(CORRECTION_TYPE, handle_correction, min_tier=NOTICE_MIN_TIER)
register(RETRACTION_TYPE, handle_retraction, min_tier=NOTICE_MIN_TIER)

__all__ = [
    "ALLOWED_TRANSITIONS",
    "AWAITING_CONSENT",
    "CATEGORY_NOT_ENDORSED",
    "CORRECTION_TYPE",
    "DEFAULT_LICENCE",
    "DRAFT",
    "GENESIS_MIN_TIER",
    "GENESIS_RATE_LIMITED",
    "GENESIS_WEEKLY_LIMIT",
    "GENESIS_WINDOW",
    "HELD",
    "INITIAL_STATUS",
    "KNOWN_STATES",
    "LISTED",
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "MANIFEST_MIN_TIER",
    "MANIFEST_TYPE",
    "MAX_REASON_BYTES",
    "MODERATION",
    "NOTICE_MIN_TIER",
    "NOTICE_NOT_AUTHORIZED",
    "NOTICE_OVERRIDE_TIER",
    "NOTICE_TYPES",
    "PAPER_GENESIS_TYPE",
    "PAPER_VERSION_TYPE",
    "REJECTED",
    "RETRACTION_TYPE",
    "SCANNING",
    "SHORT_ID_COLLISION",
    "UNKNOWN_NOTICE_TARGET",
    "UNKNOWN_PAPER",
    "VERSION_MIN_TIER",
    "VERSION_NOT_AUTHORIZED",
    "VERSION_OUT_OF_SEQUENCE",
    "VERSION_STATES",
    "VERSION_STATE_CHANGED",
    "WITHDRAWAL_TYPE",
    "YOUNG_ACCOUNT_MAX_AGE",
    "YOUNG_AUTHOR_TIER",
    "Authorship",
    "CategoryNotEndorsed",
    "GenesisRateLimited",
    "InvalidVersionState",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
    "Notice",
    "NoticeFields",
    "NoticeNotAuthorized",
    "NoticeTarget",
    "Paper",
    "PaperVersion",
    "ShortIdCollision",
    "UnknownNoticeTarget",
    "UnknownPaper",
    "UnknownVersion",
    "VersionAuthor",
    "VersionFields",
    "VersionNotAuthorized",
    "VersionOutOfSequence",
    "VersionStateChanged",
    "account_created_at",
    "advance_version",
    "authorship_for",
    "can_transition",
    "clear_state_changed_subscribers",
    "emit_state_changed",
    "emit_version_state_changed",
    "enforce_genesis_quota",
    "ensure_tables",
    "expected_chain",
    "genesis_categories",
    "genesis_licence",
    "get_notice",
    "get_paper",
    "get_paper_by_short_id",
    "get_version",
    "handle_correction",
    "handle_manifest",
    "handle_paper_genesis",
    "handle_paper_version",
    "handle_retraction",
    "handle_withdrawal",
    "is_known_state",
    "is_young_author",
    "latest_version",
    "manifest_files",
    "newest_recent_genesis",
    "next_state",
    "notice_fields",
    "notices_for_paper",
    "paper_authors",
    "read_reason_file",
    "require_authorized",
    "require_endorsed",
    "require_known_paper",
    "resolve_target",
    "save_notice",
    "save_paper",
    "save_version",
    "set_version_state",
    "state_changed_subscriber_count",
    "subscribe_state_changed",
    "subscribe_version_state_changed",
    "transition_version",
    "unendorsed_categories",
    "unsubscribe_state_changed",
    "unsubscribe_version_state_changed",
    "validate_manifest_files",
    "version_authors",
    "version_fields",
    "versions_for_paper",
]
