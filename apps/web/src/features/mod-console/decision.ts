/**
 * The moderation decision: the paper's signed record, the form's rules, the
 * author-facing preview, and the signed `moderation.decision` submission.
 *
 * A moderator decides one version of a paper (docs/design.md §5.7). The paper
 * is read from its signed `paper.version` envelope
 * (`GET /v1/records/{cid}`) — it is not in the public catalog while it waits,
 * so `GET /v1/papers/{id}` deliberately answers `404` for it. The policy
 * clauses come from `GET /v1/moderation/policies`, and the decision itself is
 * a `moderation.decision` record signed on the moderator's device and posted
 * to `POST /v1/moderation/decisions`.
 *
 * What this module owns:
 *
 * - validating the API payload into {@link ModeratedPaper};
 * - the five decision actions and their human labels;
 * - the required-field rules ({@link validateDecisionDraft}) and the exact
 *   body the API's schema accepts ({@link buildDecisionBody});
 * - the wording of the author-facing preview
 *   ({@link authorPreview}) — the moderator sees what the author will see;
 * - signing and submitting the record, and one plain sentence per failure.
 *
 * Pure data and functions apart from the two default loaders/submitters, so
 * the form, the route and vitest all share the same rules.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import {
  loadPolicies as fetchPolicies,
  type PolicyClause,
} from "../policies-page";
import { deriveShortId } from "../verify-core";
import {
  isDeviceKeyError,
  isPasskeyCancellation,
  signRecord,
  type SignedRecord,
} from "../web-auth";

/** The signed-envelope collection, relative to the API client's `/v1`. */
export const RECORDS_ENDPOINT = "/records";

/** Endpoint path relative to `/v1`; the API client adds the prefix. */
export const DECISIONS_ENDPOINT = "/moderation/decisions";

/** The record type this form signs. */
export const DECISION_RECORD_TYPE = "moderation.decision";

/** Passkey prompt reason for a decision. */
export const SIGN_DECISION_REASON = "Sign decision";

/**
 * The sentence every decision states (docs/design.md §5.7), word for word.
 * It sits beside the form and again on the published decision.
 */
export const PUBLIC_RECORD_NOTICE = "This decision is a public signed record.";

/** The five actions any moderator may choose, in form order. */
export const DECISION_ACTIONS = [
  "list",
  "hold",
  "reclassify",
  "reject",
  "delist",
] as const;

/**
 * The legal takedown (policy MOD-05). The API deletes the version's files and
 * denylists their ids, and accepts it from tier 4 only, so it is not one of
 * {@link DECISION_ACTIONS}: the form adds it for a tier-4 moderator
 * ({@link offeredActions}).
 */
export const TOMBSTONE_ACTION = "tombstone" as const;

/** The trust tier that may issue a tombstone (`Tier.MODERATOR` in the API). */
export const TOMBSTONE_MIN_TIER = 4;

/** One of the five actions any moderator may choose. */
export type StandardAction = (typeof DECISION_ACTIONS)[number];

/** One action of a `moderation.decision` this form can sign. */
export type DecisionAction = StandardAction | typeof TOMBSTONE_ACTION;

/** How each of the five standard actions reads to a moderator. */
export const DECISION_ACTION_LABELS: Readonly<Record<StandardAction, string>> =
  {
    list: "List the paper",
    hold: "Hold from listing",
    reclassify: "Reclassify to another category",
    reject: "Reject the paper",
    delist: "Delist the paper",
  };

/** How the legal takedown reads to a moderator. */
export const TOMBSTONE_LABEL = "Legal takedown (tombstone)";

/** How any action the form can sign reads to a moderator. */
export function actionOptionLabel(action: DecisionAction): string {
  return action === TOMBSTONE_ACTION
    ? TOMBSTONE_LABEL
    : DECISION_ACTION_LABELS[action];
}

/** True when `value` is one of the five standard actions. */
export function isDecisionAction(value: unknown): value is StandardAction {
  return (
    typeof value === "string" &&
    (DECISION_ACTIONS as readonly string[]).includes(value)
  );
}

/** True when `value` is an action this form can sign: a standard one or the tombstone. */
export function isSignableAction(value: unknown): value is DecisionAction {
  return value === TOMBSTONE_ACTION || isDecisionAction(value);
}

/**
 * Whether a moderator of this tier is offered the tombstone.
 *
 * `tier` is read from the claims in the access token, so it only decides what
 * to put in front of the moderator: the API is the gate and refuses a
 * tombstone from anyone below tier 4. A tier the token does not name is not
 * enough to offer it.
 */
export function canTombstone(tier: number | null | undefined): boolean {
  return typeof tier === "number" && tier >= TOMBSTONE_MIN_TIER;
}

/** The actions to offer a moderator of this tier, in form order. */
export function offeredActions(
  tier: number | null | undefined,
): readonly DecisionAction[] {
  return canTombstone(tier)
    ? [...DECISION_ACTIONS, TOMBSTONE_ACTION]
    : DECISION_ACTIONS;
}

// ---------------------------------------------------------------------------
// The paper's signed record
// ---------------------------------------------------------------------------

/** One author as the version record lists them. */
export interface PaperAuthor {
  /** `did:` identifier. Empty only when the record carried a name alone. */
  readonly did: string;
  /** A readable name, falling back to a shortened DID. */
  readonly name: string;
  /** Affiliation, when the signed record included one. */
  readonly affiliation: string | null;
}

/** The version a moderator is deciding, as read from its signed record. */
export interface ModeratedPaper {
  /** The version record's id (the `{cid}` of `GET /v1/records/{cid}`). */
  readonly versionCid: string;
  /** The paper genesis record id, when the body names it. */
  readonly paperCid: string | null;
  /** `sch:xxxx-xxxx-xxxx`, derived from the genesis id; `null` if unreadable. */
  readonly shortId: string | null;
  /** `sch:xxxx-xxxx-xxxx/vN`, when both the short id and version are known. */
  readonly versionId: string | null;
  /** Version number, when the body names one. */
  readonly version: number | null;
  readonly title: string;
  readonly abstract: string;
  readonly authors: readonly PaperAuthor[];
  readonly categories: readonly string[];
  readonly licence: string | null;
  readonly changeNote: string | null;
  /** The manifest record id, when the body names one. */
  readonly manifestCid: string | null;
}

/** Raised when `GET /v1/records/{cid}` did not return a paper version. */
export class ModerationPaperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModerationPaperError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readWholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readText)
    .filter((item): item is string => item !== null);
}

/** A DID that is too long for a byline; ids stay recognisable at both ends. */
export function shortenDid(did: string): string {
  const value = did.trim();
  if (value.length <= 30) {
    return value;
  }
  return `${value.slice(0, 16)}…${value.slice(-8)}`;
}

function readAuthor(value: unknown): PaperAuthor | null {
  if (typeof value === "string") {
    const did = readText(value);
    return did === null
      ? null
      : { did, name: shortenDid(did), affiliation: null };
  }
  if (!isRecord(value)) {
    return null;
  }
  const did = readText(value.did) ?? "";
  const name = readText(value.name);
  const affiliation = readText(value.affiliation);
  if (did === "" && name === null) {
    return null;
  }
  return {
    did,
    name: name ?? shortenDid(did),
    affiliation,
  };
}

function readAuthors(value: unknown): PaperAuthor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readAuthor)
    .filter((author): author is PaperAuthor => author !== null);
}

/**
 * Validate a stored envelope into the version a moderator is deciding.
 *
 * Only the record type and an object body are required: a version whose title
 * is missing still appears (as "Untitled") rather than preventing a moderator
 * from acting on it. Everything optional degrades to an empty value. A record
 * of another type, or a body that is not an object, raises
 * {@link ModerationPaperError} — the page must not try to moderate an
 * endorsement or silently show an empty paper.
 */
export function parseVersionRecord(
  payload: unknown,
  expectedVersionCid?: string,
): ModeratedPaper {
  if (!isRecord(payload)) {
    throw new ModerationPaperError(
      "The server did not return a signed record for this version.",
    );
  }
  if (payload.type !== "paper.version") {
    throw new ModerationPaperError(
      `This record is a ${String(payload.type ?? "unknown")}, not a paper version.`,
    );
  }
  const body = payload.body;
  if (!isRecord(body)) {
    throw new ModerationPaperError(
      "The paper version record has no readable body.",
    );
  }

  const versionCid =
    readText(payload.id) ?? readText(expectedVersionCid) ?? null;
  if (versionCid === null) {
    throw new ModerationPaperError("The version record has no id.");
  }

  const paperCid = readText(body.paper);
  let shortId: string | null = null;
  if (paperCid !== null) {
    try {
      shortId = deriveShortId(paperCid);
    } catch {
      // A malformed genesis id is not a reason to hide the paper; only the
      // friendly `sch:` id is lost.
      shortId = null;
    }
  }
  const version = readWholeNumber(body.n);

  return {
    versionCid,
    paperCid,
    shortId,
    versionId:
      shortId !== null && version !== null
        ? `${shortId}/v${version}`
        : version !== null
          ? `v${version}`
          : null,
    version,
    title: readText(body.title) ?? "Untitled",
    abstract: readText(body.abstract) ?? "",
    authors: readAuthors(body.authors),
    categories: readTextList(body.categories),
    licence: readText(body.licence),
    changeNote: readText(body.changeNote),
    manifestCid: readText(body.manifest),
  };
}

/** Anything that can read a stored envelope; the shared client by default. */
export type PaperClient = Pick<ApiClient, "get">;

/**
 * Read the version's signed record from `GET /v1/records/{cid}`.
 *
 * The endpoint is public, so no bearer token is sent, and the request is
 * never cached: a moderator must decide on the record as it is now.
 */
export async function loadModeratedPaper(
  versionCid: string,
  client: PaperClient = api,
): Promise<ModeratedPaper> {
  const payload = await client.get<unknown>(
    `${RECORDS_ENDPOINT}/${encodeURIComponent(versionCid)}`,
    { auth: false, cache: "no-store" },
  );
  return parseVersionRecord(payload, versionCid);
}

/** Load the clauses a decision may cite. */
export async function loadDecisionClauses(): Promise<PolicyClause[]> {
  return fetchPolicies();
}

// ---------------------------------------------------------------------------
// The decision draft and the signed body
// ---------------------------------------------------------------------------

/** What the moderator has filled in so far. */
export interface DecisionDraft {
  /** The chosen action, or `""` before one is chosen. */
  readonly action: DecisionAction | "";
  /** The cited clause id, or `""` before one is chosen. */
  readonly clause: string;
  /** The reason shown to the author. */
  readonly reason: string;
  /** The new category, for `reclassify` only. */
  readonly category: string;
}

/** A blank draft: no action and no clause chosen. */
export const EMPTY_DECISION_DRAFT: DecisionDraft = {
  action: "",
  clause: "",
  reason: "",
  category: "",
};

/** A field of the form that can fail validation. */
export type DecisionField = "action" | "clause" | "reason" | "category";

/** Field-level validation messages; empty when the draft is complete. */
export type DecisionValidation = Partial<Record<DecisionField, string>>;

/** Raised when an incomplete draft is turned into a signed body. */
export class DecisionDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionDraftError";
  }
}

/**
 * The rules the form enforces before the passkey prompt:
 *
 * - an action (`moderation.decision` requires one);
 * - a policy clause from the published list (the API refuses an unknown one);
 * - a non-blank reason (the API refuses a blank one); for a tombstone it is
 *   the legal reason for the takedown;
 * - a category for `reclassify` (the API requires it to move the paper).
 *
 * The action is required even though it is a select: an empty first option
 * makes the moderator choose deliberately instead of accepting `list`.
 */
export function validateDecisionDraft(
  draft: DecisionDraft,
): DecisionValidation {
  const errors: DecisionValidation = {};
  if (!isSignableAction(draft.action)) {
    errors.action = "Choose an action.";
  }
  if (draft.clause.trim() === "") {
    errors.clause = "Choose the policy clause this decision cites.";
  }
  if (draft.reason.trim() === "") {
    errors.reason =
      draft.action === TOMBSTONE_ACTION
        ? "State the legal reason for the takedown."
        : "Write the reason the author will see.";
  }
  if (draft.action === "reclassify" && draft.category.trim() === "") {
    errors.category = "Name the category the paper moves to.";
  }
  return errors;
}

/** The body of a signed `moderation.decision` record. */
export type DecisionBody = {
  /** The version being decided. */
  target: string;
  action: DecisionAction;
  /** A clause id from `GET /v1/moderation/policies`. */
  clause: string;
  /** The reason shown to the author. */
  reason: string;
  /** The new category, for `reclassify` only. */
  category?: string;
} & Record<string, unknown>;

/**
 * Turn a complete draft into the record body the API expects.
 *
 * Values are trimmed and an unused `category` is omitted, so the signed record
 * carries exactly what the author will read. An incomplete draft raises
 * {@link DecisionDraftError} instead of signing a record the API would refuse.
 */
export function buildDecisionBody(
  versionCid: string,
  draft: DecisionDraft,
): DecisionBody {
  if (!isSignableAction(draft.action)) {
    throw new DecisionDraftError("Choose an action before signing the decision.");
  }
  const clause = draft.clause.trim();
  if (clause === "") {
    throw new DecisionDraftError(
      "Choose a policy clause before signing the decision.",
    );
  }
  const reason = draft.reason.trim();
  if (reason === "") {
    throw new DecisionDraftError(
      draft.action === TOMBSTONE_ACTION
        ? "State the legal reason for the takedown before signing the decision."
        : "Write the reason the author will see before signing the decision.",
    );
  }

  const body: DecisionBody = {
    target: versionCid,
    action: draft.action,
    clause,
    reason,
  };
  if (draft.action === "reclassify") {
    const category = draft.category.trim();
    if (category === "") {
      throw new DecisionDraftError(
        "Name the category the paper moves to before signing the decision.",
      );
    }
    body.category = category;
  }
  return body;
}

// ---------------------------------------------------------------------------
// The author-facing preview
// ---------------------------------------------------------------------------

/** What the author will read, assembled from the draft. */
export interface AuthorPreview {
  /** The first sentence: what happened to the paper. */
  readonly headline: string;
  /** The cited clause, when one is chosen. */
  readonly clause: PolicyClause | null;
  /** The reason exactly as it will be published; empty before one is written. */
  readonly reason: string;
  /** The appeal sentence, for actions an author can appeal. */
  readonly appeal: string | null;
}

/**
 * The message the author will see (docs/design.md §8), written from the same
 * values that will be signed. The preview is intentionally plain: outcome,
 * reason, the clause it cites, and whether an appeal is available.
 *
 * Returns `null` until an action is chosen: without an outcome there is no
 * message to preview.
 */
export function authorPreview(
  draft: DecisionDraft,
  clauses: readonly PolicyClause[],
): AuthorPreview | null {
  if (!isSignableAction(draft.action)) {
    return null;
  }

  const category = draft.category.trim();
  let headline: string;
  switch (draft.action) {
    case "list":
      headline = "Your paper has been listed.";
      break;
    case "hold":
      headline = "Your paper is on hold and has not been listed.";
      break;
    case "reclassify":
      headline =
        category === ""
          ? "Your paper has been reclassified to a different category."
          : `Your paper has been reclassified to ${category}.`;
      break;
    case "reject":
      headline = "Your paper has not been listed.";
      break;
    case "delist":
      headline = "Your paper has been removed from the catalog.";
      break;
    case "tombstone":
      headline =
        "Your paper's files have been removed for legal reasons, and the paper is no longer listed.";
      break;
  }

  const clause =
    clauses.find((item) => item.id === draft.clause.trim()) ?? null;
  const appeal =
    draft.action === "hold" ||
    draft.action === "reject" ||
    draft.action === "delist"
      ? "You can appeal once."
      : null;

  return { headline, clause, reason: draft.reason.trim(), appeal };
}

// ---------------------------------------------------------------------------
// Signing and submitting the decision
// ---------------------------------------------------------------------------

/** The 201 body of `POST /v1/moderation/decisions`, in the form's terms. */
export interface DecisionAccepted {
  /** The decision record's id (`GET /v1/records/{id}` serves it). */
  readonly id: string;
  readonly shortId: string | null;
  readonly target: string;
  readonly action: string;
  readonly clause: string;
  /** The version's state once the decision was applied. */
  readonly state: string;
  /** Public-timestamp status; `pending` until anchoring exists. */
  readonly anchor: string;
}

/** Signs a decision body with the moderator's device key. */
export type DecisionSigner = (body: DecisionBody) => Promise<SignedRecord>;

/** Submits a signed decision to the API. */
export type DecisionSubmitter = (
  record: SignedRecord,
) => Promise<DecisionAccepted>;

/** Anything that can POST; the shared API client by default. */
export type DecisionClient = Pick<ApiClient, "post">;

/**
 * Sign `moderation.decision` with the device key behind a passkey prompt.
 *
 * `prev` is `null`: a decision is a record of its own, appended to the public
 * log, not the next link in the paper's chain (the API's fixtures sign it the
 * same way).
 */
export async function signModerationDecision(
  body: DecisionBody,
): Promise<SignedRecord> {
  return signRecord(DECISION_RECORD_TYPE, body, null, {
    reason: SIGN_DECISION_REASON,
  });
}

/**
 * Validate the API's answer into a {@link DecisionAccepted}.
 *
 * A `201` means the decision was applied even if the body is unexpected, so
 * every missing field falls back to what was signed rather than turning a
 * success into an apparent failure (which would invite a duplicate submit).
 */
export function parseDecisionAccepted(
  payload: unknown,
  fallback: Pick<DecisionAccepted, "id" | "target" | "action" | "clause">,
): DecisionAccepted {
  const item = isRecord(payload) ? payload : {};
  return {
    id: readText(item.id) ?? fallback.id,
    shortId: readText(item.shortId) ?? readText(item.short_id),
    target: readText(item.target) ?? fallback.target,
    action: readText(item.action) ?? fallback.action,
    clause: readText(item.clause) ?? fallback.clause,
    state: readText(item.state) ?? "accepted",
    anchor: readText(item.anchor) ?? "pending",
  };
}

/** Post a signed decision to `POST /v1/moderation/decisions`. */
export async function submitModerationDecision(
  record: SignedRecord,
  client: DecisionClient = api,
): Promise<DecisionAccepted> {
  const body = record.body as DecisionBody;
  const payload = await client.post<unknown>(DECISIONS_ENDPOINT, record);
  return parseDecisionAccepted(payload, {
    id: record.id,
    target: body.target,
    action: body.action,
    clause: body.clause,
  });
}

/**
 * One plain sentence for a failed load of the paper.
 *
 * The record endpoint is public, so a `401`/`403` here would mean the session
 * or the account changed under the page; a `404` means the node no longer has
 * the version. Those are said plainly, as is an unreachable API.
 */
export type PaperFailure =
  | { readonly kind: "signed-out"; readonly message: string }
  | {
      readonly kind: "forbidden";
      readonly message: string;
      readonly callerTier: number | null;
    }
  | { readonly kind: "error"; readonly message: string };

/** The failure for a visitor with no session; no request is made for them. */
export const PAPER_SIGNED_OUT_FAILURE: PaperFailure = {
  kind: "signed-out",
  message: "Sign in with a moderator account to decide on this paper.",
};

export function classifyPaperError(error: unknown): PaperFailure {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        kind: "signed-out",
        message: "Your session has ended. Sign in again to open this paper.",
      };
    }
    if (error.isForbidden) {
      const tier = error.problem.caller_tier;
      return {
        kind: "forbidden",
        message:
          "The moderation console is for moderators (trust tier 4).",
        callerTier:
          typeof tier === "number" && Number.isInteger(tier) ? tier : null,
      };
    }
    if (error.status === 404) {
      return {
        kind: "error",
        message:
          "This record is not on this server. It may have been removed or already decided.",
      };
    }
    return {
      kind: "error",
      message:
        error.detail || error.title || "The paper could not be loaded.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message:
        "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  if (error instanceof ModerationPaperError) {
    return { kind: "error", message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "The paper could not be loaded." };
}

/**
 * One plain sentence for a decision that was not published.
 *
 * Nothing is recorded on any of these paths, so the message says so where it
 * matters (a dismissed passkey prompt) and names the retryable cases.
 */
export function describeDecisionError(error: unknown): string {
  if (isPasskeyCancellation(error)) {
    return "Signing was cancelled, so the decision was not published.";
  }
  if (isDeviceKeyError(error)) {
    switch (error.code) {
      case "not-found":
        return "This device has no signing key. Sign in again, then record the decision.";
      case "unsupported":
        return "This browser cannot sign with a passkey, so the decision was not published.";
      case "storage-unavailable":
        return "The browser could not reach its key store, so the decision was not published.";
      case "locked":
        return "Unlock your signing key with your passkey, then record the decision.";
      default:
        return "The decision could not be signed, so it was not published.";
    }
  }
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return "Your session has ended. Sign in again to record the decision.";
    }
    if (error.isForbidden) {
      return "Only a moderator (trust tier 4) can record a decision.";
    }
    if (error.status === 409) {
      return (
        error.detail ||
        "This decision conflicts with the version's current state. Refresh the queue and try again."
      );
    }
    return (
      error.detail ||
      error.title ||
      "The API refused the decision. Nothing was published."
    );
  }
  if (error instanceof NetworkError) {
    return "Scholium could not reach the API, so the decision was not published. Try again.";
  }
  if (error instanceof DecisionDraftError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The decision could not be recorded.";
}
