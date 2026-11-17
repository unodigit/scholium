/**
 * The unread count behind the nav's notifications badge.
 *
 * `GET /v1/me/notifications` returns full rows; the badge only needs "how
 * many are unread", so this narrows to that without assuming more of the row
 * than `read: boolean` (see the API's `notifications.schemas.NotificationOut`).
 */

/**
 * Fired on `window` after a notification is marked read.
 *
 * The notifications card owns the list and knows the new unread count; the
 * nav owns the bell. This event is the one channel between them, so pressing
 * "Mark as read" lowers the badge at once instead of waiting for a reload.
 * `detail.unread` is how many rows are still unread.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "scholium:notifications-changed";

/** The part of a notification row the badge depends on. */
export interface NavNotification {
  /** False until the user opens the notification. */
  read: boolean;
}

/**
 * Count unread rows.
 *
 * Anything that is not an array counts as `0`, non-object entries are not
 * notification rows at all, and an object without an explicit `read: true`
 * counts as unread — unknown state should read as "needs your attention",
 * not silently disappear.
 */
export function countUnread(rows: unknown): number {
  if (!Array.isArray(rows)) {
    return 0;
  }
  return rows.reduce<number>((total, row) => {
    if (typeof row !== "object" || row === null) {
      return total;
    }
    const read = Boolean((row as { read?: unknown }).read);
    return read ? total : total + 1;
  }, 0);
}
