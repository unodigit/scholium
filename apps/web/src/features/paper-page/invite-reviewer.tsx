"use client";

/**
 * **Invite reviewer**, the paper page's one write action for authors (spec
 * feature 187, docs/design.md §5.2): a button under the header's actions that
 * opens a small form for the DID of a verified reviewer, and sends
 * `POST /v1/papers/{id}/review-invitations` for the version on screen.
 *
 * ```tsx
 * <InviteReviewer paperId="sch:k3f9-q2xz-7mwd" version={2}
 *                 categories={["cs.AI"]} authorDids={[ALICE, BOB]} />
 * ```
 *
 * It renders **nothing until it knows the reader is an author**: the first
 * render is the server's (nothing), and once the page runs the signed-in
 * viewer is read from the shared token store (`useViewer`), so a shared link,
 * a crawler and every reader who is not on the byline see the header exactly
 * as it was. Who may invite is the API's call (see `invitation.ts`); this
 * only chooses whether to show the button, and a refusal is shown in the
 * node's own words.
 *
 * Accessibility (docs/design.md §9): the button is a disclosure
 * (`aria-expanded`, `aria-controls`); the form stays mounted while closed so a
 * half-typed DID survives; focus moves to the field when the form opens and
 * back to it on a mistake; an outcome is an icon plus words in a live region,
 * never colour alone; every target is at least 44 px on touch.
 */

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";

import { useViewer } from "../review-form/use-viewer";
import type { Viewer } from "../review-form/viewer";
import { Icon } from "../ui-kit/icons";
import {
  INVITE_LABEL,
  INVITE_SUBMIT_LABEL,
  canInvite,
  checkInvitee,
  describeInviteError,
  sendInvitation,
  type Invitation,
  type InviteFailure,
  type SendInvitation,
} from "./invitation";

export interface InviteReviewerProps {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** The version on screen: the one the reviewer is invited to review. */
  readonly version: number;
  /** The paper's categories: the reviewer must be verified in one of them. */
  readonly categories: readonly string[];
  /** The paper's authors' DIDs: who is offered the action, and who cannot be invited. */
  readonly authorDids: readonly string[];
  /** Pin the viewer instead of reading it from the signed-in session. */
  readonly viewer?: Viewer;
  /** Replace the request, for tests. */
  readonly send?: SendInvitation;
  /** Where "Sign in" goes when a session has ended. */
  readonly signInHref?: string;
}

const DEFAULT_SIGN_IN_HREF = "/signin";

type Phase = "editing" | "sending";

/** A DID is long; show the start and the end so two can be told apart. */
function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 14)}…${did.slice(-6)}`;
}

export function InviteReviewer({
  paperId,
  version,
  categories,
  authorDids,
  viewer: viewerOverride,
  send = sendInvitation,
  signInHref = DEFAULT_SIGN_IN_HREF,
}: InviteReviewerProps) {
  const viewer = useViewer(viewerOverride);
  const uid = useId();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [mistake, setMistake] = useState<string | null>(null);
  const [failed, setFailed] = useState<InviteFailure | null>(null);
  const [invited, setInvited] = useState<readonly Invitation[]>([]);
  const [confirmation, setConfirmation] = useState("");

  const input = useRef<HTMLInputElement>(null);
  // A second submit while one is in flight must not send a second invitation.
  const sending = useRef(false);

  // The field is inside a `hidden` panel until the open state commits, and a
  // hidden field cannot take focus, so move focus once the panel is showing.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!canInvite(viewer, authorDids)) return null;

  const panelId = `${uid}-panel`;
  const headingId = `${uid}-heading`;
  const fieldId = `${uid}-did`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const busy = phase === "sending";
  const category = categories.length > 0 ? categories.join(", ") : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (sending.current) return;

    setFailed(null);
    setConfirmation("");

    const checked = checkInvitee(value, authorDids);
    if (!checked.ok) {
      setMistake(checked.message);
      input.current?.focus();
      return;
    }
    setMistake(null);

    sending.current = true;
    setPhase("sending");
    try {
      const invitation = await send({
        paperId,
        version,
        reviewer: checked.did,
      });
      setInvited((previous) => [...previous, invitation]);
      setConfirmation(
        `Invitation sent to ${shortDid(invitation.reviewer)}. It is on their dashboard.`,
      );
      // Ready for the next reviewer.
      setValue("");
    } catch (error) {
      setFailed(describeInviteError(error));
    } finally {
      sending.current = false;
      setPhase("editing");
    }
  };

  return (
    <div className="ppg-invite">
      <button
        type="button"
        className="ppg-action ppg-invite-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {INVITE_LABEL}
      </button>

      <section
        id={panelId}
        className="ppg-invite-panel"
        aria-labelledby={headingId}
        hidden={!open}
      >
        <h2 id={headingId} className="ppg-invite-title">
          Invite a reviewer to v{version}
        </h2>
        <p className="ppg-invite-lede">
          Ask a verified reviewer{category !== null ? ` in ${category}` : ""} to
          review this version. They are told on their dashboard and decide for
          themselves.
        </p>

        <form className="ppg-invite-form" onSubmit={submit} noValidate>
          <label className="ppg-invite-label" htmlFor={fieldId}>
            Reviewer’s DID
          </label>
          <input
            ref={input}
            id={fieldId}
            className="ppg-invite-input"
            type="text"
            name="reviewer"
            value={value}
            placeholder="did:key:z6Mk…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            readOnly={busy}
            aria-invalid={mistake !== null}
            aria-describedby={mistake !== null ? `${hintId} ${errorId}` : hintId}
            onChange={(event) => {
              setValue(event.target.value);
              if (mistake !== null) setMistake(null);
            }}
          />
          <p id={hintId} className="ppg-invite-hint">
            Copy it from the end of their profile’s address, /u/did:key:…
          </p>

          {mistake !== null ? (
            <p id={errorId} className="ppg-invite-error" role="alert">
              <Icon name="alert" className="ppg-invite-icon ppg-invite-icon--critical" />
              <span>{mistake}</span>
            </p>
          ) : null}

          <div className="ppg-invite-buttons">
            <button
              type="submit"
              className="ppg-invite-send"
              aria-disabled={busy}
            >
              {busy ? "Sending…" : INVITE_SUBMIT_LABEL}
            </button>
            <button
              type="button"
              className="ppg-invite-close"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </form>

        {failed !== null ? (
          <p className="ppg-invite-error" role="alert">
            <Icon name="alert" className="ppg-invite-icon ppg-invite-icon--critical" />
            <span>
              {failed.message}
              {failed.signIn ? (
                <>
                  {" "}
                  <a className="ppg-invite-link" href={signInHref}>
                    Sign in
                  </a>
                </>
              ) : null}
            </span>
          </p>
        ) : null}

        {/* Always mounted, so the words are announced when they appear. */}
        <p className="ppg-invite-done" role="status">
          {confirmation !== "" ? (
            <>
              <Icon name="check" className="ppg-invite-icon ppg-invite-icon--verified" />
              <span>{confirmation}</span>
            </>
          ) : null}
        </p>

        {invited.length > 0 ? (
          <div className="ppg-invite-sent">
            <h3 className="ppg-invite-sent-title">Invited from this page</h3>
            <ul className="ppg-invite-list">
              {invited.map((invitation, index) => (
                <li key={`${invitation.id ?? invitation.reviewer}-${index}`}>
                  <span className="ppg-invite-did" title={invitation.reviewer}>
                    {shortDid(invitation.reviewer)}
                  </span>
                  <span className="ppg-invite-status">{invitation.status}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
