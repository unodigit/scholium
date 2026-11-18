/**
 * The data behind the Discussion tab (docs/design.md §5.2, §11).
 *
 * Four calls, all through the shared API client:
 *
 * - `GET  /v1/papers/{id}/threads` (feature 99) — the paper's threads, each
 *   with nested replies. Public to read.
 * - `POST /v1/papers/{id}/threads` (feature 100) — a signed `discussion.post`.
 *   A new thread has `parent: null`; a reply names its parent's id. Needs
 *   tier 1 (Member).
 * - `POST /v1/posts/{cid}/helpful` (feature 101) — one helpful mark per
 *   member (`201`, a repeat is `409`). It only reorders; it never touches a
 *   paper's status.
 * - `POST /v1/flags` (feature 77) — report a post: `{ target, reason }`.
 *
 * Order is part of the contract: **most helpful first, then oldest first**,
 * with the node's arrival order breaking ties — the same key the API sorts by.
 * The tab sorts again itself ({@link orderThreads}) so a node, a stale
 * `initial` or an optimistic update can never leave the list out of order.
 *
 * Everything a node sends is checked before it is shown. A body that is not a
 * thread list at all is an **error** ("we don't know"), never an empty tab
 * ("nobody has posted"); one unreadable post is dropped, so a single bad row
 * cannot take the tab down.
 *
 * Pure data and functions (plus the injectable actions), no React, so the
 * server route, the client components and vitest share one path. The two
 * web-auth imports are the plain-code modules, not the `../web-auth` index, so
 * this file stays loadable on the server.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { isDeviceKeyError, isPasskeyCancellation, isRecordSigningError } from "../web-auth/errors";
import { signRecord, type SignedRecord } from "../web-auth/sign-record";

/* -------------------------------------------------------------------------- */
/* Wire shape                                                                  */
/* -------------------------------------------------------------------------- */

/** The record type a thread post or reply signs. */
export const DISCUSSION_RECORD_TYPE = "discussion.post";

/** Problem type the API answers with when a member marks their own post helpful. */
export const SELF_HELPFUL_TYPE = "urn:scholium:problem:self-helpful";

/** The longest post the tab will sign, in characters. */
export const POST_TEXT_MAX = 4000;

/** Replies nested deeper than this are not read (a bound, not a design limit). */
const MAX_DEPTH = 64;

/** One post: a thread's first post, a reply, or a paragraph annotation. */
export interface DiscussionPost {
  /** Id of the signed `discussion.post` record. */
  readonly cid: string;
  /** `did:key` of the author. */
  readonly author: string;
  /** The author's public profile name, when the node has one; else `null`. */
  readonly authorName: string | null;
  /** The post text; `null` when the node holds it separately (`textCid`). */
  readonly text: string | null;
  /** When the author signed it (ISO 8601, UTC); `null` when not stamped. */
  readonly createdAt: string | null;
  /** Members who marked it helpful. Only orders the thread. */
  readonly helpful: number;
  /** Id of the post replied to, or `null` for the first post of a thread. */
  readonly parent: string | null;
  /** The record the post is about: a version of the paper, or its genesis. */
  readonly target: string | null;
  /** The quoted passage of an annotation (feature 150), else `null`. */
  readonly quote: string | null;
  /** The node's arrival order, used only to break ties. `null` when unknown. */
  readonly seq: number | null;
  /**
   * True when a moderator hid the post: `text` is withheld and the card shows
   * a "Hidden by moderation" placeholder in its place.
   */
  readonly hidden?: boolean;
  /** The moderator's reason for hiding it, when the node serves one. */
  readonly hiddenReason?: string | null;
  /** When the hide decision was signed (ISO 8601), when the node serves it. */
  readonly hiddenAt?: string | null;
  /** cid of the moderation decision that hid the post, when the node serves one. */
  readonly decisionCid?: string | null;
  readonly replies: readonly DiscussionPost[];
}

/** One paper's discussion. */
export interface DiscussionData {
  /** Canonical paper id (`sch:xxxx-xxxx-xxxx`), when the node says it. */
  readonly paper: string;
  /** Id of the paper's genesis record, when the node says it. */
  readonly paperCid: string | null;
  /** Roots only; replies nest inside. In whatever order was received. */
  readonly threads: readonly DiscussionPost[];
}

/**
 * The server answered, but not with something this tab can show. The message
 * is shown to the reader as is, so write it for them.
 */
export class DiscussionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscussionResponseError";
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

/** The first non-empty string among `keys` (the API spells every field twice or more). */
function pickText(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const text = readText(record[key]);
    if (text !== null) return text;
  }
  return null;
}

function pickInteger(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
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

/** The passage an annotation quotes: `anchor.quote`, when the anchor is an object. */
function readQuote(anchor: unknown): string | null {
  return isRecord(anchor) ? readText(anchor.quote) : null;
}

function readPost(raw: unknown, depth: number, seen: Set<string>): DiscussionPost | null {
  if (!isRecord(raw) || depth > MAX_DEPTH) return null;
  const cid = pickText(raw, "post_cid", "postCid", "cid", "id");
  // Without an id a post cannot be voted on, reported or replied to.
  if (cid === null || seen.has(cid)) return null;
  seen.add(cid);

  // Text is shown as written. Only an all-blank string counts as "no text".
  const text =
    typeof raw.text === "string" && raw.text.trim() !== "" ? raw.text.replace(/\s+$/, "") : null;

  const rawReplies = Array.isArray(raw.replies) ? raw.replies : [];
  const replies: DiscussionPost[] = [];
  for (const item of rawReplies) {
    const reply = readPost(item, depth + 1, seen);
    if (reply !== null) replies.push(reply);
  }

  return {
    cid,
    author: pickText(raw, "author", "author_did", "authorDid") ?? "",
    authorName: pickText(raw, "author_name", "authorName"),
    text,
    createdAt: pickTimestamp(raw, "created", "createdAt", "created_at"),
    helpful: Math.max(0, pickInteger(raw, "helpful") ?? 0),
    parent: pickText(raw, "parent_cid", "parentCid", "parent"),
    target: pickText(raw, "target"),
    quote: readQuote(raw.anchor),
    seq: pickInteger(raw, "seq"),
    // A moderator's hide is a placeholder: the body is withheld even if a node
    // mistakenly sends one, and the reason is the card's whole message.
    hidden: raw.hidden === true || pickTimestamp(raw, "hidden_at", "hiddenAt") !== null,
    hiddenReason: pickText(raw, "hidden_reason", "hiddenReason", "reason"),
    hiddenAt: pickTimestamp(raw, "hidden_at", "hiddenAt"),
    decisionCid: pickText(raw, "decision_cid", "decisionCid"),
    replies,
  };
}

/**
 * Read `GET /v1/papers/{id}/threads`.
 *
 * @throws {DiscussionResponseError} the body is not a thread list.
 */
export function parseThreads(payload: unknown): DiscussionData {
  if (!isRecord(payload) || !Array.isArray(payload.threads)) {
    throw new DiscussionResponseError(
      "The server's answer was not a list of threads, so the discussion cannot be shown. Try again.",
    );
  }
  const seen = new Set<string>();
  const threads: DiscussionPost[] = [];
  for (const item of payload.threads) {
    const post = readPost(item, 0, seen);
    if (post !== null) threads.push(post);
  }
  return {
    paper: pickText(payload, "paper", "shortId", "short_id") ?? "",
    paperCid: pickText(payload, "paper_cid", "paperCid"),
    threads,
  };
}

/* -------------------------------------------------------------------------- */
/* Order and the tree                                                          */
/* -------------------------------------------------------------------------- */

function timeOf(post: DiscussionPost): number {
  // No timestamp sorts first, as the API does for a row with none.
  return post.createdAt === null ? Number.NEGATIVE_INFINITY : Date.parse(post.createdAt);
}

/**
 * Most helpful first, then oldest first, then the node's arrival order.
 *
 * A post with no arrival order (one this browser just signed) sorts after
 * every post that has one at the same time, which is where it will land once
 * the node numbers it.
 */
export function comparePosts(a: DiscussionPost, b: DiscussionPost): number {
  if (a.helpful !== b.helpful) return b.helpful - a.helpful;
  const at = timeOf(a);
  const bt = timeOf(b);
  if (at !== bt) return at < bt ? -1 : 1;
  const aSeq = a.seq ?? Number.POSITIVE_INFINITY;
  const bSeq = b.seq ?? Number.POSITIVE_INFINITY;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/** `posts` and every level of replies under them, in thread order. Pure. */
export function orderThreads(posts: readonly DiscussionPost[]): DiscussionPost[] {
  return [...posts]
    .sort(comparePosts)
    .map((post) => (post.replies.length === 0 ? post : { ...post, replies: orderThreads(post.replies) }));
}

/** How many posts there are, replies included; a hidden placeholder is not one. */
export function countPosts(posts: readonly DiscussionPost[]): number {
  let total = 0;
  for (const post of posts) {
    total += (post.hidden === true ? 0 : 1) + countPosts(post.replies);
  }
  return total;
}

/** How many hidden placeholders are listed, replies included. Pure. */
export function countHiddenPosts(posts: readonly DiscussionPost[]): number {
  let total = 0;
  for (const post of posts) {
    total += (post.hidden === true ? 1 : 0) + countHiddenPosts(post.replies);
  }
  return total;
}

/** The post with this id, anywhere in the tree. */
export function findPost(
  posts: readonly DiscussionPost[],
  cid: string,
): DiscussionPost | null {
  for (const post of posts) {
    if (post.cid === cid) return post;
    const inside = findPost(post.replies, cid);
    if (inside !== null) return inside;
  }
  return null;
}

function mapPost(
  posts: readonly DiscussionPost[],
  cid: string,
  change: (post: DiscussionPost) => DiscussionPost,
): readonly DiscussionPost[] {
  let changed = false;
  const next = posts.map((post) => {
    if (post.cid === cid) {
      changed = true;
      return change(post);
    }
    const replies = mapPost(post.replies, cid, change);
    if (replies === post.replies) return post;
    changed = true;
    return { ...post, replies };
  });
  return changed ? next : posts;
}

/**
 * Add a post this browser just signed.
 *
 * A reply goes under its parent. If the parent is not in the tree it goes at
 * the root, as the API does, so a post is never lost to a missing parent. A
 * post already present (same id) is left alone, so a repeat cannot double it.
 */
export function addPost(data: DiscussionData, post: DiscussionPost): DiscussionData {
  if (findPost(data.threads, post.cid) !== null) return data;
  if (post.parent !== null && findPost(data.threads, post.parent) !== null) {
    const parent = post.parent;
    return {
      ...data,
      threads: mapPost(data.threads, parent, (target) => ({
        ...target,
        replies: [...target.replies, post],
      })),
    };
  }
  return { ...data, threads: [...data.threads, post] };
}

/** Set one post's helpful count. */
export function withHelpful(data: DiscussionData, cid: string, helpful: number): DiscussionData {
  const threads = mapPost(data.threads, cid, (post) => ({
    ...post,
    helpful: Math.max(0, helpful),
  }));
  return threads === data.threads ? data : { ...data, threads };
}

/* -------------------------------------------------------------------------- */
/* Reading the thread list                                                     */
/* -------------------------------------------------------------------------- */

/** The thread list's path under `/v1`; the API client adds the prefix. */
export function threadsEndpoint(paperId: string): string {
  return `/papers/${encodeURIComponent(paperId.trim())}/threads`;
}

/** A post's helpful-mark path under `/v1`. */
export function helpfulEndpoint(cid: string): string {
  return `/posts/${encodeURIComponent(cid)}/helpful`;
}

/** Where reports go, under `/v1`. */
export const FLAGS_ENDPOINT = "/flags";

/** The slice of the API client the tab's reads and actions use. */
export type DiscussionClient = Pick<ApiClient, "get" | "post">;

/** Loads a paper's threads. Rejects with a reason {@link describeLoadError} can say. */
export type LoadThreads = (paperId: string, signal?: AbortSignal) => Promise<DiscussionData>;

/**
 * Read one paper's threads through the shared API client.
 *
 * A public read, but the client still attaches a stored token: the API uses
 * it, when it is valid, to leave out posts by members the reader has muted.
 */
export async function loadThreads(
  paperId: string,
  signal?: AbortSignal,
  client: DiscussionClient = api,
): Promise<DiscussionData> {
  const payload = await client.get<unknown>(threadsEndpoint(paperId), {
    cache: "no-store",
    signal,
  });
  return parseThreads(payload);
}

/** A reader-facing sentence for why the threads could not be loaded. */
export function describeLoadError(error: unknown): string {
  if (error instanceof DiscussionResponseError) return error.message;
  if (error instanceof NetworkError) {
    return "Couldn’t reach the server. Check your connection and try again.";
  }
  if (error instanceof ApiError) {
    if (error.isNotFound) return "This server has no discussion for that paper. Check the id.";
    if (error.status === 429) return "Too many requests just now. Wait a moment and try again.";
    return error.detail || error.title || "The server could not answer. Try again.";
  }
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "The discussion could not be loaded. Try again.";
}

/* -------------------------------------------------------------------------- */
/* Writing a post                                                              */
/* -------------------------------------------------------------------------- */

/** Why `text` cannot be posted, in words, or `null` when it can. */
export function postTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Write something before you post.";
  if (trimmed.length > POST_TEXT_MAX) {
    const over = trimmed.length - POST_TEXT_MAX;
    return `This post is ${over.toLocaleString("en-GB")} ${over === 1 ? "character" : "characters"} over the ${POST_TEXT_MAX.toLocaleString("en-GB")} limit.`;
  }
  return null;
}

/**
 * The body of a `discussion.post`. `anchor` is the target itself: a post that
 * is about the whole paper rather than a paragraph (the schema's plain-id form).
 */
export function postBody(options: {
  text: string;
  target: string;
  parent: string | null;
}): Record<string, unknown> {
  return {
    target: options.target,
    anchor: options.target,
    text: options.text.trim(),
    parent: options.parent,
  };
}

/** Signs a record behind a passkey prompt; `signRecord` from web-auth by default. */
export type SignPostRecord = (
  type: string,
  body: Record<string, unknown>,
  prev: string | null,
) => Promise<SignedRecord>;

/** What `POST /v1/papers/{id}/threads` answers. */
export interface PostAccepted {
  post_cid?: string;
  postCid?: string;
  cid?: string;
  id?: string;
  author_name?: string;
  authorName?: string;
}

/** Submits a signed post; `POST /v1/papers/{id}/threads` by default. */
export type SubmitPostRecord = (paperId: string, record: SignedRecord) => Promise<PostAccepted>;

const defaultSubmitPost: SubmitPostRecord = (paperId, record) =>
  api.post<PostAccepted>(threadsEndpoint(paperId), record);

/** Nothing was sent: the post as asked for cannot be signed. */
export class PostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostInputError";
  }
}

/** The signer came back with a record that is not the post this tab asked for. */
export class WrongPostRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongPostRecordError";
  }
}

export interface SubmitPostOptions {
  paperId: string;
  text: string;
  /** The record the post is about: a version of the paper, or its genesis. */
  target: string | null;
  /** The post replied to, or `null` to start a thread. */
  parent: string | null;
  sign?: SignPostRecord;
  submit?: SubmitPostRecord;
}

/**
 * Signs a `discussion.post` on this device and submits it.
 *
 * A post starts its own record chain (`prev` is `null`). The signed record is
 * checked before anything is sent, so a broken signer fails here rather than
 * posting something the reader never wrote.
 *
 * @returns the post, ready to show: its id, author and time are the signed
 *   record's, and it has no replies and no helpful marks yet.
 * @throws {PostInputError} empty or over-long text, or no target; nothing is
 *   signed and no prompt is shown.
 * @throws {WrongPostRecordError} the signed record is not the post asked for.
 */
export async function submitPost({
  paperId,
  text,
  target,
  parent,
  sign = signRecord,
  submit = defaultSubmitPost,
}: SubmitPostOptions): Promise<DiscussionPost> {
  const problem = postTextProblem(text);
  if (problem !== null) throw new PostInputError(problem);
  if (target === null || target.trim() === "") {
    throw new PostInputError("This server did not say which paper record to attach the post to.");
  }

  const body = postBody({ text, target, parent });
  const signed = await sign(DISCUSSION_RECORD_TYPE, body, null);
  if (signed.type !== DISCUSSION_RECORD_TYPE) {
    throw new WrongPostRecordError(
      `The signer produced a ${signed.type} record, not a ${DISCUSSION_RECORD_TYPE}.`,
    );
  }
  if (signed.prev !== null) {
    throw new WrongPostRecordError("The signer produced a post that is chained to another record.");
  }

  const accepted = await submit(paperId, signed);
  const cid =
    readText(accepted?.post_cid) ??
    readText(accepted?.postCid) ??
    readText(accepted?.cid) ??
    readText(accepted?.id) ??
    signed.id;

  return {
    cid,
    author: signed.author,
    authorName: readText(accepted?.author_name) ?? readText(accepted?.authorName),
    text: String(body.text),
    createdAt: signed.created,
    helpful: 0,
    parent,
    target,
    quote: null,
    seq: null,
    replies: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Helpful and Report                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Marks a post helpful. Resolves to the new count when the server says it,
 * else `null`. Rejects with an `ApiError` (`409` when already marked).
 */
export type MarkHelpful = (cid: string) => Promise<number | null>;

export async function markPostHelpful(
  cid: string,
  client: DiscussionClient = api,
): Promise<number | null> {
  const body = await client.post<unknown>(helpfulEndpoint(cid));
  if (!isRecord(body)) return null;
  const helpful = pickInteger(body, "helpful");
  return helpful === null ? null : Math.max(0, helpful);
}

/** One reason a member can give for reporting something. */
export interface ReportReasonOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

/** The reasons offered for a discussion post, reply or annotation. */
export const REPORT_REASONS = [
  { id: "spam", label: "Spam or advertising", hint: "Promotion with no link to this paper." },
  { id: "abuse", label: "Harassment or abuse", hint: "Aimed at a person, not at the work." },
  { id: "off-topic", label: "Off topic", hint: "Not about this paper." },
  { id: "misleading", label: "Misleading or false", hint: "Claims that are untrue." },
  { id: "legal", label: "Legal problem", hint: "Private information, defamation or copyright." },
  { id: "other", label: "Something else", hint: "A moderator will read it." },
] as const;

/**
 * The reasons offered for a paper: the kinds of problem a *work* can have,
 * not the ones a post can.  A paper report is about the research record.
 */
export const PAPER_REPORT_REASONS = [
  { id: "misconduct", label: "Research misconduct", hint: "Fabricated or falsified results." },
  { id: "plagiarism", label: "Plagiarism", hint: "Text or ideas taken without credit." },
  { id: "duplicated-figures", label: "Duplicated figures", hint: "A figure reused as if it were new." },
  { id: "spam", label: "Spam or advertising", hint: "Not a research paper." },
  { id: "off-topic", label: "Off topic", hint: "Not a fit for this venue." },
  { id: "other", label: "Something else", hint: "A moderator will read it." },
] as const;

export type ReportReason =
  | (typeof REPORT_REASONS)[number]["id"]
  | (typeof PAPER_REPORT_REASONS)[number]["id"];

/** The reason with this id, or `null`. */
export function reportReason(
  id: string,
): (typeof REPORT_REASONS)[number] | (typeof PAPER_REPORT_REASONS)[number] | null {
  return (
    REPORT_REASONS.find((reason) => reason.id === id) ??
    PAPER_REPORT_REASONS.find((reason) => reason.id === id) ??
    null
  );
}

/** What a filed report answers. */
export interface ReportReceipt {
  /** The flag's id, when the server says it. */
  readonly flagId: string | null;
}

/** Reports a post. Rejects with an `ApiError`. */
export type ReportPost = (cid: string, reason: ReportReason) => Promise<ReportReceipt>;

export async function reportPostFlag(
  cid: string,
  reason: ReportReason,
  client: DiscussionClient = api,
): Promise<ReportReceipt> {
  const body = await client.post<unknown>(FLAGS_ENDPOINT, { target: cid, reason });
  return { flagId: isRecord(body) ? pickText(body, "id", "flag_id", "flagId") : null };
}

/* -------------------------------------------------------------------------- */
/* Failures, in words                                                          */
/* -------------------------------------------------------------------------- */

export type DiscussionAction = "post" | "helpful" | "report" | "appeal";

/** What went wrong with an action, in words, and what the reader can do about it. */
export interface ActionFailure {
  readonly message: string;
  /** The session is the problem; offer to sign in. */
  readonly signIn: boolean;
  /** The server already has this (a repeated helpful mark): not an error to retry. */
  readonly alreadyDone: boolean;
}

function failure(message: string, extra: Partial<Omit<ActionFailure, "message">> = {}): ActionFailure {
  return { message, signIn: false, alreadyDone: false, ...extra };
}

/** `30 seconds`, `1 minute`, `2 minutes`: the wait a rate limit asks for. */
export function describeWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${whole} ${whole === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(whole / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * Say why a post, a helpful mark or a report did not go through.
 *
 * Every message says whether anything was sent, so a reader is never left
 * wondering whether to try again or whether they just posted twice.
 */
export function describeActionError(error: unknown, action: DiscussionAction): ActionFailure {
  const sent = action === "post" ? "Nothing was sent." : "Nothing was changed.";

  if (isPasskeyCancellation(error)) {
    return failure("Signing was cancelled, so nothing was sent. Sign again when you are ready.");
  }
  if (error instanceof PostInputError) return failure(error.message);
  if (error instanceof WrongPostRecordError) return failure(`${error.message} Nothing was sent.`);
  if (isDeviceKeyError(error)) {
    return failure(
      error.code === "not-found"
        ? "This device has no signing key, so it cannot sign for you."
        : error.code === "passkey-failed"
          ? "The passkey could not be confirmed. Nothing was sent. Try again."
          : "Could not sign with this device’s key. Nothing was sent.",
    );
  }
  if (isRecordSigningError(error)) {
    return failure("Could not prepare the post. Nothing was sent.");
  }
  if (error instanceof ApiError) {
    if (error.status === 401) {
      // The Sign in link follows this sentence, so the sentence says what
      // happened rather than repeating the instruction.
      return failure(`Your session has ended. ${sent}`, { signIn: true });
    }
    if (error.status === 403) {
      return failure(
        action === "report"
          ? `The server would not take this report. ${sent}`
          : `Your account is not yet at the trust level that can join discussions (tier 1). ${sent}`,
      );
    }
    if (error.status === 404 && action === "helpful") {
      return failure("That post is no longer listed, so it could not be marked. Reload the tab.");
    }
    if (error.status === 409 && action === "helpful") {
      if (error.type === SELF_HELPFUL_TYPE) {
        return failure("You cannot mark your own post helpful.");
      }
      return failure("You have already marked this post helpful.", { alreadyDone: true });
    }
    if (error.status === 422) {
      return failure(`The server did not accept it: ${error.detail} ${sent}`);
    }
    if (error.status === 429) {
      const wait =
        error.retryAfter !== undefined ? ` Try again in ${describeWait(error.retryAfter)}.` : " Try again in a moment.";
      return failure(`You are going too fast.${wait} ${sent}`);
    }
    return failure(
      action === "post"
        ? "The server could not take the post just now. Try again in a moment."
        : action === "helpful"
          ? "The server could not record that just now. Try again in a moment."
          : "The server could not take the report just now. Try again in a moment.",
    );
  }
  if (error instanceof NetworkError) {
    return failure(
      "Could not reach the server, so nothing was confirmed. Check your connection and try again.",
    );
  }
  return failure(
    action === "post"
      ? "Something went wrong, and the post was not sent. Try again."
      : "Something went wrong. Try again.",
  );
}

/* -------------------------------------------------------------------------- */
/* Words and formats                                                           */
/* -------------------------------------------------------------------------- */

/** `1 Feb 2026`, in UTC and the same words in every locale. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** `1 Feb 2026 04:00 UTC`, for the hover title and the machine-readable time. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `${formatDate(iso)} ${time} UTC`;
}

/** `did:key:z6MkhaXg…2doK`: enough to recognise an author without a 50-character line. */
export function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 16)}…${did.slice(-6)}`;
}

/** What to call an author: their shortened id, or an honest "Unknown author". */
export function authorLabel(did: string): string {
  return did.trim() === "" ? "Unknown author" : shortDid(did);
}

/**
 * What to call a post's author: their public profile name when the node has
 * one, and the short DID otherwise (never saved, erased, or unreadable).
 */
export function postAuthorLabel(post: Pick<DiscussionPost, "author" | "authorName">): string {
  const name = post.authorName?.trim();
  return name !== undefined && name !== "" ? name : authorLabel(post.author);
}

/** Where a member's public profile lives: `/u/{did}`. */
export function profilePath(did: string): string {
  return `/u/${encodeURIComponent(did)}`;
}

/** `No helpful marks yet`, `1 member found this helpful`, `3 members found this helpful`. */
export function helpfulLabel(count: number): string {
  if (count <= 0) return "No helpful marks yet";
  return `${count} ${count === 1 ? "member" : "members"} found this helpful`;
}

/**
 * `1 post`, `3 posts`; replies count. A hidden placeholder is listed but is not
 * a post, so when there are any the label says so: `1 post, 1 hidden`.
 */
export function postCountLabel(count: number, hidden = 0): string {
  const posts = `${count} ${count === 1 ? "post" : "posts"}`;
  return hidden > 0 ? `${posts}, ${hidden} hidden` : posts;
}

/**
 * What an author reads where their own post was hidden:
 * `Your post was hidden: <reason>.` The reason is the moderator's own sentence
 * and often ends in punctuation already, so the full stop is added only when it
 * is missing (a closing quote or bracket after the punctuation still counts).
 */
export function hiddenOwnNotice(reason: string | null | undefined): string {
  const said = reason?.trim() ?? "";
  if (said === "") return "Your post was hidden.";
  const ended = /[.!?…]["'”’)\]]*$/.test(said);
  return `Your post was hidden: ${ended ? said : `${said}.`}`;
}

/** The paper page: `/p/6sel-2dio-orm6` (docs/design.md §4 drops the `sch:`). */
export function paperPagePath(paperId: string): string {
  const id = paperId.trim().replace(/^sch:/i, "");
  return `/p/${encodeURIComponent(id)}`;
}

/** The standalone discussion page: `/discussion/6sel-2dio-orm6[/v2]`. */
export function discussionPath(paperId: string, version?: number | null): string {
  const id = paperId.trim().replace(/^sch:/i, "");
  const base = `/discussion/${encodeURIComponent(id)}`;
  return version === undefined || version === null ? base : `${base}/v${version}`;
}

/** Sign-in with a way back: `/signin?next=%2Fp%2F…`. */
export function signInPath(next: string): string {
  return `/signin?next=${encodeURIComponent(next)}`;
}

/** The address a browser is on, as far as a return path needs it. */
export interface AddressLike {
  readonly pathname: string;
  readonly search?: string;
  readonly hash?: string;
}

/** The id without its prefix and percent-encoding: `6sel-2dio-orm6`. */
function barePaperId(value: string): string {
  let id = value.trim();
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not valid encoding: compare it as written.
  }
  return id.replace(/^sch:/i, "");
}

/**
 * Whether `pathname` is a page about this paper: `/p/{id}[/vN]` or
 * `/discussion/{id}[/vN]`.
 */
export function isPaperAddress(pathname: string, paperId: string): boolean {
  const match = /^\/(?:p|discussion)\/([^/]+)(?:\/v\d+)?\/?$/.exec(pathname);
  return match !== null && barePaperId(match[1] ?? "") === barePaperId(paperId);
}

/**
 * Where a signed-out reader comes back to after signing in.
 *
 * When they are already on a page about this paper the whole address is kept
 * -- query and fragment included, so the paper page's Discussion tab
 * (`#discussion`) is still open -- because that is where they were. Anywhere
 * else, the way back is the paper page itself.
 */
export function signInReturnPath(paperId: string, here?: AddressLike | null): string {
  if (here === undefined || here === null || !isPaperAddress(here.pathname, paperId)) {
    return paperPagePath(paperId);
  }
  return `${here.pathname}${here.search ?? ""}${here.hash ?? ""}`;
}
