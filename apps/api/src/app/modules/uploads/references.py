"""Which uploaded file bytes a manifest names (plugin: uploads).

An upload's bytes are only *paper* once a signed ``manifest`` record names
their CID. Until then they are an anonymous file in the content store: they
may be abandoned, and nothing may serve or cite them. This module answers the
one question the upload quota and the orphan reaper need -- "is this CID named
by any manifest?" -- by reading the append-only record log.

A manifest body (:mod:`scholium_record_core.manifest`) lists its files under
``files``, each entry carrying ``cid``. A ``paper.version`` record may carry
the manifest inline (under ``manifest``) instead of by reference; both shapes
are read here. A manifest referred to by CID needs no special handling: the
``manifest`` record itself is in the log and is read on its own.

The scan is deliberately tolerant of bodies written by older releases. A body
that does not look like a manifest contributes nothing rather than failing the
whole scan.

Reading is all this module does. The log is append-only, and bytes are never
deleted on the strength of this answer alone: the caller re-checks the count
of uploads still naming a CID before removing anything from the content store.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app import db

logger = logging.getLogger(__name__)

#: Record types whose bodies may list file CIDs.  ``manifest`` is the
#: canonical record; ``paper.version`` may inline an older-style manifest.
MANIFEST_RECORD_TYPES = ("manifest", "paper.version")


def _files_of(body: Any) -> Sequence[Any]:
    """The file entries a manifest-ish body lists, or an empty sequence."""
    if isinstance(body, Mapping):
        manifest = body.get("manifest")
        if isinstance(manifest, Mapping):
            body = manifest
        elif isinstance(manifest, Sequence) and not isinstance(manifest, (str, bytes, bytearray)):
            return manifest
        files = body.get("files")
    else:
        files = body
    if isinstance(files, (str, bytes, bytearray)) or not isinstance(files, Sequence):
        return ()
    return files


def cids_in(body: Any) -> set[str]:
    """Every file CID a manifest body (or an inline-manifest version body) names."""
    cids: set[str] = set()
    for entry in _files_of(body):
        if not isinstance(entry, Mapping):
            continue
        cid = entry.get("cid")
        if isinstance(cid, str) and cid:
            cids.add(cid)
    return cids


def referenced_cids() -> Optional[set[str]]:
    """Every file CID named by a manifest in the record log.

    Returns ``None`` when the log cannot be read. Callers must then choose:
    the orphan reaper skips deletion (never remove bytes it cannot prove are
    unreferenced) and the quota counts every completed upload (the strict
    side, which can only refuse an upload, never store one unaccounted for).
    """
    try:
        # Imported lazily: the ledger package imports the ingest registry, and
        # this plugin is imported by the module loader alongside it.
        from app.modules.ledger.models import EventLog

        with db.SessionLocal() as session:
            bodies = session.scalars(
                select(EventLog.body).where(EventLog.record_type.in_(MANIFEST_RECORD_TYPES))
            )
            referenced: set[str] = set()
            for body in bodies:
                referenced |= cids_in(body)
            return referenced
    except SQLAlchemyError:
        logger.warning("could not read manifests while checking upload references", exc_info=True)
        return None
