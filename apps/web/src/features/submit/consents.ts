/**
 * The consent tracker's data: who has to sign a paper version, and who has.
 *
 * `GET /v1/papers/{id}/v/{n}/consents` (apps/api/.../consents/router.py) lists
 * each author of a version with a `status` of `waiting`, `signed` or
 * `declined`. Before a version exists there is nothing to ask the API, so the
 * draft's own byline is shown with everyone waiting.
 *
 * No React here; `use-consents.ts` polls and `consent-tracker.tsx` draws.
 */

import { ApiError, api } from "../../lib/api";
import { authorLabel, initials, shortDid, type DraftAuthor } from "./authors";

export type ConsentStatus = "waiting" | "signed" | "declined";

export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = {
  waiting: "Waiting",
  signed: "Signed",
  declined: "Declined",
};

/** The paper version a consent report is about. */
export interface VersionRef {
  /** The paper's `sch:` short id (a full genesis cid is accepted too). */
  paper: string;
  /** The version number, from 1. */
  version: number;
}

/** One author in the API's report; only the fields the tracker reads. */
export interface ConsentAuthorReport {
  did: string;
  position: number;
  status: string;
  creditRoles?: string[] | null;
  /** The role the author's consent names, once they have signed. */
  role?: string | null;
}

/** The response of `GET /v1/papers/{id}/v/{n}/consents`. */
export interface ConsentReport {
  paper: string;
  version: number;
  versionCid: string;
  /** The version's lifecycle state: `awaiting_consent`, `scanning`, `draft`, … */
  state: string;
  count: number;
  waiting: number;
  signed: number;
  declined: number;
  authors: ConsentAuthorReport[];
}

/** Fetches a consent report; tests and the Sign step can replace it. */
export type FetchConsents = (ref: VersionRef, signal?: AbortSignal) => Promise<ConsentReport>;

/** Reading a consent report is public, like reading a record, so no token is sent. */
export const fetchConsents: FetchConsents = (ref, signal) =>
  api.get<ConsentReport>(
    `/papers/${encodeURIComponent(ref.paper)}/v/${encodeURIComponent(String(ref.version))}/consents`,
    { auth: false, signal },
  );

/** A sentence for the person watching, from whatever went wrong fetching a report. */
export function consentsErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This node does not have that version yet, so there is nothing to track.";
  }
  return "Could not check who has signed. Trying again shortly.";
}

/** Anything the API sends that is not one of the three statuses counts as waiting. */
export function toConsentStatus(value: string): ConsentStatus {
  return value === "signed" || value === "declined" ? value : "waiting";
}

/** One row of the tracker. */
export interface TrackerEntry {
  /** Stable, for React and for ids. */
  key: string;
  name: string;
  /** Letters for the avatar: only when the author has a name, never from a bare identifier. */
  monogram: string | null;
  /** The identifier under the name: ORCID iD, email or shortened DID. */
  detail: string | null;
  status: ConsentStatus;
  isYou: boolean;
  roles: string[];
}

function detailOf(author: DraftAuthor): string | null {
  if (author.identifier === null) {
    return null;
  }
  if (author.name.trim() === "" && !author.isSubmitter) {
    // The name slot already shows the identifier; do not say it twice.
    return null;
  }
  return author.kind === "did" ? shortDid(author.identifier) : author.identifier;
}

function monogramOf(author: DraftAuthor): string | null {
  return author.name.trim() === "" ? null : initials(author.name);
}

/** The draft's byline with every author waiting: no version, so no consent link has gone out. */
export function trackerFromDraft(authors: readonly DraftAuthor[]): TrackerEntry[] {
  return authors.map((author) => ({
    key: author.key,
    name: authorLabel(author),
    monogram: monogramOf(author),
    detail: detailOf(author),
    status: "waiting" as const,
    isYou: author.isSubmitter,
    roles: [...author.creditRoles],
  }));
}

/**
 * The byline as the node holds it, with each author's real status. The report
 * is what was signed, so it decides who is listed and in what order; the draft
 * only lends names, which the report does not carry.
 */
export function trackerFromReport(
  report: ConsentReport,
  authors: readonly DraftAuthor[] = [],
): TrackerEntry[] {
  return [...report.authors]
    .sort((a, b) => a.position - b.position)
    .map((entry) => {
      const known = authors.find((author) => author.did === entry.did);
      const status = toConsentStatus(entry.status);
      return {
        key: entry.did,
        name: known !== undefined ? authorLabel(known) : shortDid(entry.did),
        monogram: known !== undefined ? monogramOf(known) : null,
        detail: known !== undefined ? detailOf(known) : null,
        status,
        isYou: known?.isSubmitter ?? false,
        roles: entry.creditRoles ?? (entry.role ? [entry.role] : known?.creditRoles ?? []),
      };
    });
}

export interface ConsentCounts {
  total: number;
  waiting: number;
  signed: number;
  declined: number;
}

export function countConsents(entries: readonly TrackerEntry[]): ConsentCounts {
  const counts: ConsentCounts = { total: entries.length, waiting: 0, signed: 0, declined: 0 };
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return counts;
}

/** `2 of 3 signed`, then what is left: `1 waiting` or `1 declined`. */
export function consentSummary(counts: ConsentCounts): string {
  const parts = [`${counts.signed} of ${counts.total} signed`];
  if (counts.waiting > 0) {
    parts.push(`${counts.waiting} waiting`);
  }
  if (counts.declined > 0) {
    parts.push(`${counts.declined} declined`);
  }
  return parts.join(" · ");
}

/** Who declined, as a sentence that says what that does to the version. */
export function declineNotice(entries: readonly TrackerEntry[]): string | null {
  const names = entries.filter((entry) => entry.status === "declined").map((entry) => entry.name);
  if (names.length === 0) {
    return null;
  }
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} declined authorship, so this version is back in draft. Talk to them, then submit again.`;
}
