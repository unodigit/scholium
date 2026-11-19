/**
 * The `/onboarding` steps (feature 142).
 *
 * Onboarding is five steps: the four `docs/design.md` §6 fixes, plus the
 * profile step a new member needs so their name appears instead of a truncated
 * DID:
 *
 * ```text
 * create passkey → add your name → link ORCID → pick categories → set guardians
 * ```
 *
 * The passkey exists by the time the user lands here (the first sign-in
 * created it), so this module is about the remaining four and about showing
 * where each step stands:
 *
 * - **add your name** — `PUT /v1/profiles/{did}` (feature 28, PRD ID-7) saves
 *   the display name, an optional affiliation and an email. The API encrypts
 *   them and only shows the name and affiliation publicly; pages that already
 *   read profile names then stop showing a truncated DID. The step is done
 *   once a profile with a name is observed (or one is saved from here).
 * - **link ORCID** — `GET /v1/auth/orcid/start` (feature 31) returns the
 *   authorize URL; the browser is sent there whole-page and comes back to the
 *   web app's `/onboarding/orcid` page, which POSTs the `code` and `state`
 *   ORCID returned to the *authenticated* `POST /v1/auth/orcid/complete`. The
 *   API only links the iD when the signed-in user is the account that started
 *   the flow, so a link someone else opened cannot attach their iD to your
 *   account (or yours to theirs). The start is remembered so the step can say
 *   "in progress", and finishing it (or a best-effort profile lookup) flips it
 *   to done once a linked ORCID iD is visible.
 * - **pick categories** — each pick is `PUT /v1/me/follows/{category}`
 *   (feature 179). Following is *not* a dependency of this feature, so when
 *   the endpoint answers 404/405/501 the picks are still kept (on this
 *   device) and the step completes; they sync once following exists.
 * - **set guardians** — `PUT /v1/me/guardians` (feature 36) saves exactly
 *   five guardian DIDs. The same rules the API enforces are checked here
 *   first, so most mistakes never leave the browser, and a 422 problem
 *   document's per-entry `errors` are mapped back onto the inputs. The first
 *   list goes in with the access token alone; *replacing* a saved list is a
 *   recovery-critical change, so it is also signed by this device's key (see
 *   {@link guardianChangeMessage} and {@link saveGuardians}).
 *
 * Guardians are **strongly recommended, not required**: nothing refuses a
 * submission without them, but without guardians an account cannot be
 * recovered if its device is lost, so the checklist nudges towards setting
 * them before it finishes (see `use-onboarding.ts`).
 *
 * Progress is remembered per browser under
 * {@link ONBOARDING_STORAGE_KEY} so a reload — or coming back from ORCID —
 * does not restart the checklist. Everything in this module is plain
 * functions over injectable clients; the React wiring lives in
 * `use-onboarding.ts`.
 */

import { ApiError, apiClient, browserTokenStorage } from "../../lib/api";
import type { ApiClient, TokenStorage } from "../../lib/api";

import { isEd25519DidKey } from "./did-key";
import { toBase64Url, utf8Encode } from "./encoding";

/** The five steps, in the order the design fixes for them. */
export type OnboardingStepId = "passkey" | "profile" | "orcid" | "categories" | "guardians";

/** One entry of the onboarding checklist. */
export interface OnboardingStepInfo {
  /** Which step this is. */
  id: OnboardingStepId;
  /** Step title as shown on the page. */
  title: string;
  /** One line under the title saying what the step is for. */
  summary: string;
}

/** The `/onboarding` checklist, in order (design.md §6, plus the profile step). */
export const ONBOARDING_STEPS: readonly OnboardingStepInfo[] = [
  {
    id: "passkey",
    title: "Create your passkey",
    summary:
      "Your passkey unlocks the signing key that lives on this device. Scholium never sees your key.",
  },
  {
    id: "profile",
    title: "Add your name",
    summary:
      "Shown on the papers and reviews you post, so readers see you rather than a truncated ID.",
  },
  {
    id: "orcid",
    title: "Link your ORCID iD",
    summary:
      "Links your account to your ORCID iD, so readers know a real researcher stands behind your work.",
  },
  {
    id: "categories",
    title: "Pick categories to follow",
    summary:
      "New papers in the categories you pick fill your Following feed.",
  },
  {
    id: "guardians",
    title: "Set recovery guardians",
    summary:
      "Five people who can vouch for you and restore your account if this device is lost.",
  },
];

/** Browser-storage key for the persisted onboarding progress. */
export const ONBOARDING_STORAGE_KEY = "scholium.web-auth.onboarding";

/** Onboarding progress as remembered per browser. */
export interface PersistedOnboarding {
  /** UTC instant a profile with a display name was last observed or saved, if ever. */
  profileSavedAt: string | null;
  /** UTC instant the browser was first sent to ORCID, if ever. */
  orcidStartedAt: string | null;
  /** UTC instant a linked ORCID iD was last observed, if ever. */
  orcidLinkedAt: string | null;
  /** Why the last ORCID attempt failed, in plain language; `null` when none. */
  orcidError: string | null;
  /** Categories picked (and saved), in the order they were picked. */
  categories: string[];
  /** UTC instant guardians were saved from this browser, if ever. */
  guardiansSavedAt: string | null;
  /** The guardian list as last saved, in the order sent. */
  guardians: string[];
}

/** A fresh, nothing-done-yet progress record. */
export function emptyPersistedOnboarding(): PersistedOnboarding {
  return {
    profileSavedAt: null,
    orcidStartedAt: null,
    orcidLinkedAt: null,
    orcidError: null,
    categories: [],
    guardiansSavedAt: null,
    guardians: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((entry) => typeof entry === "string") ? [...value] : null;
}

/** Read the persisted progress; junk (or nothing) reads as nothing done. */
export function loadPersistedOnboarding(
  storage: TokenStorage = browserTokenStorage,
): PersistedOnboarding {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ONBOARDING_STORAGE_KEY);
  } catch {
    return emptyPersistedOnboarding();
  }
  if (!raw) {
    return emptyPersistedOnboarding();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPersistedOnboarding();
  }
  if (!isRecord(parsed)) {
    return emptyPersistedOnboarding();
  }
  const base = emptyPersistedOnboarding();
  const categories = stringArray(parsed.categories);
  const guardians = stringArray(parsed.guardians);
  return {
    profileSavedAt:
      typeof parsed.profileSavedAt === "string" ? parsed.profileSavedAt : null,
    orcidStartedAt: typeof parsed.orcidStartedAt === "string" ? parsed.orcidStartedAt : null,
    orcidLinkedAt: typeof parsed.orcidLinkedAt === "string" ? parsed.orcidLinkedAt : null,
    orcidError:
      typeof parsed.orcidError === "string" && parsed.orcidError.trim() !== ""
        ? parsed.orcidError
        : null,
    categories: categories ?? base.categories,
    guardians: guardians ?? base.guardians,
    guardiansSavedAt: typeof parsed.guardiansSavedAt === "string" ? parsed.guardiansSavedAt : null,
  };
}

/** Persist progress; storage that throws is ignored (the UI still works). */
export function savePersistedOnboarding(
  storage: TokenStorage,
  value: PersistedOnboarding,
): void {
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage only costs the checklist its memory across visits.
  }
}

/** Merge `patch` into the stored progress, persist it, and return the result. */
export function updatePersistedOnboarding(
  storage: TokenStorage,
  patch: Partial<PersistedOnboarding>,
): PersistedOnboarding {
  const next = { ...loadPersistedOnboarding(storage), ...patch };
  savePersistedOnboarding(storage, next);
  return next;
}

/** Which steps are complete given the stored progress and the passkey check. */
export function onboardingStepCompletion(
  persisted: PersistedOnboarding,
  passkeyReady: boolean,
): Record<OnboardingStepId, boolean> {
  return {
    passkey: passkeyReady,
    profile: persisted.profileSavedAt !== null,
    orcid: persisted.orcidLinkedAt !== null,
    categories: persisted.categories.length > 0,
    guardians: persisted.guardiansSavedAt !== null,
  };
}

/** How many of the four steps are complete. */
export function countCompletedSteps(
  completion: Record<OnboardingStepId, boolean>,
): number {
  return ONBOARDING_STEPS.reduce((total, step) => total + (completion[step.id] ? 1 : 0), 0);
}

/**
 * Stable failure codes for {@link OnboardingError}.
 *
 * - `invalid-response`: the API answered, but not with the shape this
 *   feature's contract promises.
 * - `invalid-category`: a category pick cannot be followed as written.
 */
export type OnboardingErrorCode = "invalid-response" | "invalid-category";

/** An onboarding action could not proceed (never a device-key or transport failure). */
export class OnboardingError extends Error {
  /** Stable code callers can branch on. */
  readonly code: OnboardingErrorCode;

  constructor(code: OnboardingErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Type guard for {@link OnboardingError}. */
export function isOnboardingError(error: unknown): error is OnboardingError {
  return error instanceof OnboardingError;
}

/** The slice of {@link ApiClient} the onboarding actions use. */
export type OnboardingClient = Pick<ApiClient, "get" | "put">;

// ---------------------------------------------------------------------------
// Link ORCID
// ---------------------------------------------------------------------------

/** Where `/v1/auth/orcid/start` sends the browser. */
export interface OrcidStartInfo {
  /** The ORCID authorize URL (state parameter included). */
  authorizeUrl: string;
  /** The signed state also embedded in the URL, when the server sent it. */
  state: string;
}

/** JSON members the start endpoint offers the URL under, in preference order. */
const ORCID_URL_FIELDS = ["authorize_url", "authorization_url", "url", "auth_url"] as const;

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Validate a `/v1/auth/orcid/start` body into an {@link OrcidStartInfo}. */
export function parseOrcidStart(payload: unknown): OrcidStartInfo {
  const url =
    isRecord(payload) &&
    ORCID_URL_FIELDS.map((field) => payload[field]).find(
      (value): value is string => typeof value === "string" && value !== "",
    );
  if (!url || !parseHttpUrl(url)) {
    throw new OnboardingError(
      "invalid-response",
      "The server did not return a usable ORCID sign-in URL",
    );
  }
  const state =
    isRecord(payload) && typeof payload.state === "string" && payload.state !== ""
      ? payload.state
      : "";
  return { authorizeUrl: url, state };
}

/**
 * Ask the API where to send the user to link their ORCID iD.
 *
 * The shared client attaches the access token when there is one, which binds
 * the caller's DID into the signed state that `POST /v1/auth/orcid/complete`
 * later checks against the signed-in user.
 */
export async function startOrcidLink(client: OnboardingClient = apiClient): Promise<OrcidStartInfo> {
  return parseOrcidStart(await client.get<unknown>("/auth/orcid/start"));
}

/** The slice of {@link ApiClient} the ORCID return page uses. */
export type OrcidCompleteClient = Pick<ApiClient, "post">;

/** What ORCID put on the redirect back to `/onboarding/orcid`. */
export type OrcidReturn =
  /** A `code` and the signed `state`: ready to be completed by the API. */
  | { kind: "ready"; code: string; state: string }
  /** The user declined at ORCID (`?error=access_denied`, …). */
  | { kind: "denied"; error: string; description: string }
  /** Neither: the page was opened without coming back from ORCID. */
  | { kind: "missing" };

/**
 * Read the `/onboarding/orcid` query string ORCID redirected to.
 *
 * Only `code` and `state` are used, and only to be handed to the API: the
 * page never decides whose account the link is for.
 */
export function parseOrcidReturn(search: string): OrcidReturn {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) {
    return { kind: "denied", error, description: params.get("error_description") ?? "" };
  }
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (code.trim() === "" || state.trim() === "") {
    return { kind: "missing" };
  }
  return { kind: "ready", code, state };
}

/** What a finished link reports back. */
export interface OrcidLinkResult {
  /** The ORCID iD the credential names, when the response carries it. */
  orcid: string | null;
}

function orcidFromCredential(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.credentialSubject)) {
    return null;
  }
  const orcid = payload.credentialSubject.orcid;
  return typeof orcid === "string" && orcid.trim() !== "" ? orcid : null;
}

/**
 * Finish linking: `POST /v1/auth/orcid/complete` with what ORCID returned.
 *
 * The shared client sends the signed-in user's bearer token, and the API
 * refuses (403 problem details) unless that user's DID is the one the signed
 * `state` was issued to — so the body carries no DID of its own. Failures are
 * thrown as the API's {@link ApiError} for the caller to describe (401 signed
 * out, 403 started by another account, 400 expired/used/invalid, 409 already
 * linked).
 */
export async function completeOrcidLink(
  client: OrcidCompleteClient = apiClient,
  input: { code: string; state: string } = { code: "", state: "" },
): Promise<OrcidLinkResult> {
  const credential = await client.post<unknown>("/auth/orcid/complete", {
    code: input.code,
    state: input.state,
  });
  return { orcid: orcidFromCredential(credential) };
}

/** JSON members a profile may carry the linked ORCID iD under. */
const ORCID_PROFILE_FIELDS = ["orcid", "orcid_id", "orcidId"] as const;

/** True when a profile payload shows a linked ORCID iD. */
export function profileShowsLinkedOrcid(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return ORCID_PROFILE_FIELDS.some(
    (field) => typeof payload[field] === "string" && (payload[field] as string).trim() !== "",
  );
}

/**
 * Best-effort check whether the account's ORCID iD is linked yet.
 *
 * The profile endpoint is *not* part of this feature's contract (it belongs
 * to the profiles plugin), so any failure simply means "cannot tell": the
 * step keeps showing "started" rather than failing the page.
 */
export async function checkOrcidLink(client: OnboardingClient, did: string): Promise<boolean> {
  try {
    return profileShowsLinkedOrcid(
      await client.get<unknown>(`/profiles/${encodeURIComponent(did)}`),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Add your name (the erasable profile, PRD ID-7)
// ---------------------------------------------------------------------------

/** The profile fields onboarding collects. */
export interface OnboardingProfile {
  /** The display name shown on papers and reviews. */
  name: string;
  /** The optional affiliation shown next to the name. */
  affiliation: string;
  /** The address `PUT /v1/profiles/{did}` requires (and emails a link to). */
  email: string;
}

/** Which profile input a problem belongs to; `null` for the form as a whole. */
export type ProfileField = keyof OnboardingProfile;

/** One thing wrong with the profile form, tied to an input when it can be. */
export interface ProfileProblem {
  /** The input the problem belongs to; `null` for the form as a whole. */
  field: ProfileField | null;
  /** One sentence the user can act on. */
  message: string;
}

/** The name/affiliation/email limits the API enforces. */
export const PROFILE_NAME_MAX = 200;
export const PROFILE_AFFILIATION_MAX = 300;
export const PROFILE_EMAIL_MAX = 254;

/** Deliberately pragmatic, mirroring the API: one `@`, no spaces, a dotted domain. */
const PROFILE_EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

/** A profile could not be saved; {@link problems} says why, per input. */
export class ProfileSaveError extends Error {
  /** Every fault found, client-side or reported by the API. */
  readonly problems: ProfileProblem[];

  constructor(problems: ProfileProblem[], message = "The profile is not valid yet.") {
    super(message);
    this.name = "ProfileSaveError";
    this.problems = problems;
  }
}

/** Type guard for {@link ProfileSaveError}. */
export function isProfileSaveError(error: unknown): error is ProfileSaveError {
  return error instanceof ProfileSaveError;
}

/**
 * Check a profile the way the API will, before anything is sent.
 *
 * `name` and `email` are required (the API stores and verifies the address);
 * `affiliation` may be empty, for independent researchers. Every fault is
 * reported, not just the first.
 */
export function validateProfile(draft: OnboardingProfile): ProfileProblem[] {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  const affiliation =
    typeof draft.affiliation === "string" ? draft.affiliation.trim() : "";
  const email = typeof draft.email === "string" ? draft.email.trim() : "";
  const problems: ProfileProblem[] = [];

  if (name === "") {
    problems.push({
      field: "name",
      message: "Enter the name you want readers to see.",
    });
  } else if (name.length > PROFILE_NAME_MAX) {
    problems.push({
      field: "name",
      message: `Keep your name under ${PROFILE_NAME_MAX} characters.`,
    });
  }

  if (affiliation.length > PROFILE_AFFILIATION_MAX) {
    problems.push({
      field: "affiliation",
      message: `Keep your affiliation under ${PROFILE_AFFILIATION_MAX} characters.`,
    });
  }

  if (email === "") {
    problems.push({
      field: "email",
      message: "Enter an email address so Scholium can verify your account.",
    });
  } else if (email.length > PROFILE_EMAIL_MAX || !PROFILE_EMAIL_PATTERN.test(email)) {
    problems.push({
      field: "email",
      message: "That does not look like an email address.",
    });
  }

  return problems;
}

/** A profile read from `GET /v1/profiles/{did}`, with what it says. */
export interface LoadedProfile {
  /** The public profile document, for checks beyond the parsed fields. */
  payload: unknown;
  /** The display name as stored (empty when there is none). */
  name: string;
  /** The affiliation as stored (empty when there is none). */
  affiliation: string;
  /** The address — only the owner's own read carries it. */
  email: string;
  /** True when the profile already names the member. */
  hasName: boolean;
}

function profileText(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the account's own profile (`GET /v1/profiles/{did}`).
 *
 * Best-effort: the profile route belongs to another plugin, so a node that
 * does not serve it (or any other failure) reads as "nothing known" and the
 * step simply starts blank rather than failing the page.
 */
export async function loadProfile(
  client: OnboardingClient,
  did: string,
): Promise<LoadedProfile | null> {
  try {
    const payload = await client.get<unknown>(`/profiles/${encodeURIComponent(did)}`);
    if (!isRecord(payload)) {
      return null;
    }
    const name = profileText(payload, "name");
    return {
      payload,
      name,
      affiliation: profileText(payload, "affiliation"),
      email: profileText(payload, "email"),
      hasName: name !== "",
    };
  } catch {
    return null;
  }
}

/** The profile input an API field error points at, if any. */
function profileFieldFromError(fieldError: {
  loc?: Array<string | number>;
  field?: string;
}): ProfileField | null {
  const candidates: string[] = [];
  if (Array.isArray(fieldError.loc)) {
    candidates.push(
      ...fieldError.loc.filter((part): part is string => typeof part === "string"),
    );
  }
  if (typeof fieldError.field === "string") {
    candidates.push(...fieldError.field.split("."));
  }
  for (const candidate of candidates) {
    if (candidate === "name" || candidate === "affiliation" || candidate === "email") {
      return candidate;
    }
  }
  return null;
}

/** Map a 422 problem document's `errors` onto profile inputs. */
export function profileProblemsFromApiError(error: ApiError): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  for (const fieldError of error.fieldErrors) {
    const message =
      fieldError.message ??
      (typeof fieldError.msg === "string" && fieldError.msg !== "" ? fieldError.msg : null) ??
      error.detail;
    if (message) {
      problems.push({ field: profileFieldFromError(fieldError), message });
    }
  }
  if (problems.length === 0) {
    problems.push({ field: null, message: error.detail });
  }
  return problems;
}

/**
 * Save the account's profile (`PUT /v1/profiles/{did}`, feature 28/ID-7).
 *
 * The PUT replaces the whole profile, so the email the API requires travels
 * with the name and affiliation. The list is validated locally first, and the
 * API's own 422 problem details are mapped back onto the inputs.
 *
 * @returns the profile as saved.
 */
export async function saveProfile(
  client: OnboardingClient,
  did: string,
  draft: OnboardingProfile,
): Promise<OnboardingProfile> {
  const trimmed: OnboardingProfile = {
    name: typeof draft.name === "string" ? draft.name.trim() : "",
    affiliation: typeof draft.affiliation === "string" ? draft.affiliation.trim() : "",
    email: typeof draft.email === "string" ? draft.email.trim() : "",
  };
  const localProblems = validateProfile(trimmed);
  if (localProblems.length > 0) {
    throw new ProfileSaveError(localProblems, "Check the highlighted fields.");
  }

  let payload: unknown;
  try {
    payload = await client.put<unknown>(`/profiles/${encodeURIComponent(did)}`, trimmed);
  } catch (error) {
    if (error instanceof ApiError && error.isValidationError) {
      throw new ProfileSaveError(
        profileProblemsFromApiError(error),
        "The server rejected this profile.",
      );
    }
    throw error;
  }

  // The response echoes what was stored; fall back to what was sent.
  if (isRecord(payload)) {
    return {
      name: profileText(payload, "name") || trimmed.name,
      affiliation: profileText(payload, "affiliation") || trimmed.affiliation,
      email: profileText(payload, "email") || trimmed.email,
    };
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Pick categories to follow
// ---------------------------------------------------------------------------

/** Categories offered before the user has any history to suggest from. */
export const ONBOARDING_CATEGORY_CHOICES: readonly string[] = [
  "cs.AI",
  "cs.CL",
  "cs.CR",
  "cs.LG",
  "cs.MA",
  "stat.ML",
];

/** An arXiv-style category identifier: lowercase archive `.` subject (`cs.AI`, `physics.soc-ph`). */
const CATEGORY_PATTERN = /^[a-z]+(?:-[a-z]+)*\.[A-Za-z][A-Za-z-]*$/;

/** Normalise a typed-in category, or `null` when it cannot be a category. */
export function normalizeCategory(input: string): string | null {
  const trimmed = input.trim();
  return CATEGORY_PATTERN.test(trimmed) ? trimmed : null;
}

/** What `followCategories` did with the picks. */
export interface FollowCategoriesResult {
  /** The categories as saved (trimmed, de-duplicated, in pick order). */
  categories: string[];
  /**
   * False when the follows endpoint is not available on this node yet; the
   * picks are kept on this device and complete the step regardless.
   */
  savedToAccount: boolean;
}

/** True when an error says the follows endpoint is not mounted (yet). */
export function followsEndpointUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

/**
 * Follow each picked category (`PUT /v1/me/follows/{category}`, feature 179).
 *
 * Following is not a dependency of onboarding, so a node without the follows
 * routes does not fail the step: the first "not available" answer stops the
 * sync and the picks are reported as saved locally. Any other failure
 * (expired session, network, server error) is thrown for the caller to show.
 */
export async function followCategories(
  client: OnboardingClient = apiClient,
  categories: readonly string[] = [],
): Promise<FollowCategoriesResult> {
  const list: string[] = [];
  for (const entry of categories) {
    const trimmed = typeof entry === "string" ? entry.trim() : "";
    if (trimmed !== "" && !list.includes(trimmed)) {
      list.push(trimmed);
    }
  }
  if (list.length === 0) {
    throw new OnboardingError("invalid-category", "Pick at least one category to follow.");
  }
  for (const category of list) {
    if (!normalizeCategory(category)) {
      throw new OnboardingError(
        "invalid-category",
        `“${category}” is not a category Scholium recognizes (try cs.AI).`,
      );
    }
  }

  let savedToAccount = true;
  for (const category of list) {
    try {
      await client.put(`/me/follows/${encodeURIComponent(category)}`);
    } catch (error) {
      if (followsEndpointUnavailable(error)) {
        savedToAccount = false;
        break;
      }
      throw error;
    }
  }
  return { categories: list, savedToAccount };
}

// ---------------------------------------------------------------------------
// Set recovery guardians
// ---------------------------------------------------------------------------

/** How many guardians an account names (mirrors the API). */
export const GUARDIAN_COUNT = 5;

/** Problem type the API returns when replacing a saved guardian set without a signature. */
export const UNSIGNED_GUARDIAN_CHANGE_TYPE = "urn:scholium:problem:unsigned-guardian-change";

/** True when `error` is the API refusing to replace a saved guardian set unsigned. */
export function isUnsignedGuardianChange(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.isForbidden &&
    (error.type === UNSIGNED_GUARDIAN_CHANGE_TYPE ||
      /requires a signature by the account's active key/i.test(error.detail))
  );
}

/** One thing wrong with a guardian list, tied to an input when it can be. */
export interface GuardianProblem {
  /** The guardian input (0-based) the problem belongs to; null for the list. */
  index: number | null;
  /** One sentence the user can act on. */
  message: string;
}

/**
 * Check a guardian list the way the API will, before anything is sent.
 *
 * Exactly {@link GUARDIAN_COUNT} entries, each a canonical Ed25519
 * `did:key`, none repeated, none the account itself. Every fault is
 * reported, not just the first, so the user fixes them in one pass.
 */
export function validateGuardians(
  ownerDid: string | null,
  values: readonly string[],
): GuardianProblem[] {
  const trimmed = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  const problems: GuardianProblem[] = [];
  if (trimmed.length !== GUARDIAN_COUNT) {
    problems.push({
      index: null,
      message: `Enter exactly ${GUARDIAN_COUNT} guardian DIDs — you have ${trimmed.length}.`,
    });
  }

  const firstSeen = new Map<string, number>();
  trimmed.forEach((value, index) => {
    if (value === "") {
      problems.push({
        index,
        message: "Enter your guardian's DID (it looks like did:key:z6Mk…).",
      });
      return;
    }
    if (!isEd25519DidKey(value)) {
      problems.push({
        index,
        message: "That is not a DID Scholium recognizes. It should start with did:key:z6Mk…",
      });
      return;
    }
    if (ownerDid !== null && value === ownerDid) {
      problems.push({
        index,
        message: "That is your own DID. Choose someone who could recover your account for you.",
      });
      return;
    }
    const repeats = firstSeen.get(value);
    if (repeats !== undefined) {
      problems.push({
        index,
        message: `This repeats guardian ${repeats + 1}. Each guardian must be someone different.`,
      });
      return;
    }
    firstSeen.set(value, index);
  });
  return problems;
}

/** A guardian list could not be saved; {@link problems} says why, per input. */
export class GuardianSaveError extends Error {
  /** Every fault found, client-side or reported by the API. */
  readonly problems: GuardianProblem[];

  constructor(problems: GuardianProblem[], message = "The guardian list is not valid yet.") {
    super(message);
    this.name = "GuardianSaveError";
    this.problems = problems;
  }
}

/** Type guard for {@link GuardianSaveError}. */
export function isGuardianSaveError(error: unknown): error is GuardianSaveError {
  return error instanceof GuardianSaveError;
}

/** The slice of the device key a guardian-change signature needs. */
export interface GuardianSigner {
  /** Prompt for the passkey, then sign `data` with the device key. */
  signWithPasskey(
    data: Uint8Array,
    options?: { reason?: string; timeoutMs?: number },
  ): Promise<Uint8Array>;
}

/** Passkey prompt reason shown when an existing guardian set is replaced. */
export const GUARDIANS_CHANGE_REASON = "Change your recovery guardians";

/**
 * The bytes a guardian-change signature is made over.
 *
 * Compact, key-sorted JSON binding the account DID and the ordered guardian
 * list — the canonical spelling of the API's `guardian_change_preimages`, so a
 * replacement signed here verifies there. A signature over these exact values
 * cannot authorize a different list, which is the point of requiring one.
 */
export function guardianChangeMessage(
  ownerDid: string,
  guardians: readonly string[],
): Uint8Array {
  return utf8Encode(JSON.stringify({ did: ownerDid, guardians: [...guardians] }));
}

/** How a guardian save proves it is the owner replacing a saved set. */
export interface SaveGuardiansOptions {
  /**
   * Sign the replacement with this device's key (a passkey prompt). Omit for
   * the first save, which the API accepts with the access token alone.
   */
  signer?: GuardianSigner;
  /** Passkey prompt reason; {@link GUARDIANS_CHANGE_REASON} by default. */
  reason?: string;
}

/** The guardian index a problem-details location points at, if any. */
function guardianIndexFromLocation(fieldError: {
  loc?: Array<string | number>;
  field?: string;
}): number | null {
  const loc = fieldError.loc;
  if (Array.isArray(loc)) {
    const at = loc.indexOf("guardians");
    for (let i = at >= 0 ? at + 1 : 0; i < loc.length; i += 1) {
      const part = loc[i];
      if (typeof part === "number") {
        return part;
      }
    }
  }
  if (typeof fieldError.field === "string") {
    const parts = fieldError.field.split(".");
    const at = parts.indexOf("guardians");
    for (let i = at >= 0 ? at + 1 : 0; i < parts.length; i += 1) {
      const asNumber = Number(parts[i]);
      if (Number.isInteger(asNumber)) {
        return asNumber;
      }
    }
  }
  return null;
}

/** Map a 422 problem document's `errors` onto guardian inputs. */
export function guardianProblemsFromApiError(error: ApiError): GuardianProblem[] {
  const problems: GuardianProblem[] = [];
  for (const fieldError of error.fieldErrors) {
    const message =
      fieldError.message ??
      (typeof fieldError.msg === "string" && fieldError.msg !== "" ? fieldError.msg : null) ??
      error.detail;
    if (message) {
      problems.push({ index: guardianIndexFromLocation(fieldError), message });
    }
  }
  if (problems.length === 0) {
    problems.push({ index: null, message: error.detail });
  }
  return problems;
}

/** Read the saved list out of a `PUT /v1/me/guardians` response. */
function guardiansFromResponse(payload: unknown, fallback: readonly string[]): string[] {
  return (isRecord(payload) && stringArray(payload.guardians)) || [...fallback];
}

/**
 * Save the account's five recovery guardians (`PUT /v1/me/guardians`,
 * feature 36).
 *
 * The list is validated locally first, so a mistake never leaves the
 * browser. The API's own 422 problem details (which report every fault at
 * once) are mapped onto the inputs the same way. Any other failure is
 * thrown as-is for the caller to describe.
 *
 * With a {@link SaveGuardiansOptions.signer} the save is a *replacement* and
 * is signed with this device's key over {@link guardianChangeMessage}, which
 * the API demands before it will redirect a saved set. Without one — the
 * first save, from onboarding — the list travels alone, exactly as before.
 *
 * @returns the guardians as saved, in the order sent.
 */
export async function saveGuardians(
  client: OnboardingClient = apiClient,
  ownerDid: string | null = null,
  values: readonly string[] = [],
  options: SaveGuardiansOptions = {},
): Promise<string[]> {
  const trimmed = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  const localProblems = validateGuardians(ownerDid, trimmed);
  if (localProblems.length > 0) {
    throw new GuardianSaveError(localProblems, "Check the highlighted guardians.");
  }

  const body: { guardians: string[]; signature?: string } = { guardians: trimmed };
  if (options.signer) {
    if (ownerDid === null) {
      // The signature binds the account DID; without it there is nothing the
      // API would accept, so refuse before prompting for a passkey.
      throw new GuardianSaveError(
        [{ index: null, message: "Sign in again to change your recovery guardians." }],
        "The account's DID is not known.",
      );
    }
    const signature = await options.signer.signWithPasskey(
      guardianChangeMessage(ownerDid, trimmed),
      { reason: options.reason ?? GUARDIANS_CHANGE_REASON },
    );
    body.signature = toBase64Url(signature);
  }

  let payload: unknown;
  try {
    payload = await client.put<unknown>("/me/guardians", body);
  } catch (error) {
    if (error instanceof ApiError && error.isValidationError) {
      throw new GuardianSaveError(
        guardianProblemsFromApiError(error),
        "The server rejected this guardian list.",
      );
    }
    throw error;
  }
  return guardiansFromResponse(payload, trimmed);
}
