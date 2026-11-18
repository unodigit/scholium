"use client";

/**
 * `LocalDate`: an instant as `<time datetime title>`, shown in the reader's own
 * time zone (bug_spec_verify6 bug 4).  The formatting is `./format-date`'s.
 *
 * A client component in a file of its own: it uses a React hook, and the
 * formatting functions it shares with server code must not.
 */

import { createElement, useSyncExternalStore, type ReactElement } from "react";

import { formatDate, formatDateTime, toDate, type DateInput } from "./format-date";

/** A never-notifying store: the value is fixed for the life of the page. */
const subscribeNever = (): (() => void) => () => undefined;
const onClient = (): boolean => true;
const onServer = (): boolean => false;

/**
 * Whether this render is in the browser, in a way that is hydration-safe:
 * React uses the server snapshot for the first HTML *and* the hydration pass,
 * then re-renders with the reader's zone. No mismatch warning, and the local
 * date is there as soon as React takes over.
 */
function useReaderZone(): boolean {
  return useSyncExternalStore(subscribeNever, onClient, onServer);
}

export interface LocalDateProps {
  /** The instant to show: an ISO string (or a `Date`). */
  readonly value: DateInput;
  /** Class for the `<time>` element, e.g. `pm-version__date`. */
  readonly className?: string;
}

/**
 * A date as a `<time datetime="…" title="… UTC">…</time>`.
 *
 * The visible text is the reader's local calendar date; the `datetime`
 * attribute carries the machine-readable instant and the `title` the same
 * instant in UTC, so a hover still names the moment exactly. Renders nothing
 * for a value that is not a date.
 */
export function LocalDate({ value, className }: LocalDateProps): ReactElement | null {
  const readerZone = useReaderZone();
  const date = toDate(value);
  if (date === null) return null;
  const shown = readerZone
    ? formatDate(value)
    : formatDate(value, { timeZone: "UTC" });
  return createElement(
    "time",
    {
      className,
      dateTime: typeof value === "string" ? value : date.toISOString(),
      title: formatDateTime(value, { timeZone: "UTC" }) ?? undefined,
    },
    shown,
  );
}
