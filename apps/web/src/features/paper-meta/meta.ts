/**
 * The data behind the Versions and Files tabs (docs/design.md §5.2).
 *
 * Two public reads from the catalog plugin:
 *
 * - `GET /v1/papers/{id}/versions` (feature 80) — the version timeline,
 *   oldest first: `n`, `cid`, `change_note`, `listed_at` and the record's
 *   anchor status;
 * - `GET /v1/papers/{id}/v/{n}/manifest` (feature 81) — the signed file list
 *   of one version: `path`, `cid`, `size`, `mediaType`, `role`, plus the
 *   version's `licence` and each file's live `scanStatus`.
 *
 * Everything a node sends is checked before it is shown. A body that is not
 * the expected shape at all is an error ("we don't know"), never an empty
 * timeline ("nothing is listed"); a single unreadable row is dropped, so one
 * bad entry cannot take the tab down. Anchor status is read conservatively:
 * anything not recognised is *pending*, never more verified than the node
 * actually said, the same rule the Proof tab follows
 * (`features/paper-proof/anchor.ts`).
 *
 * Pure data and functions (plus the injectable loaders), no React, so the
 * server route, the client components and vitest share one parse path.
 */

import {
  ApiError,
  NetworkError,
  api,
  resolveApiBaseUrl,
  type ApiClient,
} from "../../lib/api";
import { formatVersionId, parseShortId, parseVersionId } from "../verify-core";
import type { IconName } from "../ui-kit";
import {
  formatDate as formatReaderDate,
  formatDateTime as formatReaderDateTime,
} from "../ui-kit/format-date";

/* -------------------------------------------------------------------------- */
/* Wire shape                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A version's public timestamp, as far as a reader needs it.
 *
 * The node does not anchor its log on-chain yet, so every version reads
 * `pending` today — a state, not an error. The anchored form is read when a
 * node sends it (`docs/design.md §5.3`), and a bare `"anchored"` with no time
 * stays pending: "anchored" without a date is not a timestamp.
 */
export type VersionAnchor =
  | { readonly status: "pending" }
  | {
      readonly status: "anchored";
      /** ISO 8601 instant the batch was anchored. */
      readonly anchoredAt: string;
      /** An `https:` transaction link, or `null`. Only `https:` is rendered. */
      readonly txUrl: string | null;
    };

/** One row of the version timeline. */
export interface VersionEntry {
  /** Version number, 1-based. */
  readonly n: number;
  /** Id of the signed `paper.version` record. */
  readonly cid: string;
  /** What the author said changed; `null` when the version names none. */
  readonly changeNote: string | null;
  /** When the version was listed (ISO 8601, UTC); `null` when not stamped. */
  readonly listedAt: string | null;
  readonly anchor: VersionAnchor;
}

/** The version timeline of one paper. */
export interface VersionsData {
  /** Canonical paper id (`sch:xxxx-xxxx-xxxx`), when the node says it. */
  readonly paper: string;
  /** Id of the paper's genesis record, when the node says it. */
  readonly paperCid: string | null;
  /** Oldest first, version 1 first. */
  readonly versions: readonly VersionEntry[];
}

/** The sanitizer's verdict on a file's bytes. */
export const SCAN_STATUSES = ["passed", "scanning", "failed", "missing", "unknown"] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** One file of a version, as the signed manifest lists it. */
export interface ManifestFile {
  /** Path inside the paper's bundle, `paper.pdf` or `figures/fig1.png`. */
  readonly path: string;
  /** The signed file id: `GET /v1/content/{cid}` serves its bytes. */
  readonly cid: string;
  /** Exact length in bytes. */
  readonly size: number;
  /** The bare `type/subtype` the signed manifest declares, when given. */
  readonly mediaType: string | null;
  /** What the file is for: `manuscript`, `source`, `code`, `data`… */
  readonly role: string;
  /** The licence the signed version names (a file carries none of its own). */
  readonly licence: string | null;
  readonly scanStatus: ScanStatus;
}

/** The signed files of one version. */
export interface ManifestData {
  /** Canonical paper id, when the node says it. */
  readonly paper: string;
  /** Id of the `paper.version` record, when the node says it. */
  readonly versionCid: string | null;
  /** Version number, 1-based. */
  readonly n: number;
  /** Id of the signed `manifest` record, when the node says it. */
  readonly manifestCid: string | null;
  /** The licence the signed version names. */
  readonly licence: string | null;
  /** In signed manifest order. */
  readonly files: readonly ManifestFile[];
}

/**
 * The node answered, but not with something this tab can show. The message is
 * shown to the reader as is, so write it for them.
 */
export class MetaResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaResponseError";
  }
}

/* -------------------------------------------------------------------------- */
/* Reading a node's answer                                                     */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A non-empty trimmed string, or `null`. */
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** The first non-empty string among `keys` (the API spells some fields twice). */
function pickText(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const text = readText(record[key]);
    if (text !== null) return text;
  }
  return null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function pickInteger(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = readInteger(record[key]);
    if (number !== null) return number;
  }
  return null;
}

/** An ISO instant worth showing, or `null`. */
function pickTimestamp(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const text = readText(record[key]);
    if (text !== null && !Number.isNaN(Date.parse(text))) return text;
  }
  return null;
}

/** Only `https:` links are rendered: a node's string is never a `javascript:` URL. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Read a version's anchor field. Accepts the string the node sends today
 * (`"pending"`) and the anchored object `docs/design.md §5.3` shows; anything
 * else, including a bare `"anchored"` with no usable time, is pending.
 */
export function parseVersionAnchor(value: unknown): VersionAnchor {
  if (!isRecord(value) || value.status !== "anchored") {
    return { status: "pending" };
  }
  const anchoredAt = readText(value.anchored_at) ?? readText(value.anchoredAt);
  if (anchoredAt === null || Number.isNaN(Date.parse(anchoredAt))) {
    return { status: "pending" };
  }
  return {
    status: "anchored",
    anchoredAt,
    txUrl: httpsUrl(value.tx_url) ?? httpsUrl(value.txUrl),
  };
}

function parseVersionEntry(value: unknown): VersionEntry | null {
  if (!isRecord(value)) return null;
  const n = pickInteger(value, "n", "version");
  const cid = pickText(value, "cid", "versionCid", "version_cid");
  // A row with no number or no record to link to is of no use to a reader.
  if (n === null || n < 1 || cid === null) return null;
  return {
    n,
    cid,
    changeNote: pickText(value, "change_note", "changeNote"),
    listedAt: pickTimestamp(value, "listed_at", "listedAt"),
    anchor: parseVersionAnchor(
      value.anchor ?? value.anchorStatus ?? value.anchor_status,
    ),
  };
}

/**
 * Validate a `GET /v1/papers/{id}/versions` body.
 *
 * A body that is not a version list is an error, never an empty timeline: an
 * empty timeline would say "nothing is listed" when the truth is "we don't
 * know". Unreadable rows are dropped, and the rest are sorted oldest first so
 * the timeline reads v1 → vN whatever order a node sends.
 */
export function parseVersions(payload: unknown): VersionsData {
  if (!isRecord(payload) || !Array.isArray(payload.versions)) {
    throw new MetaResponseError("The node did not return a version list.");
  }
  const versions = payload.versions
    .map(parseVersionEntry)
    .filter((version): version is VersionEntry => version !== null)
    .sort((left, right) => left.n - right.n);
  return {
    paper: pickText(payload, "shortId", "paper") ?? "",
    paperCid: pickText(payload, "paperCid", "paper_cid"),
    versions,
  };
}

/** Narrow a scan verdict (and its `scan_status` spelling) to a known token. */
export function normalizeScanStatus(value: unknown): ScanStatus {
  const text = readText(value);
  if (text === null) return "unknown";
  const token = text.toLowerCase().replace(/[\s-]+/g, "_");
  return (SCAN_STATUSES as readonly string[]).includes(token)
    ? (token as ScanStatus)
    : "unknown";
}

function parseManifestFile(value: unknown, licence: string | null): ManifestFile | null {
  if (!isRecord(value)) return null;
  const path = readText(value.path);
  const cid = readText(value.cid);
  const size = readInteger(value.size);
  if (path === null || cid === null || size === null || size < 0) return null;
  return {
    path,
    cid,
    size,
    mediaType: pickText(value, "mediaType", "media_type"),
    role: pickText(value, "role") ?? "other",
    licence: pickText(value, "licence", "license") ?? licence,
    scanStatus: normalizeScanStatus(value.scanStatus ?? value.scan_status),
  };
}

/**
 * Validate a `GET /v1/papers/{id}/v/{n}/manifest` body.
 *
 * A body that is not a file list is an error. A file without a path, an id or
 * a whole-number size is dropped: it could neither be shown nor downloaded.
 */
export function parseManifest(payload: unknown): ManifestData {
  if (!isRecord(payload) || !Array.isArray(payload.files)) {
    throw new MetaResponseError("The node did not return a file list.");
  }
  const licence = pickText(payload, "licence", "license");
  return {
    paper: pickText(payload, "shortId", "paper") ?? "",
    versionCid: pickText(payload, "versionCid", "version_cid"),
    n: pickInteger(payload, "n", "version") ?? 1,
    manifestCid: pickText(payload, "manifestCid", "manifest_cid"),
    licence,
    files: payload.files
      .map((file) => parseManifestFile(file, licence))
      .filter((file): file is ManifestFile => file !== null),
  };
}

/* -------------------------------------------------------------------------- */
/* Endpoints and loaders                                                       */
/* -------------------------------------------------------------------------- */

/** The version timeline's path under `/v1`; the API client adds the prefix. */
export function versionsEndpoint(paperId: string): string {
  return `/papers/${encodeURIComponent(paperId.trim())}/versions`;
}

/** The file manifest's path under `/v1`. */
export function manifestEndpoint(paperId: string, version: number): string {
  return `/papers/${encodeURIComponent(paperId.trim())}/v/${version}/manifest`;
}

/**
 * The public bytes of one file: `GET /v1/content/{cid}` on the same node.
 *
 * Only `passed` files are served; the tab therefore links only those. This is
 * an absolute URL because it is an `<a download>`, not an API-client request.
 */
export function contentUrl(cid: string, baseUrl?: string): string {
  return `${resolveApiBaseUrl(baseUrl)}/v1/content/${encodeURIComponent(cid)}`;
}

/** `GET`-only slice of the API client, so tests need no network stack. */
export type MetaClient = Pick<ApiClient, "get">;

/** Loads a paper's version timeline. Rejects with a reason {@link describeMetaError} can say. */
export type LoadVersions = (paperId: string, signal?: AbortSignal) => Promise<VersionsData>;

/** Loads one version's file manifest. */
export type LoadManifest = (
  paperId: string,
  version: number,
  signal?: AbortSignal,
) => Promise<ManifestData>;

/** Read one paper's version timeline through the shared API client. Public read. */
export async function loadVersions(
  paperId: string,
  signal?: AbortSignal,
  client: MetaClient = api,
): Promise<VersionsData> {
  const payload = await client.get<unknown>(versionsEndpoint(paperId), {
    auth: false,
    cache: "no-store",
    signal,
  });
  return parseVersions(payload);
}

/** Read one version's file manifest through the shared API client. Public read. */
export async function loadManifest(
  paperId: string,
  version: number,
  signal?: AbortSignal,
  client: MetaClient = api,
): Promise<ManifestData> {
  const payload = await client.get<unknown>(manifestEndpoint(paperId, version), {
    auth: false,
    cache: "no-store",
    signal,
  });
  return parseManifest(payload);
}

/** A reader-facing sentence for why a tab's data could not be loaded. */
export function describeMetaError(error: unknown, what: "versions" | "files"): string {
  if (error instanceof MetaResponseError) return error.message;
  if (error instanceof NetworkError) {
    return "Couldn’t reach the node. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      return what === "versions"
        ? "This node has no listed versions of that paper. Check the id."
        : "This node has no files for that version.";
    }
    if (error.status === 429) {
      return "Too many requests just now. Wait a moment and try again.";
    }
    return error.detail || error.title || "The node could not answer. Try again.";
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return what === "versions"
    ? "The version history could not be loaded. Try again."
    : "The file list could not be loaded. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Words and formats                                                           */
/* -------------------------------------------------------------------------- */

/** The change note, or the honest sentence for a version that names none. */
export function changeNoteText(version: { n: number; changeNote: string | null }): string {
  if (version.changeNote !== null) return version.changeNote;
  return version.n === 1 ? "First version." : "No change note was given.";
}

/**
 * One size format for the whole product (`759 B`, `3.0 KB`, `1.5 MB`). The
 * Files tab, the compare view and `/verify` share it so the same signed file
 * reads the same everywhere (bug_spec_verify5 bug 5); see
 * `ui-kit/format-bytes.ts`.
 */
export { formatBytes } from "../ui-kit/format-bytes";

/**
 * `2 Mar 2027`, in the reader's own time zone, through the shared `ui-kit`
 * formatter: the Versions tab's day must be the day the feed and the profile
 * show for the same instant (bug_spec_verify12 bug 2).
 */
export function formatDate(iso: string): string {
  return formatReaderDate(iso) ?? iso;
}

/**
 * `2 Mar 2027 04:00 UTC`, the Proof tab's wording for an anchor.
 *
 * An anchor is explicitly a UTC fact (the proof names the instant and the log
 * head it attests), so this one keeps the `UTC` label and stays in UTC; a
 * reader-facing date uses `formatDate` above.
 */
export function formatDateTime(iso: string): string {
  return formatReaderDateTime(iso, { timeZone: "UTC" }) ?? iso;
}

/** Human words for the licences the catalog uses, keyed case-insensitively. */
const LICENCE_LABELS: Readonly<Record<string, string>> = {
  "cc-by-4.0": "CC BY 4.0",
  "cc-by-3.0": "CC BY 3.0",
  "cc-by-sa-4.0": "CC BY-SA 4.0",
  "cc-by-nc-4.0": "CC BY-NC 4.0",
  "cc-by-nd-4.0": "CC BY-ND 4.0",
  "cc0-1.0": "CC0 1.0",
  mit: "MIT",
  "apache-2.0": "Apache 2.0",
  "bsd-3-clause": "BSD 3-Clause",
  arr: "All rights reserved",
};

/**
 * The reader-facing licence: `CC-BY-4.0` prints as `CC BY 4.0`. An unknown
 * identifier is shown as it came, never guessed at; an absent one says so.
 */
export function licenceLabel(licence: string | null | undefined): string {
  const text = typeof licence === "string" ? licence.trim() : "";
  if (text === "") return "No licence stated";
  return LICENCE_LABELS[text.toLowerCase()] ?? text;
}

/** Human words for the roles the signed manifest uses. */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  manuscript: "Manuscript",
  source: "Source",
  figure: "Figure",
  table: "Table",
  data: "Data",
  dataset: "Data",
  code: "Code",
  supplement: "Supplement",
  "reproduction-log": "Reproduction log",
  reproduction_log: "Reproduction log",
  other: "File",
};

/** `manuscript` → `Manuscript`; an unknown role is capitalised, not dropped. */
export function roleLabel(role: string | null | undefined): string {
  const text = typeof role === "string" ? role.trim() : "";
  if (text === "") return "File";
  const known = ROLE_LABELS[text.toLowerCase()];
  if (known !== undefined) return known;
  const words = text.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How one scan verdict looks and reads. */
export interface ScanStatusSpec {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: "verified" | "pending" | "critical" | "neutral";
  /** One plain sentence, for a tooltip. */
  readonly meaning: string;
}

/**
 * Scan status never depends on colour: each verdict has its own word and its
 * own icon silhouette (`docs/design.md §9`).
 */
export const SCAN_STATUS_SPECS: Readonly<Record<ScanStatus, ScanStatusSpec>> = {
  passed: {
    label: "Scan passed",
    icon: "check",
    tone: "verified",
    meaning: "The file was scanned and no active content was found.",
  },
  scanning: {
    label: "Scanning",
    icon: "spinner",
    tone: "pending",
    meaning: "The file is still being scanned. Download opens when it finishes.",
  },
  failed: {
    label: "Scan failed",
    icon: "cross",
    tone: "critical",
    meaning: "The scan found active content, so the file is not served.",
  },
  missing: {
    label: "Not available",
    icon: "question",
    tone: "neutral",
    meaning: "This node holds no copy of the file, so it cannot be downloaded.",
  },
  unknown: {
    label: "Scan unknown",
    icon: "question",
    tone: "neutral",
    meaning: "The node did not say what the scan found.",
  },
};

/** Only a file the node will serve may be linked. */
export function isDownloadable(file: Pick<ManifestFile, "scanStatus">): boolean {
  return file.scanStatus === "passed";
}

/** How a version's anchor reads. */
export interface AnchorSpec {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: "verified" | "pending";
  readonly meaning: string;
}

/** The words and icon for a version's anchor, pending or anchored. */
export function anchorSpec(anchor: VersionAnchor): AnchorSpec {
  if (anchor.status === "anchored") {
    return {
      label: `Anchored ${formatDateTime(anchor.anchoredAt)}`,
      icon: "check",
      tone: "verified",
      meaning: "The version's public timestamp is on record.",
    };
  }
  return {
    // The reader is told *why* there is no date, in the same sentence every
    // page uses (bug_spec_verify5 bug 5), rather than a bare "pending" that
    // reads like something is about to happen.
    label: "Anchor pending. Anchoring is not enabled on this node yet",
    icon: "pending",
    tone: "pending",
    // This node has no anchoring configured (phase 1), so pending never
    // promises a time; only the anchored state names a date.
    meaning: "Anchoring is not enabled on this node yet.",
  };
}

/* -------------------------------------------------------------------------- */
/* Paper ids and page paths                                                    */
/* -------------------------------------------------------------------------- */

/** A paper, and optionally one of its versions. */
export interface MetaRef {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** Version number, or `null` for "the newest version". */
  readonly version: number | null;
  /** `shortId`, with `/vN` when there is a version. */
  readonly schId: string;
}

/** Thrown when text is not a well-formed paper or version id. */
export class MetaRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaRefError";
  }
}

/**
 * Parse `sch:xxxx-xxxx-xxxx` or `sch:xxxx-xxxx-xxxx/vN`.
 *
 * The format and checksum are verify-core's, so a mistyped id is reported as
 * such instead of being sent to the node as a paper that does not exist.
 *
 * @throws {MetaRefError} if the text is malformed or its checksum is wrong.
 */
export function parseMetaRef(value: string): MetaRef {
  const text = typeof value === "string" ? value.trim() : "";
  try {
    if (text.includes("/")) {
      const { shortId, version } = parseVersionId(text);
      return { shortId, version, schId: formatVersionId(shortId, version) };
    }
    const shortId = parseShortId(text);
    return { shortId, version: null, schId: shortId };
  } catch (error) {
    throw new MetaRefError(
      error instanceof Error ? error.message : "Not a paper id.",
    );
  }
}

/** Decode one URL segment, leaving it alone when it is not valid escaping. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The paper named by route segments: `["6sel-2dio-orm6"]` or
 * `["6sel-2dio-orm6", "v2"]`. The `sch:` prefix is optional, and `sch%3A…` as
 * a browser or pasted link may encode it is decoded first.
 *
 * @throws {MetaRefError} if there are no segments, more than two, or they do
 *   not name a paper.
 */
export function metaRefFromSegments(segments: readonly string[]): MetaRef {
  if (segments.length < 1 || segments.length > 2) {
    throw new MetaRefError(
      "Expected a paper id like 6sel-2dio-orm6, optionally followed by a version like v2.",
    );
  }
  const [first, ...rest] = segments.map(decodeSegment);
  const paper = /^sch:/i.test(first) ? first : `sch:${first}`;
  return parseMetaRef([paper, ...rest].join("/"));
}

/** The paper page: `/p/6sel-2dio-orm6` (docs/design.md §4 drops the `sch:`). */
export function paperPath(paperId: string): string {
  const id = paperId.trim().replace(/^sch:/i, "");
  return `/p/${encodeURIComponent(id)}`;
}

/** One version's page: `/p/6sel-2dio-orm6/v2`. */
export function versionPath(paperId: string, version: number): string {
  return `${paperPath(paperId)}/v${version}`;
}

/** The version the page shows: the one asked for, else the newest listed. */
export function currentVersionOf(
  versions: VersionsData | null | undefined,
  requested: number | null = null,
): number | null {
  if (requested !== null) return requested;
  const latest = versions?.versions.at(-1);
  return latest === undefined ? null : latest.n;
}
