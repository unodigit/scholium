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
 * instant agrees. They are plain functions, usable from server and client code
 * alike. `LocalDate` (`./local-date`) renders a `<time datetime>` with the UTC
 * instant as its title and swaps in the local date after hydration: the first
 * HTML is stable in any zone, so the server and the browser never disagree.
 * It is a client component, so it lives in a file of its own: a module that
 * imports a React hook cannot be reached from a server component's imports
 * (`next build` refuses it), and these functions must stay reachable from one.
 *
 * ICU's `Intl.DateTimeFormat` with an explicit IANA zone is Baseline widely
 * available, which is why this does not use Temporal (still Limited
 * availability, and a ~15 KB polyfill).
 */

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

/**
 * A zone designator at the end of a timestamp: `Z`, `z`, `±hh:mm`, `±hhmm` or
 * `±hh`.
 */
const ZONE_DESIGNATOR = /(?:[Zz]|[+-]\d{2}:?\d{2}|[+-]\d{2})$/;

/**
 * An ISO 8601 date-time with no zone designator: `2026-11-18T04:53:41`
 * (seconds and their fraction optional; a space also reads as the `T`).
 */
const ZONELESS_ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  // The API writes UTC instants with no zone designator, and `new Date` reads
  // such a string in the runtime's own zone (ECMA-262: no offset means local
  // time), so a reader east of UTC was told an instant happened up to a day
  // before it did — the review page dated a reveal one day early. Name the
  // zone the API means before parsing; a timestamp that carries its own zone,
  // and anything that is not an ISO date-time, is left exactly as it is.
  const instant =
    !ZONE_DESIGNATOR.test(value) && ZONELESS_ISO_DATETIME.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(instant);
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
