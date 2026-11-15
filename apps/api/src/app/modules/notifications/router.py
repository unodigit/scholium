"""HTTP routes for the notifications plugin (feature 58).

The module loader mounts this router under ``/v1``, so the routes below serve:

* ``GET  /v1/me/notifications`` -- the caller's notifications, unread and read
  alike, oldest first, as a bare JSON array.
* ``POST /v1/me/notifications/{id}/read`` -- mark one notification read and
  return it with ``read: true``.  Idempotent.

Both routes authenticate with the caller's access token; any trust tier may
manage its own notifications (they are per-account, not per-role).  Failures:

* No or unusable token: ``401`` problem details with a ``WWW-Authenticate``
  challenge (from ``app.security.get_current_principal``).
* ``id`` that is not one of the caller's notifications -- including one that
  belongs to somebody else, so existence is not leaked: ``404`` problem details.
* ``id`` that is not an integer: ``422`` problem details from the app-wide
  validation handler.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.security import Principal, get_current_principal

from .schemas import NotificationOut
from .service import list_notifications, mark_read

router = APIRouter(prefix="/me", tags=["notifications"])


@router.get("/notifications", response_model=list[NotificationOut])
def my_notifications(
    principal: Principal = Depends(get_current_principal),
) -> list[NotificationOut]:
    """Return every notification addressed to the caller, oldest first."""
    return [NotificationOut.model_validate(row) for row in list_notifications(principal.did)]


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
def read_notification(
    notification_id: int,
    principal: Principal = Depends(get_current_principal),
) -> NotificationOut:
    """Mark one of the caller's notifications read and return it."""
    notification = mark_read(principal.did, notification_id)
    if notification is None:
        raise HTTPException(
            status_code=404,
            detail=f"There is no notification {notification_id} for this account.",
        )
    return NotificationOut.model_validate(notification)
