"""arXiv import module (plugin: imports).

Feature 124: ``POST /v1/imports/arxiv`` (trust tier 4) mirrors an arXiv paper as
a node-signed ``external.mirror`` record, marked unclaimed.  Metadata comes from
the arXiv API, or from deterministic mock data with ``ARXIV_MOCK=1``.  See
:mod:`app.modules.imports.router` for the endpoint,
:mod:`app.modules.imports.service` for the pipeline and the record's shape, and
:mod:`app.modules.imports.arxiv` for where the metadata comes from.

Feature 125: an author claims the import by signing a ``paper.version`` (through
the ordinary ``POST /v1/records``) whose body names the mirror's cid in
``mirror``.  When the signer's linked ORCID iD is one the mirror names for an
author, the paper's ``papers`` row is saved with ``claimed = true``.  The claim
is a ledger subscriber registered when this package is imported; see
:mod:`app.modules.imports.claims` for the rule and its limits.

The module loader discovers packages under ``app.modules`` automatically and
mounts the ``router`` exported here under ``/v1``; nothing else needs wiring.
"""

from __future__ import annotations

from .arxiv import (
    ARXIV_API_URL,
    ArxivId,
    fetch_metadata,
    mock_metadata,
    parse_arxiv_id,
    parse_atom_entry,
)
from .claims import (
    MIRROR_FIELD,
    Claim,
    claim_imported_paper,
    linked_orcid,
    mark_claimed,
    mirror_author_orcids,
    mirror_reference,
    on_paper_version,
)
from .errors import (
    ALREADY_IMPORTED,
    ARXIV_NOT_FOUND,
    ARXIV_UNAVAILABLE,
    INVALID_ARXIV_ID,
    NODE_KEY_UNAVAILABLE,
    AlreadyImported,
    ArxivNotFound,
    ArxivUnavailable,
    InvalidArxivId,
    NodeKeyUnavailable,
)
from .router import REQUIRED_TIER, ArxivImportRequest, MirrorCreated, router
from .service import (
    MIRROR_TYPE,
    STATE_UNCLAIMED,
    ImportResult,
    build_mirror,
    find_mirror,
    import_arxiv,
    snapshot_bytes,
    snapshot_id,
)

__all__ = [
    "ALREADY_IMPORTED",
    "ARXIV_API_URL",
    "ARXIV_NOT_FOUND",
    "ARXIV_UNAVAILABLE",
    "AlreadyImported",
    "ArxivId",
    "ArxivImportRequest",
    "ArxivNotFound",
    "ArxivUnavailable",
    "Claim",
    "INVALID_ARXIV_ID",
    "ImportResult",
    "InvalidArxivId",
    "MIRROR_FIELD",
    "MIRROR_TYPE",
    "MirrorCreated",
    "NODE_KEY_UNAVAILABLE",
    "NodeKeyUnavailable",
    "REQUIRED_TIER",
    "STATE_UNCLAIMED",
    "build_mirror",
    "claim_imported_paper",
    "fetch_metadata",
    "find_mirror",
    "import_arxiv",
    "linked_orcid",
    "mark_claimed",
    "mirror_author_orcids",
    "mirror_reference",
    "mock_metadata",
    "on_paper_version",
    "parse_arxiv_id",
    "parse_atom_entry",
    "router",
    "snapshot_bytes",
    "snapshot_id",
]
