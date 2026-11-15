/**
 * Inviting a reviewer from the paper page (spec feature 187; the API side is
 * feature 105).
 *
 * An author asks a verified reviewer to review the version on screen by
 * sending their DID to
 *
 * ```text
 * POST /v1/papers/{id}/review-invitations
 * {"reviewer": "did:key:z6Mk…", "version": "2"}
 * ```
 *
 * with the author's access token. The node saves the invitation (status
 * `pending`) and it shows up on the reviewer's dashboard under *Needs your
 * attention*. Unlike a review, a reply or a rating, an invitation is **not a
 * signed record**: it is an ordinary authenticated request, so there is no
 * passkey prompt.
 *
 * **The API is the gate.** It answers `403` to anyone who is not on the
 * paper's byline (a tier-4 member may also invite) and `403` to an invitee who
 * is not a tier-3 reviewer in the paper's category. This module only decides
 * whether to *offer* the action ({@link canInvite}) and catches the two
 * mistakes that need no node to see: a DID that is not a DID, and one of the
 * paper's own authors.
 *
 * Pure functions plus one injectable send, so the form and vitest drive the
 * whole flow without a network. No React.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import type { Viewer } from "../review-form/viewer";

/** The words on the action that opens the form (docs/design.md §5.2). */
export const INVITE_LABEL = "Invite reviewer";

/** The words on the button that sends the invitation. */
export const INVITE_SUBMIT_LABEL = "Send invitation";

/** Said at the end of every failure, so no one wonders whether it went through. */
export const NOT_INVITED = "No invitation was sent.";

/** `POST` path (relative to `/v1`) for a paper's invitations. */
export function invitationsPath(paperId: string): string {
  return `/papers/${encodeURIComponent(paperId)}/review-invitations`;
}

/** `POST` slice of the API client, so tests need no network stack. */
export type InviteClient = Pick<ApiClient, "post">;

/* -------------------------------------------------------------------------- */
/* Who is offered the action                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether to put the action in front of `viewer`: signed in, with a DID that is
 * on the paper's byline.
 *
 * A viewer whose token does not name a DID is not offered it, because the
 * byline cannot be matched; the API would decide, but the page cannot know it
 * is worth asking. Only a convenience: the node refuses anyone else.
 */
export function canInvite(
  viewer: Viewer,
  authorDids: readonly string[],
): boolean {
  return (
    viewer.signedIn && viewer.did !== null && authorDids.includes(viewer.did)
  );
}

/* -------------------------------------------------------------------------- */
/* The invitee                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A DID: `did:` + a method + an identifier, with no spaces. Only the shape is
 * checked (`did:key:…`, `did:web:…`); whether the DID belongs to a reviewer is
 * the node's answer.
 */
const DID_SHAPE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

/** What is wrong with the DID the author typed. */
export type InviteeProblem = "empty" | "not-a-did" | "is-author";

/** The sentence for each problem. */
export const INVITEE_PROBLEMS: Readonly<Record<InviteeProblem, string>> = {
  empty: "Enter the DID of the reviewer you want to invite.",
  "not-a-did":
    "That is not a DID. A reviewer’s DID starts with “did:”, for example did:key:z6Mk…",
  "is-author":
    "That DID is on this paper’s byline. Authors cannot review their own paper.",
};

/** The invitee, ready to send; or what is wrong with what was typed. */
export type InviteeCheck =
  | { readonly ok: true; readonly did: string }
  | {
      readonly ok: false;
      readonly problem: InviteeProblem;
      readonly message: string;
    };

function rejected(problem: InviteeProblem): InviteeCheck {
  return { ok: false, problem, message: INVITEE_PROBLEMS[problem] };
}

/**
 * Check the text of the DID field. Surrounding space is ignored (a DID pasted
 * from an address bar or a chat often carries some).
 *
 * @param authorDids the paper's authors: an author is not an invitee.
 */
export function checkInvitee(
  input: string,
  authorDids: readonly string[],
): InviteeCheck {
  const did = input.trim();
  if (did === "") return rejected("empty");
  if (!DID_SHAPE.test(did)) return rejected("not-a-did");
  if (authorDids.includes(did)) return rejected("is-author");
  return { ok: true, did };
}

/* -------------------------------------------------------------------------- */
/* The request and its answer                                                   */
/* -------------------------------------------------------------------------- */

/** What an invitation names. */
export interface InviteRequest {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** The version on screen: the one the reviewer is asked to review. */
  readonly version: number;
  /** The invitee's DID, already checked. */
  readonly reviewer: string;
}

/** The body of `POST /v1/papers/{id}/review-invitations`. */
export interface InviteBody {
  readonly reviewer: string;
  /**
   * The version number **as text**: the node reads a version hint only when it
   * is a string, and falls back to the newest version for anything else, which
   * would invite the reviewer to a version the author is not looking at.
   */
  readonly version: string;
}

export function inviteBody({ reviewer, version }: InviteRequest): InviteBody {
  return { reviewer, version: String(version) };
}

/** An invitation the node has saved. */
export interface Invitation {
  /** The invitation's id, when the node names it. */
  readonly id: string | null;
  /** The invitee's DID, as the node saved it. */
  readonly reviewer: string;
  /** `pending` until the reviewer acts on it. */
  readonly status: string;
}

/** Sends one invitation; {@link sendInvitation} by default. */
export type SendInvitation = (request: InviteRequest) => Promise<Invitation>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function first(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = text(raw[key]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Read the `201` body. Never throws: the node answered `201`, so the
 * invitation **was saved**, and a body this page cannot read must not turn that
 * into a failure. Whatever is missing falls back to what was asked for.
 */
export function parseInvitation(raw: unknown, requested: string): Invitation {
  const body =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    id: first(body, ["id", "invitation_id", "invitationId"]),
    reviewer:
      first(body, ["reviewer_did", "reviewerDid", "reviewer"]) ?? requested,
    status: first(body, ["status"]) ?? "pending",
  };
}

/** `POST` the invitation with the signed-in author's access token. */
export async function sendInvitation(
  request: InviteRequest,
  client: InviteClient = api,
): Promise<Invitation> {
  const raw = await client.post<unknown>(
    invitationsPath(request.paperId),
    inviteBody(request),
  );
  return parseInvitation(raw, request.reviewer);
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                     */
/* -------------------------------------------------------------------------- */

/** What the form shows when sending fails: a sentence and an optional sign-in. */
export interface InviteFailure {
  readonly message: string;
  /** Offer a "Sign in" link beside the message (the session has ended). */
  readonly signIn: boolean;
}

function failure(message: string, signIn = false): InviteFailure {
  return { message, signIn };
}

/** A sentence from the node's own words, ending in a full stop. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * One plain-language failure for whatever sending threw.
 *
 * A `403` is shown in the node's own words ("The invitee must be a tier-3
 * reviewer in the paper category."), because that is the one answer that
 * tells the author what to change.
 */
export function describeInviteError(error: unknown): InviteFailure {
  if (error instanceof ApiError) {
    // `error.detail` falls back to the status title ("Forbidden"), which says
    // nothing, so the problem document is read directly.
    const said = error.problem.detail;
    const detail = typeof said === "string" ? said.trim() : "";

    switch (error.status) {
      case 401:
        return failure(`Your session has ended. ${NOT_INVITED}`, true);
      case 403:
        return failure(
          `${sentence(
            detail ||
              "Only an author of this paper may invite a reviewer, and the reviewer must be a verified reviewer (tier 3) in the paper’s category",
          )} ${NOT_INVITED}`,
        );
      case 404:
        return failure(
          `This paper could not be found on this node. ${NOT_INVITED} Reload the page and try again.`,
        );
      case 422:
        return failure(
          `The node did not accept that reviewer. ${NOT_INVITED} Check the DID and try again.`,
        );
      default:
        if (error.status >= 500) {
          // A 5xx may or may not have saved the row; do not claim either.
          return failure(
            "Scholium could not save the invitation just now, so it is not confirmed as sent. Try again in a moment.",
          );
        }
        return failure(
          `${sentence(detail || error.title || "The node refused the invitation")} ${NOT_INVITED}`,
        );
    }
  }

  if (error instanceof NetworkError) {
    return failure(
      `Scholium could not reach the node. ${NOT_INVITED} Check your connection and try again.`,
    );
  }

  return failure(
    error instanceof Error && error.message
      ? `${sentence(error.message)} ${NOT_INVITED}`
      : `The invitation could not be sent. ${NOT_INVITED}`,
  );
}
