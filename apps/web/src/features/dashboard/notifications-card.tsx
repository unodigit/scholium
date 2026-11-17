"use client";

/**
 * The "Notifications" card on `/me` (the bell in the header deep-links to
 * `/me#notifications`).
 *
 * ```text
 * Notifications
 * [Moderation outcome] [Unread]                          2 hours ago
 * A moderator put your paper on hold.
 * Open   Mark as read
 * ```
 *
 * The card loads `GET /v1/me/notifications` on its own (not from
 * `GET /v1/me/dashboard`), so a failure here never blanks the rest of `/me`
 * and "No notifications yet." is only ever the API's answer, never a guess.
 * The API serves oldest first; the card shows newest first, ten at a time.
 *
 * Opening a notification, or pressing "Mark as read", marks it read through
 * `POST /v1/me/notifications/{id}/read`. The row only turns read once the API
 * confirms; a refusal keeps it unread and says why on the row. Each confirmed
 * change is announced on `window` ({@link NOTIFICATIONS_CHANGED_EVENT}) so the
 * header's bell can lower its count.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenStore } from "../../lib/api";
import { EmptyState } from "../ui-kit";

import { Card } from "./card";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  SIGNIN_HREF,
  describeMarkReadError,
  describeNotificationsError,
  loadNotifications as fetchNotifications,
  markNotificationRead as postNotificationRead,
  notificationDetail,
  notificationKindLabel,
  notificationLink,
  notificationSummary,
  notificationTime,
  timeAgo,
  type NotificationItem,
} from "./dashboard";

/** How many rows show before "Show more". */
export const NOTIFICATIONS_PAGE_SIZE = 10;

/** Props for {@link NotificationsCard}. Everything is optional. */
export interface NotificationsCardProps {
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store. The card asks for the viewer's own list, so without a session it
   * never calls the API.
   */
  readonly signedIn?: boolean;
  /** Replace the loader, for tests or an alternate API client. */
  readonly loadNotifications?: () => Promise<readonly NotificationItem[]>;
  /** Replace the mark-read call, for tests or an alternate API client. */
  readonly markNotificationRead?: (id: number) => Promise<void>;
}

type CardState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; items: readonly NotificationItem[] };

/** The viewer's notifications, newest first, each with its link and a read action. */
export function NotificationsCard({
  signedIn,
  loadNotifications = fetchNotifications,
  markNotificationRead = postNotificationRead,
}: NotificationsCardProps = {}) {
  const [state, setState] = useState<CardState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(NOTIFICATIONS_PAGE_SIZE);
  const [marking, setMarking] = useState<ReadonlySet<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<number, string>>>({});
  const [notice, setNotice] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  // The list as last confirmed; the source of truth for the bell's unread count
  // when several rows are marked in quick succession.
  const itemsRef = useRef<readonly NotificationItem[]>([]);
  // The row that should take focus once the DOM reflects the change; `null` when idle.
  const focusId = useRef<number | null>(null);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "signed-out" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadNotifications().then(
      (items) => {
        if (!cancelled) {
          itemsRef.current = items;
          setState({ status: "ready", items });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeNotificationsError(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, loadNotifications, signedIn]);

  // A row that was marked read loses its button, and "Show more" loses itself
  // once everything shows: hand focus to the row that matters instead of <body>.
  useEffect(() => {
    if (focusId.current === null || state.status !== "ready") {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-notification-id="${focusId.current}"]`,
    );
    row?.focus();
    focusId.current = null;
  }, [state, visible]);

  const markRead = async (item: NotificationItem, moveFocus: boolean) => {
    if (item.read || marking.has(item.id)) {
      return;
    }
    setMarking((current) => new Set(current).add(item.id));
    setRowErrors(({ [item.id]: _cleared, ...rest }) => rest);
    try {
      await markNotificationRead(item.id);
      const next = itemsRef.current.map((row) =>
        row.id === item.id ? { ...row, read: true } : row,
      );
      itemsRef.current = next;
      if (moveFocus) {
        focusId.current = item.id;
      }
      setState({ status: "ready", items: next });
      setNotice("Marked as read.");
      window.dispatchEvent(
        new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, {
          detail: { unread: next.filter((row) => !row.read).length },
        }),
      );
    } catch (error: unknown) {
      setRowErrors((current) => ({ ...current, [item.id]: describeMarkReadError(error) }));
    } finally {
      setMarking((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const sorted =
    state.status === "ready" ? [...state.items].sort((a, b) => b.id - a.id) : [];
  const shown = sorted.slice(0, visible);
  const remaining = sorted.length - shown.length;

  const showMore = () => {
    focusId.current = sorted[visible]?.id ?? null;
    setVisible((count) => count + NOTIFICATIONS_PAGE_SIZE);
  };

  return (
    <Card title="Notifications" anchor="notifications">
      <div className="db-notes-body" aria-busy={state.status === "loading"}>
        {state.status === "loading" ? (
          <p className="db-loading">Loading your notifications…</p>
        ) : null}

        {state.status === "signed-out" ? (
          <p className="db-item-detail meta">
            <a className="db-link" href={SIGNIN_HREF}>
              Sign in
            </a>{" "}
            to see your notifications.
          </p>
        ) : null}

        {state.status === "error" ? (
          <div className="db-saved-error" role="alert">
            <p className="db-item-detail meta">{state.message}</p>
            <button type="button" className="db-button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : null}

        {state.status === "ready" && sorted.length === 0 ? (
          <EmptyState
            sentence="No notifications yet."
            action={{ label: "Refresh", onClick: retry }}
          />
        ) : null}

        {state.status === "ready" && sorted.length > 0 ? (
          <ul className="db-list" ref={listRef}>
            {shown.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                busy={marking.has(item.id)}
                error={rowErrors[item.id]}
                onMarkRead={() => markRead(item, true)}
                onOpen={() => {
                  void markRead(item, false);
                }}
              />
            ))}
          </ul>
        ) : null}

        {remaining > 0 ? (
          <button type="button" className="db-button db-notes-more" onClick={showMore}>
            Show more ({remaining} more)
          </button>
        ) : null}

        {/* Always mounted so a screen reader announces the text when it changes. */}
        <p className="db-visually-hidden" role="status">
          {notice}
        </p>
      </div>
    </Card>
  );
}

function NotificationRow({
  item,
  busy,
  error,
  onMarkRead,
  onOpen,
}: {
  item: NotificationItem;
  busy: boolean;
  error: string | undefined;
  onMarkRead: () => void;
  onOpen: () => void;
}) {
  const label = notificationKindLabel(item.kind);
  const detail = notificationDetail(item);
  const link = notificationLink(item);
  const time = notificationTime(item);
  return (
    <li
      className="db-item db-note"
      data-notification-id={item.id}
      data-kind={item.kind}
      data-read={item.read ? "true" : "false"}
      tabIndex={-1}
    >
      <div className="db-note-head">
        <span className="db-chip">{label}</span>
        {item.read ? null : (
          <span className="db-chip" data-tone="pending">
            Unread
          </span>
        )}
        {time === null ? null : (
          <time className="db-note-time meta" dateTime={time}>
            {timeAgo(time)}
          </time>
        )}
      </div>
      <p className="db-item-summary">{notificationSummary(item)}</p>
      {detail === null ? null : <p className="db-item-detail meta">{detail}</p>}
      <div className="db-note-actions">
        {link === null ? null : (
          <a className="db-link" href={link} onClick={onOpen}>
            Open<span className="db-visually-hidden"> {label.toLowerCase()}</span>
          </a>
        )}
        {item.read ? null : (
          <button
            type="button"
            className="db-button db-note-read"
            aria-disabled={busy}
            aria-busy={busy}
            onClick={onMarkRead}
          >
            {busy ? "Marking…" : "Mark as read"}
            <span className="db-visually-hidden"> {label.toLowerCase()}</span>
          </button>
        )}
      </div>
      {error === undefined ? null : (
        <p className="db-saved-row-error meta" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default NotificationsCard;
