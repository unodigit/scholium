"use client";

/**
 * DiscussionTab: the Discussion tab of the paper page (docs/design.md §5.2).
 *
 * ```tsx
 * <DiscussionTab paperId="sch:6sel-2dio-orm6" versionCid={version.cid} />
 * <DiscussionTab paperId={paper.shortId} initial={threads} signedIn={false} />
 * ```
 *
 * Threads, **most helpful first**:
 *
 * ```text
 * 3 posts · most helpful first
 * [Start a thread]
 * ├ did:key:z6Mk…                                   1 Feb 2026
 * │ The proof of Lemma 2 skips the case n = 0.
 * │ 2 members found this helpful
 * │ [Mark helpful] [Reply] [⚑ Report]
 * │   └ did:key:z6Mk…  Good catch, fixed in v2.   [Mark helpful] [Reply] [⚑ Report]
 * └ did:key:z6Mk…                                   3 Feb 2026
 *   Is the dataset licence compatible with CC BY?
 *   [Mark helpful] [Reply] [⚑ Report]
 * ```
 *
 * Every post, replies included, has a reply form and a **Report** action. A
 * helpful mark only orders the thread (it is a vote about usefulness, never
 * about the paper, and the API guarantees it cannot change a paper's status).
 *
 * Posting is signing: a thread or reply is a `discussion.post` record, signed
 * on this device behind a passkey prompt and submitted to
 * `POST /v1/papers/{id}/threads`. A post, a mark or a report appears at once
 * and is not re-fetched: the tab trusts the server's `201`, and the next load
 * brings everyone else's posts. Signed-out readers can read; where a form
 * would be, they are told to sign in.
 *
 * The server route may pass `initial` so the first HTML already has the
 * threads (and `initialError` when its fetch failed); on its own the tab loads
 * from `GET /v1/papers/{id}/threads` and offers a retry. Every network and
 * signing seam is injectable for tests.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../ui-kit";
import { api } from "../../lib/api";
import { signRecord as signRecordFallback } from "../web-auth/sign-record";
import { useViewer } from "../review-form/use-viewer";
import type { Viewer } from "../review-form/viewer";
import { ComposeForm } from "./compose-form";
import {
  addPost,
  countHiddenPosts,
  countPosts,
  describeActionError,
  describeLoadError,
  findPost,
  loadThreads,
  markPostHelpful,
  orderThreads,
  paperPagePath,
  postCountLabel,
  reportPostFlag,
  signInPath,
  signInReturnPath,
  submitPost,
  withHelpful,
  type DiscussionData,
  type DiscussionPost,
  type LoadThreads,
  type MarkHelpful,
  type ReportPost,
  type ReportReason,
  type SignPostRecord,
  type SubmitPostRecord,
} from "./discussion";
import { SignInNote } from "./notes";
import { PostCard, type PostActions } from "./post-card";
import "./paper-discussion.css";

/** The things the tab does besides read. Each defaults to the real call. */
export interface DiscussionActions {
  /** Signs the `discussion.post` behind a passkey prompt; web-auth's `signRecord`. */
  sign: SignPostRecord;
  /** Sends the signed post; `POST /v1/papers/{id}/threads`. */
  submit: SubmitPostRecord;
  /** Marks a post helpful; `POST /v1/posts/{cid}/helpful`. */
  markHelpful: MarkHelpful;
  /** Reports a post; `POST /v1/flags`. */
  report: ReportPost;
}

export interface DiscussionTabProps {
  /** The paper's id, in any spelling the API accepts (`sch:…` or a genesis cid). */
  paperId: string;
  /**
   * The id of the version the paper page is showing. A new thread is attached
   * to it; without it a thread is attached to the paper itself.
   */
  versionCid?: string;
  /** Threads fetched by the server, so the first paint has posts. */
  initial?: DiscussionData;
  /** Why the server's fetch failed; the tab offers a retry. */
  initialError?: string;
  /** Replace the loader, for tests or another source. Keep it stable. */
  load?: LoadThreads;
  /** Replace any of the actions, for tests. Keep it stable. */
  actions?: Partial<DiscussionActions>;
  /** Pin the sign-in state instead of reading it from the stored session. */
  signedIn?: boolean;
  /**
   * Pin the viewer's DID instead of reading it from the stored session's
   * token. It is how a post by the viewer is recognised, so that member is
   * not offered a helpful mark on their own writing.
   */
  viewerDid?: string | null;
  /** Where "Sign in" goes; defaults to sign-in, then back to the paper page. */
  signInHref?: string;
}

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: DiscussionData };

function initialView(initial: DiscussionData | undefined, initialError: string | undefined): View {
  if (initialError !== undefined && initialError !== "") {
    return { kind: "error", message: initialError };
  }
  if (initial !== undefined) return { kind: "ready", data: initial };
  return { kind: "loading" };
}

export function DiscussionTab({
  paperId,
  versionCid,
  initial,
  initialError,
  load,
  actions,
  signedIn: signedInOverride,
  viewerDid: viewerDidOverride,
  signInHref: signInHrefOverride,
}: DiscussionTabProps) {
  // The live session: the token lives in memory, so the DID and the signed-in
  // state are only known after mount. A pinned viewer wins, for hosts/tests.
  const pinnedViewer: Viewer | undefined =
    signedInOverride === undefined && viewerDidOverride === undefined
      ? undefined
      : {
          signedIn: signedInOverride ?? true,
          did: viewerDidOverride ?? null,
          tier: null,
        };
  const viewer = useViewer(pinnedViewer);
  const signedIn = viewer.signedIn;
  const viewerDid = viewer.did;

  // The sign-in link follows the live address, so a signed-out reader comes
  // back to the Discussion tab with its fragment (#discussion) rather than to
  // the top of the paper page. Read after mount: the server has no address.
  const [here, setHere] = useState<string | null>(null);
  useEffect(() => {
    const { pathname, search, hash } = window.location;
    setHere(signInReturnPath(paperId, { pathname, search, hash }));
  }, [paperId]);

  const signInHref =
    signInHrefOverride ?? signInPath(here ?? paperPagePath(paperId));

  const [view, setView] = useState<View>(() => initialView(initial, initialError));
  const [attempt, setAttempt] = useState(0);
  const [voted, setVoted] = useState<ReadonlySet<string>>(() => new Set());
  const [reported, setReported] = useState<ReadonlyMap<string, ReportReason>>(() => new Map());
  const [appealed, setAppealed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [announcement, setAnnouncement] = useState("");
  const [starting, setStarting] = useState(false);
  // A host may swap `paperId` (an SPA navigating between papers) without
  // remounting: start over from this paper's data, never show the old one's.
  const [sourceKey, setSourceKey] = useState(paperId);
  if (sourceKey !== paperId) {
    setSourceKey(paperId);
    setView(initialView(initial, initialError));
    setAttempt(0);
    setVoted(new Set());
    setReported(new Map());
    setAnnouncement("");
    setStarting(false);
  }

  // The latest loader without making an inline function restart the request.
  const loadRef = useRef<LoadThreads>(load ?? loadThreads);
  useEffect(() => {
    loadRef.current = load ?? loadThreads;
  }, [load]);

  // The server already asked: with an answer, or with a failure the reader is
  // looking at. Either way only a retry asks again, so an error the server
  // reported is not replaced by a spinner the moment the page hydrates.
  const serverAnswered = initial !== undefined || (initialError !== undefined && initialError !== "");
  useEffect(() => {
    if (attempt === 0 && serverAnswered) return;
    const controller = new AbortController();
    setView({ kind: "loading" });
    loadRef.current(paperId, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setView({ kind: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setView({ kind: "error", message: describeLoadError(error) });
        }
      },
    );
    return () => controller.abort();
  }, [paperId, attempt, serverAnswered]);

  const retry = () => setAttempt((count) => count + 1);

  // After the thread starter closes, put focus back on the button that opened it.
  const startButton = useRef<HTMLButtonElement>(null);
  const focusStart = useRef(false);
  useEffect(() => {
    if (!focusStart.current) return;
    focusStart.current = false;
    startButton.current?.focus();
  });

  const data = view.kind === "ready" ? view.data : null;
  const ordered = useMemo(() => (data === null ? [] : orderThreads(data.threads)), [data]);
  const total = data === null ? 0 : countPosts(data.threads);
  // A hidden placeholder is listed but is not a post; the summary says both.
  const hiddenTotal = data === null ? 0 : countHiddenPosts(data.threads);

  /* ---- What a card may do --------------------------------------------- */

  // A reply is about what its parent is about; a new thread is about the
  // version on the page, or failing that the paper itself.
  const post = async (parent: DiscussionPost | null, text: string): Promise<void> => {
    const target = parent?.target ?? versionCid ?? data?.paperCid ?? null;
    const made = await submitPost({
      paperId,
      text,
      target,
      parent: parent === null ? null : parent.cid,
      sign: actions?.sign,
      submit: actions?.submit,
    });
    setView((current) =>
      current.kind === "ready" ? { kind: "ready", data: addPost(current.data, made) } : current,
    );
    setAnnouncement(parent === null ? "Your thread was posted." : "Your reply was posted.");
  };

  const markHelpful = async (target: DiscussionPost): Promise<void> => {
    try {
      const count = await (actions?.markHelpful ?? markPostHelpful)(target.cid);
      setVoted((current) => new Set(current).add(target.cid));
      setView((current) => {
        if (current.kind !== "ready") return current;
        const now = findPost(current.data.threads, target.cid)?.helpful ?? 0;
        return {
          kind: "ready",
          data: withHelpful(current.data, target.cid, count ?? now + 1),
        };
      });
      setAnnouncement("Marked helpful. Threads are ordered by helpful marks.");
    } catch (error) {
      // The server already has this member's mark: the button should say so.
      if (describeActionError(error, "helpful").alreadyDone) {
        setVoted((current) => new Set(current).add(target.cid));
      }
      throw error;
    }
  };

  const report = async (target: DiscussionPost, reason: ReportReason): Promise<void> => {
    await (actions?.report ?? reportPostFlag)(target.cid, reason);
    setReported((current) => new Map(current).set(target.cid, reason));
    // The card's note ("You reported this post as …") is the one confirmation;
    // a second announcement would say the same thing twice.
  };

  const appeal = async (target: DiscussionPost, grounds: string): Promise<void> => {
    const sign = actions?.sign ?? signRecordFallback;
    const decisionCid = target.decisionCid;
    if (typeof decisionCid !== "string" || decisionCid === "") {
      throw new Error("This post has no moderation decision to appeal.");
    }
    const paperCid = data?.paperCid ?? null;
    const record = await sign("appeal", {
      target: decisionCid,
      grounds: grounds.trim(),
      paper: paperCid,
    }, null);
    await api.post("/appeals", record);
    setAppealed((current) => new Map(current).set(target.cid, record.created));
    setAnnouncement("Appeal filed.");
  };

  const postActions: PostActions = {
    signedIn,
    signInHref,
    viewerDid,
    voted,
    reported,
    appealed,
    reply: post,
    helpful: markHelpful,
    report,
    appeal,
  };

  return (
    <section
      className="pd-tab"
      aria-label="Discussion"
      aria-busy={view.kind === "loading"}
      data-state={view.kind}
    >
      {view.kind === "loading" ? (
        <p className="pd-loading" role="status">
          <Icon name="spinner" className="pd-loading__icon" />
          Loading the discussion…
        </p>
      ) : null}

      {view.kind === "error" ? (
        <div className="pd-error" role="alert">
          <p className="pd-error__message">{view.message}</p>
          <button type="button" className="pd-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {view.kind === "ready" ? (
        <>
          {total === 0 && hiddenTotal === 0 ? (
            <p className="pd-empty">No discussion yet. Start a thread to say something about this paper.</p>
          ) : (
            <p className="pd-summary">{`${postCountLabel(total, hiddenTotal)} · most helpful first`}</p>
          )}

          <div className="pd-start">
            {!signedIn ? (
              <SignInNote to="start a thread or reply" signInHref={signInHref} />
            ) : starting ? (
              <ComposeForm
                kind="thread"
                label="Start a thread"
                signInHref={signInHref}
                autoFocus
                onCancel={() => {
                  focusStart.current = true;
                  setStarting(false);
                }}
                onSubmit={async (text) => {
                  await post(null, text);
                  focusStart.current = true;
                  setStarting(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="pd-button"
                ref={startButton}
                onClick={() => setStarting(true)}
              >
                Start a thread
              </button>
            )}
          </div>

          {total > 0 ? (
            <ol className="pd-threads" aria-label="Threads, most helpful first">
              {ordered.map((thread) => (
                <PostCard key={thread.cid} post={thread} depth={0} actions={postActions} />
              ))}
            </ol>
          ) : null}
        </>
      ) : null}

      {/* Always in the DOM so a change is announced reliably. */}
      <p className="pd-visually-hidden" role="status" aria-live="polite" data-announcement>
        {announcement}
      </p>
    </section>
  );
}
