/**
 * The AI pre-review's two endpoints, called through the shared API client.
 *
 * * `GET  /v1/papers/{id}/ai-reviews` — the advisory report, findings grouped
 *   by agent (feature 122). Reading is anonymous, like reading a record, so
 *   the load does not attach a session.
 * * `POST /v1/ai-reviews/{cid}/rebuttal` — an author's answer to one finding
 *   (feature 123). Needs a signed-in author; the API decides who that is.
 * * `POST /v1/ai-reviews/{cid}/assessments` — a tier-3 reviewer marking a
 *   finding confirmed or wrong (feature 123).
 *
 * Who may write is the API's call, not the tab's: the tier is a claim inside
 * a short-lived access token, so a page that guessed it could keep a freshly
 * promoted reviewer out or let a stale one through. The tab sends the
 * request; the API's `401`/`403` and their plain-language details are what
 * the reader sees.
 */

import {
  ApiError,
  NetworkError,
  api,
  type ApiClient,
  type ApiRequestOptions,
} from "../../lib/api";

import {
  parseAiReport,
  type AiReport,
  type AiVerdict,
} from "./ai-report";

/** Anything shaped like the shared client's `get`/`post`. */
export type AiClient = Pick<ApiClient, "get" | "post">;

/** The report loader; replaceable in tests. */
export type LoadAiReport = (paperId: string) => Promise<AiReport>;

/** The rebuttal sender; replaceable in tests. */
export type SendRebuttal = (
  reviewCid: string,
  findingId: string,
  text: string,
) => Promise<void>;

/** The assessment sender; replaceable in tests. */
export type SendAssessment = (
  reviewCid: string,
  findingId: string,
  verdict: AiVerdict,
) => Promise<void>;

// --------------------------------------------------------------------------- //
// Reading the report
// --------------------------------------------------------------------------- //

/**
 * The path of a paper's report.
 *
 * `paperId` is any spelling the catalog accepts: a paper id
 * (`sch:k3f9-q2xz-7mwd`), a version id (`sch:k3f9-q2xz-7mwd/v2`) or a bare
 * short id. A version's report has its own route — `/v{n}` is one segment,
 * never a slash inside the id — so the canonical `/vN` suffix is split off
 * and only that spelling is; a `/` in any other position is left for the API
 * to answer.
 */
export function aiReviewsPath(paperId: string): string {
  const id = paperId.trim();
  const versionMatch = /^(.+?)\/v(\d+)$/.exec(id);
  if (versionMatch !== null) {
    return `/papers/${encodeURIComponent(versionMatch[1])}/v${versionMatch[2]}/ai-reviews`;
  }
  return `/papers/${encodeURIComponent(id)}/ai-reviews`;
}

/** Why the report cannot be shown. */
export type AiReportFailure =
  /** The paper is readable but has no advisory report (yet, or on this node). */
  | { readonly kind: "missing"; readonly message: string }
  /** The report could not be fetched; worth trying again. */
  | { readonly kind: "error"; readonly message: string };

/** The calm state for a paper with no report: a state, not an error (§1). */
export const NO_AI_REVIEW_YET: AiReportFailure = {
  kind: "missing",
  message: "This paper has no AI pre-review yet.",
};

/** Sort a failed load into what the tab should say. */
export function classifyAiReportError(error: unknown): AiReportFailure {
  if (error instanceof ApiError) {
    if (error.isNotFound) {
      // The API distinguishes "no such paper here" from "no review yet"; the
      // reader's next step is the same either way, so both say the calm thing.
      return NO_AI_REVIEW_YET;
    }
    return {
      kind: "error",
      message: error.detail || "The AI pre-review could not be read.",
    };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message: "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  return { kind: "error", message: "The AI pre-review could not be read." };
}

/** Options for {@link loadAiReport}. */
export interface LoadAiReportOptions {
  /** The client to call through; defaults to the shared one. */
  client?: AiClient;
  /** Extra request options (tests pin a `signal`). */
  options?: ApiRequestOptions;
}

/**
 * Fetch and parse a paper's advisory report.
 *
 * Resolves for any payload shape (see `parseAiReport`) and rejects only for
 * transport and HTTP failures, already sorted by
 * {@link classifyAiReportError}.
 */
export async function loadAiReport(
  paperId: string,
  { client = api, options }: LoadAiReportOptions = {},
): Promise<AiReport> {
  const payload = await client.get<unknown>(aiReviewsPath(paperId), {
    // Reading a record is anonymous; a stale session token must not be able
    // to hide a public report behind a 401.
    auth: false,
    cache: "no-store",
    ...options,
  });
  return parseAiReport(payload);
}

// --------------------------------------------------------------------------- //
// Answering a finding
// --------------------------------------------------------------------------- //

/** What a rebuttal or assessment is posted against. */
export interface AiActionTarget {
  /** The `ai.review` record's cid — the report's `reviewCid`. */
  readonly reviewCid: string;
  /** The finding's id, as the report spells it. */
  readonly findingId: string;
}

/** Why an answer was not accepted. */
export type AiActionFailure =
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

/** The reader's own words for the API's `401`s. */
export const SIGNED_OUT_TO_ANSWER: AiActionFailure = {
  kind: "signed-out",
  message: "Sign in as an author or a verified reviewer to answer a finding.",
};

/** Sort a refused answer into what the finding should say. */
export function classifyAiActionError(error: unknown): AiActionFailure {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return {
        kind: "signed-out",
        message: "Your session has ended. Sign in again to answer a finding.",
      };
    }
    if (error.isForbidden) {
      // The API already says it plainly ("Only a paper author may rebut an
      // AI finding."); its words are the rule, so repeat them verbatim.
      return { kind: "forbidden", message: error.detail };
    }
    if (error.isValidationError) {
      return { kind: "invalid", message: error.detail };
    }
    return { kind: "error", message: error.detail || "That answer was not sent." };
  }
  if (error instanceof NetworkError) {
    return {
      kind: "error",
      message: "Scholium could not reach the API. Check your connection and try again.",
    };
  }
  return { kind: "error", message: "That answer was not sent." };
}

/**
 * Post an author's rebuttal of one finding (`201` resolves; anything else
 * rejects as an `ApiError` for {@link classifyAiActionError}).
 */
export async function postRebuttal(
  target: AiActionTarget,
  text: string,
  client: AiClient = api,
): Promise<void> {
  await client.post(
    `/ai-reviews/${encodeURIComponent(target.reviewCid)}/rebuttal`,
    { finding_id: target.findingId, text },
  );
}

/**
 * Post a reviewer's verdict on one finding: `"confirmed"` or `"wrong"`.
 */
export async function postAssessment(
  target: AiActionTarget,
  verdict: AiVerdict,
  client: AiClient = api,
): Promise<void> {
  await client.post(
    `/ai-reviews/${encodeURIComponent(target.reviewCid)}/assessments`,
    { finding_id: target.findingId, verdict },
  );
}
