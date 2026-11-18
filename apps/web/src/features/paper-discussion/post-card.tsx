"use client";

/**
 * One post and the replies under it (docs/design.md §5.2, §11).
 *
 * ```text
 * did:key:z6MkhaXg…2doK                              1 Feb 2026
 * “the quoted passage”                         (an annotation only)
 * The proof of Lemma 2 skips the case n = 0.
 * 3 members found this helpful
 * [Mark helpful] [Reply] [⚑ Report]
 *   └ did:key:z6Mk…                                  2 Feb 2026
 *     Good catch, fixed in v2.
 * ```
 *
 * **Every** post has all three actions, replies included: the design promises
 * a Report on every post, and a reply is a post. Each action is a real button
 * with the post's author in its accessible name ("Report post by …"), so a
 * screen-reader user listing the buttons of a long thread is not left with
 * twenty identical "Report"s.
 *
 * The card owns only its own panel (reply or report), the pending state of its
 * own helpful mark and where focus goes next. Everything that changes the
 * thread — posting, voting, reporting — is done by the tab through
 * {@link PostActions}, so a card never holds a copy of data the tab also holds.
 *
 * Replies nest, but indentation stops after four levels: a 360 px margin panel
 * has no room for a staircase.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { LocalDate } from "../ui-kit/local-date";
import { AppealForm } from "./appeal-form";
import { ComposeForm } from "./compose-form";
import {
  appealFiledLabel,
  describeActionError,
  helpfulLabel,
  hiddenOwnNotice,
  postAuthorLabel,
  profilePath,
  reportReason,
  type ActionFailure,
  type DiscussionPost,
  type PostAppeal,
  type ReportReason,
} from "./discussion";
import { FlagIcon } from "./flag-icon";
import { FailureText, SignInNote } from "./notes";
import { ReportPanel } from "./report-panel";

/** What the tab lets a card do, and what the tab knows about this reader. */
export interface PostActions {
  readonly signedIn: boolean;
  readonly signInHref: string;
  /** The viewer's `did:key`, when the session names it; else `null`. */
  readonly viewerDid: string | null;
  /** Posts this reader has marked helpful in this tab. */
  readonly voted: ReadonlySet<string>;
  /** Posts this reader has reported in this tab, with the reason given. */
  readonly reported: ReadonlyMap<string, ReportReason>;
  /**
   * Posts this reader has appealed in this tab, with the date filed and the
   * panel state the filing response named. The state is carried so the card
   * says "panel not yet formed" at once when no panel could be drawn, exactly
   * as the next read will.
   */
  readonly appealed?: ReadonlyMap<string, { readonly filedAt: string; readonly status: string }>;
  /** Sign and submit a reply. Resolves when it is in; rejects to show why not. */
  reply(parent: DiscussionPost, text: string): Promise<void>;
  /** Mark helpful. Resolves when counted; rejects to show why not. */
  helpful(post: DiscussionPost): Promise<void>;
  /** File a report. Resolves when filed; rejects to show why not. */
  report(post: DiscussionPost, reason: ReportReason): Promise<void>;
  /** File an appeal of a hidden post. Resolves when filed; rejects to show why not. */
  appeal?(post: DiscussionPost, grounds: string): Promise<void>;
}

export interface PostCardProps {
  post: DiscussionPost;
  /** 0 for the first post of a thread. */
  depth: number;
  actions: PostActions;
}

type Panel = "reply" | "report";
type FocusTarget = "reply" | "report" | "post" | "reported" | "appeal";

export function PostCard({ post, depth, actions }: PostCardProps) {
  const uid = useId();
  const who = postAuthorLabel(post);
  const authorName = post.author.trim() === "" ? "" : (post.authorName?.trim() ?? "");
  const isOwn =
    actions.viewerDid !== null &&
    post.author !== "" &&
    post.author === actions.viewerDid;

  const [panel, setPanel] = useState<Panel | null>(null);
  const [helpfulBusy, setHelpfulBusy] = useState(false);
  const [helpfulFailure, setHelpfulFailure] = useState<ActionFailure | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);

  const postRef = useRef<HTMLDivElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const reportButton = useRef<HTMLButtonElement>(null);
  const reportedNote = useRef<HTMLParagraphElement>(null);
  const appealButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the next render has put the DOM in its final shape.
  const pendingFocus = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = {
      reply: replyButton.current,
      report: reportButton.current,
      post: postRef.current,
      reported: reportedNote.current,
      appeal: appealButton.current,
    }[target];
    element?.focus();
  });

  const voted = actions.voted.has(post.cid);
  const reportedAs = actions.reported.get(post.cid) ?? null;
  // The node's answer first: it survives a reload and another device. The
  // tab's map only covers the moment between filing and the next read.
  const appealedNow = actions.appealed?.get(post.cid) ?? null;
  const appeal: PostAppeal | null =
    post.appeal ??
    (appealedNow === null
      ? null
      : {
          cid: "",
          filedAt: appealedNow.filedAt,
          status: appealedNow.status,
          outcome: null,
          decidedAt: null,
        });
  const replyId = `${uid}-reply`;
  const reportId = `${uid}-report`;
  const appealId = `${uid}-appeal`;

  const togglePanel = (next: Panel) => {
    setHelpfulFailure(null);
    setPanel((current) => (current === next ? null : next));
  };

  const closePanel = (back: FocusTarget) => {
    pendingFocus.current = back;
    setPanel(null);
  };

  const markHelpful = async () => {
    if (helpfulBusy || voted) return;
    if (!actions.signedIn) {
      if (typeof window !== "undefined") {
        if (typeof window.location.assign === "function") {
          window.location.assign(actions.signInHref);
        } else {
          window.location.href = actions.signInHref;
        }
      }
      return;
    }
    setHelpfulBusy(true);
    setHelpfulFailure(null);
    try {
      await actions.helpful(post);
      // The vote may have moved this post in the list; keep the reader's place.
      pendingFocus.current = "post";
    } catch (error) {
      const failure = describeActionError(error, "helpful");
      setHelpfulFailure(failure);
      // "Already marked" disables the button the reader just pressed.
      if (failure.alreadyDone) pendingFocus.current = "post";
    } finally {
      setHelpfulBusy(false);
    }
  };

  return (
    <li className="pd-item" data-post={post.cid} data-depth={depth}>
      <div className="pd-post" ref={postRef} tabIndex={-1}>
        <header className="pd-post__head">
          {authorName !== "" ? (
            <p className="pd-post__author">
              <Link
                className="pd-post__author-link"
                href={profilePath(post.author)}
                title={post.author}
              >
                {authorName}
              </Link>
            </p>
          ) : (
            <p className="pd-post__author" title={post.author === "" ? undefined : post.author}>
              {who}
            </p>
          )}
          {post.createdAt !== null ? (
            <LocalDate className="pd-post__time" value={post.createdAt} />
          ) : null}
        </header>

        {post.hidden === true ? null : post.quote !== null ? (
          <blockquote className="pd-post__quote">
            <span className="pd-visually-hidden">Annotation on the passage: </span>
            {`“${post.quote}”`}
          </blockquote>
        ) : null}

        {post.hidden === true ? (
          isOwn && appeal !== null ? (
            <p className="pd-post__text pd-post__text--hidden" data-hidden="true" data-appeal-filed="true">
              {appealFiledLabel(appeal)}
            </p>
          ) : isOwn ? (
            <>
              <p className="pd-post__text pd-post__text--hidden" data-hidden="true">
                {hiddenOwnNotice(post.hiddenReason)}{" "}
                {actions.appeal !== undefined ? (
                  <button
                    type="button"
                    className="pd-action"
                    data-action="appeal"
                    ref={appealButton}
                    aria-expanded={appealOpen}
                    aria-controls={appealOpen ? appealId : undefined}
                    onClick={() => setAppealOpen((current) => !current)}
                  >
                    Appeal
                  </button>
                ) : (
                  <a className="pd-action" href={actions.signInHref}>
                    Appeal
                  </a>
                )}
              </p>
              {appealOpen && actions.appeal !== undefined ? (
                <div id={appealId}>
                  <AppealForm
                    signInHref={actions.signInHref}
                    onCancel={() => {
                      pendingFocus.current = "appeal";
                      setAppealOpen(false);
                    }}
                    onSubmit={async (grounds) => {
                      await actions.appeal!(post, grounds);
                      setAppealOpen(false);
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="pd-post__text pd-post__text--hidden" data-hidden="true">
              {post.hiddenReason !== null && post.hiddenReason !== undefined && post.hiddenReason.trim() !== ""
                ? `Hidden by moderation: ${post.hiddenReason.trim()}`
                : "Hidden by moderation."}
            </p>
          )
        ) : post.text !== null ? (
          <p className="pd-post__text">{post.text}</p>
        ) : (
          <p className="pd-post__text pd-post__text--missing">
            The text of this post is not available from this server.
          </p>
        )}

        {post.helpful > 0 ? (
          <p className="pd-post__helpful" data-helpful={post.helpful}>
            {helpfulLabel(post.helpful)}
          </p>
        ) : null}

        {post.hidden === true ? null : (
          <div className="pd-post__actions" role="group" aria-label={`Actions for the post by ${who}`}>
          {/* A member cannot mark their own post helpful (the API refuses it
              with 409), so the action is not offered on their own writing. */}
          {isOwn ? null : (
            <button
              type="button"
              className="pd-action"
              data-action="helpful"
              disabled={voted || helpfulBusy}
              onClick={() => void markHelpful()}
            >
              {voted ? "Marked helpful" : "Mark helpful"}
              <span className="pd-visually-hidden">{`, post by ${who}`}</span>
            </button>
          )}

          <button
            type="button"
            className="pd-action"
            data-action="reply"
            ref={replyButton}
            aria-expanded={panel === "reply"}
            aria-controls={panel === "reply" ? replyId : undefined}
            onClick={() => {
              if (!actions.signedIn) {
                if (typeof window !== "undefined") {
                  if (typeof window.location.assign === "function") {
                    window.location.assign(actions.signInHref);
                  } else {
                    window.location.href = actions.signInHref;
                  }
                }
                return;
              }
              togglePanel("reply");
            }}
          >
            Reply{" "}
            <span className="pd-visually-hidden">{`to post by ${who}`}</span>
          </button>

          {/* A member reports somebody else's record, never their own. */}
          {isOwn ? null : reportedAs === null ? (
            <button
              type="button"
              className="pd-action pd-action--report"
              data-action="report"
              ref={reportButton}
              aria-expanded={panel === "report"}
              aria-controls={panel === "report" ? reportId : undefined}
              onClick={() => {
                if (!actions.signedIn) {
                  if (typeof window !== "undefined") {
                    if (typeof window.location.assign === "function") {
                      window.location.assign(actions.signInHref);
                    } else {
                      window.location.href = actions.signInHref;
                    }
                  }
                  return;
                }
                togglePanel("report");
              }}
            >
              <FlagIcon className="pd-action__icon" />
              Report{" "}
              <span className="pd-visually-hidden">{`post by ${who}`}</span>
            </button>
          ) : null}
          </div>
        )}

        {helpfulFailure !== null ? (
          <FailureText failure={helpfulFailure} signInHref={actions.signInHref} />
        ) : null}

        {reportedAs !== null ? (
          <p className="pd-note" ref={reportedNote} tabIndex={-1} data-note="reported">
            {`You reported this post as “${reportReason(reportedAs)?.label ?? reportedAs}”. A moderator will review it, and you will be told what was decided.`}
          </p>
        ) : null}

        {panel === "reply" ? (
          <div className="pd-panel" id={replyId}>
            {actions.signedIn ? (
              <ComposeForm
                kind="reply"
                label={`Your reply to the post by ${who}`}
                signInHref={actions.signInHref}
                autoFocus
                onCancel={() => closePanel("reply")}
                onSubmit={async (text) => {
                  await actions.reply(post, text);
                  closePanel("reply");
                }}
              />
            ) : (
              <SignInNote to="reply" signInHref={actions.signInHref} />
            )}
          </div>
        ) : null}

        {panel === "report" && reportedAs === null && !isOwn ? (
          <div className="pd-panel" id={reportId}>
            {actions.signedIn ? (
              <ReportPanel
                authorLabel={who}
                signInHref={actions.signInHref}
                onCancel={() => closePanel("report")}
                onReport={async (reason) => {
                  await actions.report(post, reason);
                  closePanel("reported");
                }}
              />
            ) : (
              <SignInNote to="report this post" signInHref={actions.signInHref} />
            )}
          </div>
        ) : null}
      </div>

      {post.replies.length > 0 ? (
        <ol className="pd-replies" aria-label={`Replies to the post by ${who}`}>
          {post.replies.map((reply) => (
            <PostCard key={reply.cid} post={reply} depth={depth + 1} actions={actions} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}
