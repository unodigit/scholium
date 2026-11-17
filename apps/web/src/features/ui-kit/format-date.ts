/**
 * One date format for the whole product, in the reader's own time zone
 * (bug_spec_verify6 bug 4).
 *
 * A timestamp is an instant: the same moment is 13:45 UTC and 00:45 the next
 * day in Sydney. The consent page, the appeal banner, review cards, discussion
 * posts and the version list each used to format an instant in UTC, so a reader
 * east of UTC saw an action taken just after local midnight dated to the
 * previous day — while a page that formatted locally said the next one.
 *
 * `formatDate` and `formatDateTime` write the viewer's own calendar date
 * (the browser's zone, when no zone is named), so every page naming the same
 * instant agrees. `LocalDate` renders a `<time datetime>` with the UTC instant
 * as its title and swaps in the local date after hydration: the first HTML is
 * stable in any zone, so the server and the browser never disagree.
 *
 * ICU's `Intl.DateTimeFormat` with an explicit IANA zone is Baseline widely
 * available, which is why this does not use Temporal (still Limited
 * availability, and a ~15 KB polyfill).
 */

import {
  createElement,
  useSyncExternalStore,
  type ReactElement,
} from "react";

/** The month spellings the product uses: `2 Mar 2027` or `4 May 2027`. */
export type DateMonth = "short" | "long";

export interface DateFormatOptions {
  /** BCP-47 language tag; the product's words are `en-GB`. */
  readonly locale?: string;
  /**
   * An IANA zone (e.g. `Australia/Sydney`, `UTC`). Omitted, the runtime's own
   * zone is the reader's — which is what a page should show.
   */
  readonly timeZone?: string;
  /** `short` (default) writes `Mar`, `long` writes `March`. */
  readonly month?: DateMonth;
}

/** What a formatter accepts: an ISO instant, a `Date`, or nothing usable. */
export type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2026-11-17T13:45:00Z` → `18 Nov 2026` for a reader in Sydney. */
export function formatDate(
  value: DateInput,
  options: DateFormatOptions = {},
): string | null {
  const date = toDate(value);
  if (date === null) return null;
  return new Intl.DateTimeFormat(options.locale ?? "en-GB", {
    day: "numeric",
    month: options.month ?? "short",
    year: "numeric",
    timeZone: options.timeZone,
  }).format(date);
}

/**
 * `18 Nov 2026 00:45 GMT+11` in Sydney, `17 Nov 2026 13:45 UTC` for the
 * instant itself (pass `{ timeZone: "UTC" }`, as the `<time>` title does).
 */
export function formatDateTime(
  value: DateInput,
  options: DateFormatOptions = {},
): string | null {
  const date = toDate(value);
  if (date === null) return null;
  const locale = options.locale ?? "en-GB";
  const day = formatDate(date, options);
  if (day === null) return null;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).format(date);
  const zone = new Intl.DateTimeFormat(locale, {
    timeZone: options.timeZone,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return zone === undefined ? `${day} ${time}` : `${day} ${time} ${zone}`;
}

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
