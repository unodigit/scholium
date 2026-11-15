"""Submission record handlers (plugin: submissions).

Feature 48: a ``manifest`` record is accepted only when every file it lists
is present in the content store -- a row in ``blobs`` whose ``size`` matches
the size the manifest declares.  Otherwise the submission is refused with
``422`` problem details naming the offending file ``path``.

The check runs as the record type's ingest handler, so it happens inside
``POST /v1/records`` before the record reaches the ledger.  Registering it is
the only wiring needed: the module loader imports every package under
``app.modules``, and this package registers at import time via
:func:`app.modules.ingest.register`.  There is no route of its own.

See :mod:`app.modules.submissions.manifest` for the handler and
:mod:`app.modules.submissions.errors` for its refusals.
"""

from __future__ import annotations

from app.modules.ingest import register

from .errors import (
    MANIFEST_FILE_NOT_STORED,
    MANIFEST_FILE_SIZE_MISMATCH,
    ManifestFileError,
    ManifestFileNotStored,
    ManifestFileSizeMismatch,
)
from .manifest import (
    MANIFEST_MIN_TIER,
    MANIFEST_TYPE,
    handle_manifest,
    manifest_files,
    validate_manifest_files,
)

#: Register the manifest handler once, at import time.  ``register`` is a
#: no-op when the same handler and tier are already registered, so a module
#: loader that imports this package twice is harmless.
register(MANIFEST_TYPE, handle_manifest, min_tier=MANIFEST_MIN_TIER)

__all__ = [
    "MANIFEST_FILE_NOT_STORED",
    "MANIFEST_FILE_SIZE_MISMATCH",
    "MANIFEST_MIN_TIER",
    "MANIFEST_TYPE",
    "ManifestFileError",
    "ManifestFileNotStored",
    "ManifestFileSizeMismatch",
    "handle_manifest",
    "manifest_files",
    "validate_manifest_files",
]
