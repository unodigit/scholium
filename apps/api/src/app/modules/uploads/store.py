"""Persistent state for in-flight tus uploads (plugin: uploads).

Creation (``POST /v1/uploads``) records every upload here so the
resumable endpoints — the ``PATCH``/``HEAD`` of tus 1.0.0 core, and the
move into the content store once an upload completes — can pick the
upload up again after the creation response is gone.

The model is declared at import time: the module loader imports every
package under ``app.modules`` before ``db.Base.metadata.create_all``
runs, so the ``uploads`` table is created with the rest of the schema
without touching any shared file.
"""

from __future__ import annotations

import secrets
from typing import Optional

from sqlalchemy import BigInteger, Boolean, Column, DateTime, String, Text, func
from sqlalchemy.orm import Session

from app.db import Base

#: An upload that has been created but has not yet received all its bytes.
STATE_PENDING = "pending"
#: Every declared byte has been received (set when the upload completes).
STATE_COMPLETED = "completed"


def _new_upload_id() -> str:
    return secrets.token_urlsafe(18)


class Upload(Base):
    """One tus upload resource: ``/v1/uploads/{id}``."""

    __tablename__ = "uploads"

    id = Column(String(64), primary_key=True, default=_new_upload_id)
    #: The declared total size in bytes; NULL while the length is deferred.
    upload_length = Column(BigInteger, nullable=True)
    #: True when the client used ``Upload-Defer-Length: 1``.
    defer_length = Column(Boolean, nullable=False, default=False)
    #: How many bytes have been received so far.
    upload_offset = Column(BigInteger, nullable=False, default=0)
    #: The raw ``Upload-Metadata`` header, kept verbatim for later turns.
    upload_metadata = Column(Text, nullable=False, default="")
    #: ``pdf``, ``bundle`` or ``other`` — decides the size limit applied.
    kind = Column(String(16), nullable=False, default="other")
    #: ``pending`` until every declared byte has arrived, then ``completed``.
    state = Column(String(16), nullable=False, default=STATE_PENDING)
    #: The DID of the caller, when the creation request was authenticated.
    owner_did = Column(String(256), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())


def create_upload(
    session: Session,
    *,
    upload_length: Optional[int],
    defer_length: bool = False,
    upload_metadata: str = "",
    kind: str = "other",
    owner_did: Optional[str] = None,
) -> Upload:
    """Persist a freshly created tus upload resource and return it."""
    upload = Upload(
        id=_new_upload_id(),
        upload_length=upload_length,
        defer_length=defer_length,
        upload_offset=0,
        upload_metadata=upload_metadata,
        kind=kind,
        state=STATE_PENDING,
        owner_did=owner_did,
    )
    session.add(upload)
    session.commit()
    session.refresh(upload)
    return upload


def get_upload(session: Session, upload_id: str) -> Optional[Upload]:
    """Return the upload with ``upload_id``, or ``None`` when it does not exist."""
    return session.get(Upload, upload_id)
