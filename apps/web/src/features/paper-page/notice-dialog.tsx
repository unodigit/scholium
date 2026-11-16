"use client";

/**
 * **Issue notice** — a correction, retraction or withdrawal, signed with the
 * author's device key and sent to `POST /v1/records` (PUB-7; the API side is
 * `apps/api/src/app/modules/submissions/notices.py`).
 *
 * ```tsx
 * <NoticeDialog paperId="sch:k3f9-q2xz-7mwd" paperCid="bafyrei…"
 *               versionCid="bafyrei…" version={2} />
 * ```
 *
 * A notice belongs to the *paper*, whichever version it names, so the body is
 * `{target, paper, reason}` with the version on screen as its target. Readers
 * see the reason in a banner on every version (docs/design.md §5.2), which is
 * why the reason is required and read back before it is signed.
 *
 * **Retraction and withdrawal ask once more.** Both are public and durable:
 * the dialog shows what the notice will say on every version and waits for a
 * second, explicit confirmation before the passkey prompt. A correction is
 * issued straight away.
 *
 * The dialog is offered only to a consented author of the paper
 * (`paper-actions.tsx` reads that); the API is the gate and answers `403` to
 * anyone else. Signing is `web-auth`'s `signRecord` — a record of its own,
 * `prev: null` — through the same passkey prompt as every other signed action.
 *
 * Accessibility (docs/design.md §9): a modal dialog named by its title, a
 * fieldset of kinds with native radios, a labelled reason field whose mistake
 * is announced, focus kept inside the dialog, Escape and the scrim to close,
 * focus back on the button that opened it, and an icon plus words — never
 * colour alone — for a failure or a success.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import {
  isDeviceKeyError,
  isPasskeyCancellation,
  isRecordSigningError,
} from "../web-auth/errors";
import { signRecord, type SignedRecord } from "../web-auth/sign-record";
import { Icon } from "../ui-kit/icons";

/** The words on the action that opens the dialog. */
export const NOTICE_LABEL = "Issue notice";

/** The dialog's title. */
export const NOTICE_DIALOG_TITLE = "Issue a notice";

/** The three notices the API accepts from an author. */
export const NOTICE_KINDS = ["correction", "retraction", "withdrawal"] as const;

/** One notice kind: the record type that is signed. */
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** How each kind reads to an author. */
export const NOTICE_LABELS: Readonly<Record<NoticeKind, string>> = {
  correction: "Correction",
  retraction: "Retraction",
  withdrawal: "Withdrawal",
};

/** One sentence saying what each kind does. */
export const NOTICE_DESCRIPTIONS: Readonly<Record<NoticeKind, string>> = {
  correction: "The paper stays, with a notice of what was wrong.",
  retraction: "The paper’s claims no longer stand.",
  withdrawal: "The authors take the paper back.",
};

/**
 * The second step for the two notices that cannot be undone quietly. A
 * correction changes one thing; these say the paper no longer stands.
 */
export const NOTICE_CONFIRMATIONS: Readonly<Partial<Record<NoticeKind, string>>> = {
  retraction:
    "A retraction is public. Every version of this paper will show it, and the paper’s claims will be marked as no longer standing.",
  withdrawal:
    "A withdrawal is public. Every version of this paper will show it, and the paper will be marked as taken back by its authors.",
};

/** The button that signs and sends a correction. */
export const NOTICE_SUBMIT_LABEL = "Sign and issue";

/** The button that goes to the confirmation step. */
export const NOTICE_REVIEW_LABEL = "Review and sign";

/** Said after every refusal, so no one wonders whether it went through. */
export const NOT_NOTICED = "No notice was issued.";

/** `POST` path (relative to `/v1`) for a signed record. */
export const RECORDS_ENDPOINT = "/records";

/** The reason a notice must carry, in the author's words. */
export const NOTICE_REASON_LABEL = "Reason";

/** What is wrong when the reason is blank. */
export const NOTICE_EMPTY_REASON =
  "Say what the notice is for. Readers see this reason on every version.";

/** The body of a signed notice record. */
export interface NoticeBody {
  /** cid of the version on screen: what the notice is about. */
  readonly target: string;
  /** cid of the paper’s genesis record. */
  readonly paper: string;
  /** The text readers see. */
  readonly reason: string;
  /** Envelope bodies are open objects; later features may add fields. */
  readonly [key: string]: unknown;
}

/** What the dialog signs. */
export interface NoticeRequest {
  readonly kind: NoticeKind;
  readonly paperCid: string;
  readonly versionCid: string;
  readonly reason: string;
}

/** Build the signed record's body, trimming the reason a field carries. */
export function noticeBody(request: NoticeRequest): NoticeBody {
  return {
    target: request.versionCid,
    paper: request.paperCid,
    reason: request.reason.trim(),
  };
}

/** Signs one notice body; {@link signNotice} by default. */
export type SignNotice = (
  kind: NoticeKind,
  body: NoticeBody,
) => Promise<SignedRecord>;

/** Sends one signed notice; {@link submitNotice} by default. */
export type SubmitNotice = (
  kind: NoticeKind,
  record: SignedRecord,
) => Promise<NoticeAccepted>;

/** What the node answered for an accepted notice. */
export interface NoticeAccepted {
  /** cid of the notice record (`GET /v1/records/{id}` serves it). */
  readonly id: string;
  /** The state the node reported, when it names one. */
  readonly state: string | null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read the `201` body. A success must not become an apparent failure because
 * the body is unexpected: everything missing falls back to what was signed.
 */
export function parseNoticeAccepted(
  payload: unknown,
  fallbackId: string,
): NoticeAccepted {
  const body =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    id:
      readText(body.id) ??
      readText(body.record_id) ??
      readText(body.recordId) ??
      fallbackId,
    state: readText(body.state) ?? readText(body.status),
  };
}

/**
 * Sign a notice with the device key behind a passkey prompt.
 *
 * The record type *is* the kind (`correction`, `retraction`, `withdrawal`);
 * `prev` is `null` because a notice is a record of its own, not the next link
 * in the paper’s chain.
 */
export async function signNotice(
  kind: NoticeKind,
  body: NoticeBody,
): Promise<SignedRecord> {
  return signRecord(kind, body, null, { reason: "Sign and issue notice" });
}

/** Post a signed notice to `POST /v1/records`. */
export async function submitNotice(
  _kind: NoticeKind,
  record: SignedRecord,
  client: Pick<ApiClient, "post"> = api,
): Promise<NoticeAccepted> {
  const payload = await client.post<unknown>(RECORDS_ENDPOINT, record);
  return parseNoticeAccepted(payload, record.id);
}

/** The notice this dialog signed was not the kind the author chose. */
export class WrongNoticeRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrongNoticeRecordError";
  }
}

/** Sign and send one notice. Nothing is sent until the record is signed. */
export async function issueNotice(
  request: NoticeRequest,
  seams: { readonly sign?: SignNotice; readonly submit?: SubmitNotice } = {},
): Promise<NoticeAccepted> {
  const body = noticeBody(request);
  if (body.reason === "") {
    throw new Error(NOTICE_EMPTY_REASON);
  }
  const record = await (seams.sign ?? signNotice)(request.kind, body);
  if (record.type !== request.kind) {
    throw new WrongNoticeRecordError(
      `The signer produced a ${record.type} record, not a ${request.kind} record.`,
    );
  }
  return (seams.submit ?? submitNotice)(request.kind, record);
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                     */
/* -------------------------------------------------------------------------- */

/** What the dialog shows when issuing fails: a sentence and an optional sign-in. */
export interface NoticeFailure {
  readonly message: string;
  readonly signIn: boolean;
}

function failure(message: string, signIn = false): NoticeFailure {
  return { message, signIn };
}

/** A sentence from the node's own words, ending in a full stop. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One plain-language failure for whatever issuing threw. */
export function describeNoticeError(
  error: unknown,
  kind: NoticeKind,
): NoticeFailure {
  const label = NOTICE_LABELS[kind].toLowerCase();
  const nothing = `No ${label} was issued.`;
  const cancelled = `Signing was cancelled, so ${nothing.charAt(0).toLowerCase()}${nothing.slice(1)} Sign again when you are ready.`;

  if (isPasskeyCancellation(error)) {
    return failure(cancelled);
  }
  if (isRecordSigningError(error)) {
    return failure(
      `The ${label} record could not be prepared, so nothing was signed or sent.`,
    );
  }
  if (error instanceof WrongNoticeRecordError) {
    return failure(`${error.message} ${nothing}`);
  }
  if (isDeviceKeyError(error)) {
    if (error.code === "passkey-cancelled") {
      return failure(cancelled);
    }
    return failure(
      error.code === "not-found"
        ? `This device has no signing key, so it cannot sign the ${label}. ${nothing}`
        : error.code === "passkey-failed"
          ? `The passkey could not be confirmed, so ${nothing.charAt(0).toLowerCase()}${nothing.slice(1)} Try again.`
          : `Could not sign with this device’s key, so ${nothing.charAt(0).toLowerCase()}${nothing.slice(1)}`,
    );
  }
  if (error instanceof ApiError) {
    const said = error.problem.detail;
    const detail = typeof said === "string" ? said.trim() : "";
    switch (error.status) {
      case 401:
        return failure(`Your session has ended. ${nothing}`, true);
      case 403:
        return failure(
          `${sentence(
            detail ||
              "Only a consented author of this paper may issue a notice for it",
          )} ${nothing}`,
        );
      case 404:
        return failure(
          `This node could not find the paper. ${nothing} Reload the page and try again.`,
        );
      case 409:
        return failure(
          `${sentence(detail || "This notice is already on record")} ${nothing}`,
        );
      case 422:
        return failure(
          `${sentence(
            detail || "The node did not accept the notice",
          )} ${nothing} Check the reason and try again.`,
        );
      default:
        if (error.status >= 500) {
          return failure(
            `Scholium could not save the notice just now, so it is not confirmed as issued. Try again in a moment.`,
          );
        }
        return failure(
          `${sentence(detail || error.title || "The node refused the notice")} ${nothing}`,
        );
    }
  }
  if (error instanceof NetworkError) {
    return failure(
      `Scholium could not reach the node. ${nothing} Check your connection and try again.`,
    );
  }
  return failure(
    error instanceof Error && error.message
      ? `${sentence(error.message)} ${nothing}`
      : `The notice could not be issued. ${nothing}`,
  );
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                   */
/* -------------------------------------------------------------------------- */

/** What can take focus inside the dialog, for keeping Tab inside it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "editing" | "confirming" | "signing" | "issued";

export interface NoticeDialogProps {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** cid of the paper’s genesis record: `body.paper`. */
  readonly paperCid: string;
  /** cid of the version on screen: `body.target`. */
  readonly versionCid: string;
  /** The version on screen, for the dialog’s words. */
  readonly version: number;
  /** Replace the request seams, for tests. */
  readonly sign?: SignNotice;
  readonly submit?: SubmitNotice;
  /** Where “Sign in” goes when a session has ended. */
  readonly signInHref?: string;
}

const DEFAULT_SIGN_IN_HREF = "/signin";

export function NoticeDialog({
  paperId,
  paperCid,
  versionCid,
  version,
  sign = signNotice,
  submit = submitNotice,
  signInHref = DEFAULT_SIGN_IN_HREF,
}: NoticeDialogProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Back to where the reader was. Not left to the browser: Safari does not
    // focus a button on click, so "where focus was" can be the page itself.
    trigger.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ppg-action"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {NOTICE_LABEL}
      </button>
      {open ? (
        <NoticePanel
          paperId={paperId}
          paperCid={paperCid}
          versionCid={versionCid}
          version={version}
          sign={sign}
          submit={submit}
          signInHref={signInHref}
          onClose={close}
        />
      ) : null}
    </>
  );
}

interface NoticePanelProps extends Omit<NoticeDialogProps, "sign" | "submit"> {
  readonly sign: SignNotice;
  readonly submit: SubmitNotice;
  readonly signInHref: string;
  readonly onClose: () => void;
}

function NoticePanel({
  paperId,
  paperCid,
  versionCid,
  version,
  sign,
  submit,
  signInHref,
  onClose,
}: NoticePanelProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const ledeId = `${uid}-lede`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const panel = useRef<HTMLDivElement>(null);
  const firstKind = useRef<HTMLInputElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const safeAction = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  const [kind, setKind] = useState<NoticeKind>("correction");
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [mistake, setMistake] = useState<string | null>(null);
  const [failed, setFailed] = useState<NoticeFailure | null>(null);
  const [issued, setIssued] = useState<NoticeAccepted | null>(null);

  // A second submit while one is in flight must not sign or send twice.
  const sending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Take focus into the dialog on open, and keep the page behind from
  // scrolling under the scrim. Once: not again on a parent re-render.
  useEffect(() => {
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // The first field is inside the dialog only after it has committed. A
  // refused reason takes focus back to the field that needs it.
  useEffect(() => {
    if (phase !== "editing") return;
    if (mistake !== null) reasonField.current?.focus();
    else firstKind.current?.focus();
  }, [phase, mistake]);

  // A destructive confirmation lands on its safe action.
  useEffect(() => {
    if (phase === "confirming") safeAction.current?.focus();
    if (phase === "issued") done.current?.focus();
  }, [phase]);

  // Escape closes the dialog, except while a signature is in flight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && phase !== "signing") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  // Tab goes round inside the dialog instead of out into the page behind it.
  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || panel.current === null) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (stops.length === 0) {
      event.preventDefault();
      panel.current.focus();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const busy = phase === "signing";
  const confirmation = NOTICE_CONFIRMATIONS[kind] ?? null;
  const label = NOTICE_LABELS[kind];

  const send = async (): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setFailed(null);
    setPhase("signing");
    try {
      const accepted = await issueNotice(
        { kind, paperCid, versionCid, reason },
        { sign, submit },
      );
      if (!mounted.current) return;
      setIssued(accepted);
      setPhase("issued");
    } catch (error) {
      if (!mounted.current) return;
      setFailed(describeNoticeError(error, kind));
      setPhase("editing");
    } finally {
      sending.current = false;
    }
  };

  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    setFailed(null);
    if (reason.trim() === "") {
      setMistake(NOTICE_EMPTY_REASON);
      return;
    }
    setMistake(null);
    if (confirmation !== null) {
      setPhase("confirming");
      return;
    }
    void send();
  };

  return createPortal(
    <div
      className="ppg-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        className="ppg-dialog ppg-notice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ledeId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <div className="ppg-dialog-header">
          <h2 id={titleId} className="ppg-dialog-title">
            {NOTICE_DIALOG_TITLE}
          </h2>
          <button
            type="button"
            className="ppg-dialog-close"
            aria-label="Close"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            <Icon name="cross" className="ppg-dialog-close-icon" />
          </button>
        </div>
        <p id={ledeId} className="ppg-dialog-lede">
          A notice is signed into the public record and shown on every version
          of <span className="ppg-notice-id">{paperId}</span>, including v
          {version}. Say what happened and why readers should know.
        </p>

        {issued !== null ? (
          <section className="ppg-notice-issued" aria-labelledby={`${uid}-issued`}>
            <h3 id={`${uid}-issued`} className="ppg-notice-issued-title">
              Your {label.toLowerCase()} is on record
            </h3>
            <p className="ppg-notice-done" role="status">
              <Icon name="check" className="ppg-notice-icon ppg-notice-icon--verified" />
              <span>
                Every version of this paper will show it. The signed record is{" "}
                <span className="ppg-notice-id">{issued.id}</span>.
              </span>
            </p>
            <div className="ppg-notice-buttons">
              <button
                ref={done}
                type="button"
                className="ppg-notice-submit"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </section>
        ) : phase === "confirming" ? (
          <section className="ppg-notice-confirm" aria-labelledby={`${uid}-confirm`}>
            <h3 id={`${uid}-confirm`} className="ppg-notice-confirm-title">
              Confirm the {label.toLowerCase()}
            </h3>
            <p className="ppg-notice-confirm-text">{confirmation}</p>
            <p className="ppg-notice-confirm-reason">
              Readers will see: <q>{reason.trim()}</q>
            </p>
            <div className="ppg-notice-buttons">
              <button
                ref={safeAction}
                type="button"
                className="ppg-notice-close"
                onClick={() => setPhase("editing")}
              >
                Go back
              </button>
              <button
                type="button"
                className="ppg-notice-submit ppg-notice-submit--critical"
                onClick={() => void send()}
              >
                Yes, sign the {label.toLowerCase()}
              </button>
            </div>
          </section>
        ) : (
          <form
            className="ppg-notice-form"
            aria-labelledby={titleId}
            onSubmit={submitForm}
            noValidate
          >
            <fieldset className="ppg-notice-kinds">
              <legend className="ppg-notice-legend">What kind of notice?</legend>
              {NOTICE_KINDS.map((option, index) => (
                <label
                  key={option}
                  className="ppg-notice-kind"
                  data-selected={option === kind ? "true" : "false"}
                >
                  <input
                    ref={index === 0 ? firstKind : undefined}
                    className="ppg-notice-radio"
                    type="radio"
                    name="notice-kind"
                    value={option}
                    checked={option === kind}
                    disabled={busy}
                    onChange={() => {
                      setKind(option);
                      setFailed(null);
                    }}
                  />
                  <span className="ppg-notice-kind-text">
                    <span className="ppg-notice-kind-name">{NOTICE_LABELS[option]}</span>
                    <span className="ppg-notice-kind-hint">
                      {NOTICE_DESCRIPTIONS[option]}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="ppg-notice-label" htmlFor={`${uid}-reason`}>
              {NOTICE_REASON_LABEL}
            </label>
            <textarea
              ref={reasonField}
              id={`${uid}-reason`}
              className="ppg-notice-reason"
              name="reason"
              value={reason}
              rows={4}
              required
              readOnly={busy}
              aria-invalid={mistake !== null}
              aria-describedby={mistake !== null ? `${hintId} ${errorId}` : hintId}
              onChange={(event) => {
                setReason(event.target.value);
                if (mistake !== null) setMistake(null);
              }}
            />
            <p id={hintId} className="ppg-notice-hint">
              This is what readers see in the banner on every version of the
              paper, so write it for them.
            </p>

            {mistake !== null ? (
              <p id={errorId} className="ppg-notice-error" role="alert">
                <Icon name="alert" className="ppg-notice-icon ppg-notice-icon--critical" />
                <span>{mistake}</span>
              </p>
            ) : null}

            <div className="ppg-notice-buttons">
              <button
                type="submit"
                className="ppg-notice-submit"
                aria-disabled={busy}
              >
                {busy
                  ? "Signing…"
                  : confirmation !== null
                    ? NOTICE_REVIEW_LABEL
                    : NOTICE_SUBMIT_LABEL}
              </button>
              <button
                type="button"
                className="ppg-notice-close"
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) onClose();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {failed !== null ? (
          <p className="ppg-notice-error" role="alert">
            <Icon name="alert" className="ppg-notice-icon ppg-notice-icon--critical" />
            <span>
              {failed.message}
              {failed.signIn ? (
                <>
                  {" "}
                  <a className="ppg-notice-link" href={signInHref}>
                    Sign in
                  </a>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
