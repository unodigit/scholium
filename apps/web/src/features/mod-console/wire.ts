/**
 * Small readers for untyped API payloads, shared by the flags, appeals and
 * panel-vote modules.
 *
 * Nothing here knows an endpoint: each reader takes `unknown` and returns a
 * clean value or `null`, so a missing or oddly-typed field degrades to "not
 * given" instead of throwing in the middle of a render.
 */

/** True for a plain JSON object (not an array, not `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A trimmed non-blank string, else `null`. */
export function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A non-negative whole number, else `null`. */
export function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Reasons as a list of trimmed non-blank strings.
 *
 * The API accepts and stores reasons as either one string or a list of
 * strings (`appeal.decision` allows both `reasons` and `reason`), so both
 * read the same way here.
 */
export function readReasons(value: unknown): string[] {
  if (typeof value === "string") {
    const text = readText(value);
    return text === null ? [] : [text];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readText)
    .filter((reason): reason is string => reason !== null);
}

/**
 * `4 May 2027` for an ISO instant, in UTC so the same record reads the same
 * on every machine; `null` when the value is not a date.
 */
export function formatDate(iso: string | null): string | null {
  if (iso === null) {
    return null;
  }
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(time));
}
