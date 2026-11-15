"""API shapes for the notifications module.

One notification serialises as the full persisted row::

    {"id": 7, "did": "did:example:alice", "kind": "consent.request",
     "payload": {...}, "read": false}

``did`` is always the caller's own DID on the ``/v1/me/...`` routes; it is
included so a client can hand the row to shared rendering code unchanged.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class NotificationOut(BaseModel):
    """The API representation of one notification row."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    did: str
    kind: str
    payload: Any
    read: bool
