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

Each check runs as the record type's ingest handler, so it happens inside
``POST /v1/records`` before the record reaches the ledger.  Registering the
handlers is the only wiring needed: the module loader imports every package
under ``app.modules``, and this package registers at import time via
:func:`app.modules.ingest.register`.  There is no route of its own.

See :mod:`app.modules.submissions.manifest` and
:mod:`app.modules.submissions.genesis` for the handlers,
:mod:`app.modules.submissions.limits` for the weekly genesis limit,
:mod:`app.modules.submissions.models` for the ``papers`` table and
:mod:`app.modules.submissions.errors` for their refusals.
"""

from __future__ import annotations

from app.modules.ingest import register

from .errors import (
    CATEGORY_NOT_ENDORSED,
    GENESIS_RATE_LIMITED,
    MANIFEST_FILE_NOT_STORED,
    MANIFEST_FILE_SIZE_MISMATCH,
    SHORT_ID_COLLISION,
    CategoryNotEndorsed,
    GenesisRateLimited,
    ManifestFileError,
    ManifestFileNotStored,
    ManifestFileSizeMismatch,
    ShortIdCollision,
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
from .models import DEFAULT_LICENCE, INITIAL_STATUS, Paper, ensure_tables

#: Register the handlers once, at import time.  ``register`` is a no-op when the
#: same handler and tier are already registered, so a module loader that
#: imports this package twice is harmless.
register(MANIFEST_TYPE, handle_manifest, min_tier=MANIFEST_MIN_TIER)
register(PAPER_GENESIS_TYPE, handle_paper_genesis, min_tier=GENESIS_MIN_TIER)

__all__ = [
    "CATEGORY_NOT_ENDORSED",
    "DEFAULT_LICENCE",
    "GENESIS_MIN_TIER",
    "GENESIS_RATE_LIMITED",
    "GENESIS_WEEKLY_LIMIT",
    "GENESIS_WINDOW",
    "INITIAL_STATUS",
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "MANIFEST_MIN_TIER",
    "MANIFEST_TYPE",
    "PAPER_GENESIS_TYPE",
    "SHORT_ID_COLLISION",
    "YOUNG_ACCOUNT_MAX_AGE",
    "YOUNG_AUTHOR_TIER",
    "CategoryNotEndorsed",
    "GenesisRateLimited",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
    "Paper",
    "ShortIdCollision",
    "account_created_at",
    "enforce_genesis_quota",
    "ensure_tables",
    "genesis_categories",
    "genesis_licence",
    "get_paper",
    "get_paper_by_short_id",
    "handle_manifest",
    "handle_paper_genesis",
    "is_young_author",
    "manifest_files",
    "newest_recent_genesis",
    "require_endorsed",
    "save_paper",
    "unendorsed_categories",
    "validate_manifest_files",
]
