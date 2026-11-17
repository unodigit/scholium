"use client";

/**
 * **File an appeal** — an author’s signed answer to a moderation decision that
 * held or rejected their paper (MOD-2; the API side is
 * `apps/api/src/app/modules/appeals`).
 *
 * ```tsx
 * <AppealDialog paperId="sch:k3f9-q2xz-7mwd" paperCid="bafyrei…" />
 * ```
 *
 * The action is offered only when the paper’s **latest** moderation decision
 * is a `hold` or `reject` and that decision has not been appealed yet. Both
 * facts are in the public log: `GET /v1/export/paper/{id}/records` carries the
 * paper’s `moderation.decision` and `appeal` records, and this dialog joins
 * them (the same records `apps/web/src/features/mod-console/appeals.ts` reads,
 * without replaying the whole log). Nothing is guessed when the read fails: the
 * action simply is not offered.
 *
 * The appeal is a signed `appeal` record — `{target, grounds, paper}`, with
 * `target` the appealed decision’s cid — sent to `POST /v1/appeals`. A decision
 * can be appealed once, by an author of the paper, so the grounds are required
 * and read back before they are signed. The panel that decides it is drawn by
 * the node, not by this page.
 *
 * Offered only to a consented author (`paper-actions.tsx` reads that); the API
 * is the gate and answers `403` to anyone else and `409` to a second appeal.
 *
 * Accessibility (docs/design.md §9): a modal dialog named by its title, a
 * labelled grounds field whose mistake is announced, focus kept inside the
 * dialog, Escape and the scrim to close, focus back on the button that opened
 * it, and an icon plus words — never colour alone — for a failure or a success.
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
import { formatRemovalDate } from "./unlisted-paper";

/** The words on the action that opens the dialog. */
export const APPEAL_LABEL = "File an appeal";

/** The dialog's title. */
export const APPEAL_DIALOG_TITLE = "Appeal the moderation decision";

/** The record type an appeal signs. */
export const APPEAL_TYPE = "appeal";

/** `POST` path (relative to `/v1`) for appeals. */
export const APPEALS_ENDPOINT = "/appeals";

/** The moderation actions an author may appeal. */
export const APPEALABLE_ACTIONS = ["hold", "reject"] as const;

/** One appealable moderation action. */
export type AppealableAction = (typeof APPEALABLE_ACTIONS)[number];

/** How the decision reads in the dialog, from the author's side. */
export const APPEAL_ACTION_LABELS: Readonly<Record<AppealableAction, string>> = {
  hold: "held this paper from listing",
  reject: "rejected this paper",
};

/** The field the author writes their grounds in. */
export const APPEAL_GROUNDS_LABEL = "Grounds for appeal";

/** What is wrong when the grounds are blank. */
export const APPEAL_EMPTY_GROUNDS =
  "Say why the decision should be reconsidered. The panel reads this.";

/** The button that signs and sends the appeal. */
export const APPEAL_SUBMIT_LABEL = "Sign and file appeal";

/** Said after every refusal, so no one wonders whether it went through. */
export const NOT_APPEALED = "No appeal was filed.";

/** One `moderation.decision` from the paper's public records. */
export interface AppealableDecision {
  /** cid of the `moderation.decision`; `body.target` of the appeal. */
  readonly decisionCid: string;
  readonly action: AppealableAction;
  /** The policy clause the decision cited, when it named one. */
  readonly clause: string | null;
  /** The reason the moderator gave the authors. */
  readonly reason: string | null;
  /** cid of the version it decided, when the record names one. */
  readonly versionCid: string | null;
  /** The moderator who signed it. */
  readonly moderatorDid: string | null;
}

/** The body of a signed `appeal` record. */
export interface AppealBody {
  /** cid of the `moderation.decision` being appealed. */
  readonly target: string;
  /** Why the decision should be reconsidered. */
  readonly grounds: string;
  /** cid of the paper’s genesis record. */
  readonly paper: string;
  /** Envelope bodies are open objects; later features may add fields. */
  readonly [key: string]: unknown;
}

/** Build the signed record’s body, trimming the grounds a field carries. */
export function appealBody(
  decisionCid: string,
  paperCid: string,
  grounds: string,
): AppealBody {
  return { target: decisionCid, grounds: grounds.trim(), paper: paperCid };
}

/** Signs an appeal body; {@link signAppeal} by default. */
export type SignAppeal = (body: AppealBody) => Promise<SignedRecord>;

/** Sends a signed appeal; {@link submitAppeal} by default. */
export type SubmitAppeal = (record: SignedRecord) => Promise<AppealAccepted>;

/** What the node answered for an accepted appeal. */
export interface AppealAccepted {
  /** cid of the appeal record (`GET /v1/records/{id}` serves it). */
  readonly id: string;
  /** `pending` until a panel decides it. */
  readonly status: string | null;
}

/** The node’s records for one paper; {@link loadAppealableDecision} by default. */
export type LoadAppealableDecision = (
  paperId: string,
  signal?: AbortSignal,
) => Promise<AppealableDecision | null>;

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actionOf(value: unknown): AppealableAction | null {
  return value === "hold" || value === "reject" ? value : null;
}

/**
 * Join the paper’s public records into the decision an author may appeal.
 *
 * The latest `moderation.decision` (by `seq`, the order the node appended
 * them) decides: a later `list`, `reclassify` or `release` supersedes an
 * earlier hold or reject. It must be a hold or reject and must not already
 * have an `appeal` whose `target` is its cid — a decision is appealed once.
 * Entries this page cannot read are skipped, never guessed.
 */
export function latestAppealableDecision(
  entries: readonly unknown[],
): AppealableDecision | null {
  const appealed = new Set<string>();
  let latest:
    | {
        seq: number;
        decisionCid: string;
        action: string;
        clause: string | null;
        reason: string | null;
        versionCid: string | null;
        moderatorDid: string | null;
      }
    | null = null;

  for (const item of entries) {
    if (!isRecord(item)) continue;
    const type = readText(item.record_type);
    const cid = readText(item.record_cid) ?? readText(item.id);
    if (type === null || cid === null) continue;

    if (type === "appeal" && isRecord(item.body)) {
      const target =
        readText(item.body.target) ?? readText(item.body.decision);
      if (target !== null) appealed.add(target);
      continue;
    }
    if (type !== "moderation.decision" || !isRecord(item.body)) continue;

    const action = readText(item.body.action);
    if (action === null) continue;
    const seq =
      typeof item.seq === "number" && Number.isFinite(item.seq) ? item.seq : 0;
    if (latest !== null && seq < latest.seq) continue;

    latest = {
      seq,
      decisionCid: cid,
      action,
      clause: readText(item.body.clause),
      reason: readText(item.body.reason),
      versionCid: readText(item.body.target),
      moderatorDid: readText(item.author_did) ?? readText(item.author),
    };
  }

  // The latest decision is the one that stands: a later list, reclassify or
  // release leaves nothing to appeal.
  if (latest === null || appealed.has(latest.decisionCid)) {
    return null;
  }
  const appealable = actionOf(latest.action);
  if (appealable === null) return null;
  return {
    decisionCid: latest.decisionCid,
    action: appealable,
    clause: latest.clause,
    reason: latest.reason,
    versionCid: latest.versionCid,
    moderatorDid: latest.moderatorDid,
  };
}

/**
 * Read the paper’s records and return the decision an author may appeal now,
 * or `null`. Reading is public, so no token is sent, and nothing is cached: a
 * decision made a moment ago changes the answer.
 */
export async function loadAppealableDecision(
  paperId: string,
  signal?: AbortSignal,
  client: Pick<ApiClient, "get"> = api,
): Promise<AppealableDecision | null> {
  const payload = await client.get<unknown>(
    `/export/paper/${encodeURIComponent(paperId)}/records`,
    { auth: false, cache: "no-store", signal },
  );
  if (!Array.isArray(payload)) return null;
  return latestAppealableDecision(payload);
}

/** Read the `201` body; everything missing falls back to what was signed. */
export function parseAppealAccepted(
  payload: unknown,
  fallbackId: string,
): AppealAccepted {
  const body = isRecord(payload) ? payload : {};
  return {
    id: readText(body.id) ?? readText(body.record_id) ?? fallbackId,
    status: readText(body.status),
  };
}

/* -------------------------------------------------------------------------- */
/* The appeal a decision already has                                           */
/* -------------------------------------------------------------------------- */

/** The decision a page is about: its cid and the action it took. */
export interface DecisionRef {
  /** cid of the `moderation.decision`. */
  readonly decisionCid: string;
  /** The action it took (`hold`, `reject`, `release`, …). */
  readonly action: string;
}

/** An appeal the paper's public records hold, with the panel's verdict. */
export interface FiledAppeal {
  /** cid of the `appeal` record. */
  readonly appealCid: string;
  /** cid of the `moderation.decision` it appeals. */
  readonly decisionCid: string;
  /** When the node received the appeal (ISO), when the record says. */
  readonly filedAt: string | null;
  /** The panel's outcome, or `null` while the appeal awaits one. */
  readonly outcome: string | null;
  /** cid of the deciding `appeal.decision`, once there is one. */
  readonly verdictCid: string | null;
  /** When the node received the panel's decision (ISO), when it says. */
  readonly decidedAt: string | null;
}

function seqOf(item: Record<string, unknown>): number {
  return typeof item.seq === "number" && Number.isFinite(item.seq) ? item.seq : 0;
}

/**
 * The appeal of `decision` in the paper's public records, or `null`.
 *
 * A decision is appealed once, so an `appeal` whose `target` is its cid is the
 * appeal — and an `appeal.decision` targeting that appeal is the panel's
 * verdict (the same join `apps/web/src/features/mod-console/appeals.ts` makes).
 * An overturn appends a `release` that restores the version: the hold is then
 * no longer the standing decision, and the appeal is found through the release
 * record's `appeal` field instead. Entries the page cannot read are skipped,
 * never guessed.
 */
export function filedAppeal(
  entries: readonly unknown[],
  decision: DecisionRef | null,
): FiledAppeal | null {
  if (decision === null) return null;

  const appeals = new Map<
    string,
    { decisionCid: string; filedAt: string | null; seq: number }
  >();
  const verdicts = new Map<
    string,
    { cid: string; outcome: string; decidedAt: string | null; seq: number }
  >();
  let restoredAppeal: string | null = null;

  for (const item of entries) {
    if (!isRecord(item)) continue;
    const type = readText(item.record_type);
    const cid = readText(item.record_cid) ?? readText(item.id);
    if (type === null || cid === null || !isRecord(item.body)) continue;

    if (type === "appeal") {
      const target = readText(item.body.target) ?? readText(item.body.decision);
      if (target === null) continue;
      const seq = seqOf(item);
      const seen = appeals.get(cid);
      if (seen !== undefined && seen.seq > seq) continue;
      appeals.set(cid, {
        decisionCid: target,
        filedAt: readText(item.received_at ?? item.receivedAt),
        seq,
      });
      continue;
    }

    if (type === "appeal.decision") {
      const target =
        readText(item.body.target) ?? readText(item.body.appeal);
      const outcome = readText(item.body.outcome);
      if (target === null || outcome === null) continue;
      const seq = seqOf(item);
      const seen = verdicts.get(target);
      if (seen !== undefined && seen.seq <= seq) continue;
      verdicts.set(target, {
        cid,
        outcome,
        decidedAt: readText(item.received_at ?? item.receivedAt),
        seq,
      });
      continue;
    }

    if (type === "moderation.decision" && cid === decision.decisionCid) {
      // The restoring `release` names the appeal whose overturn it applies.
      restoredAppeal =
        readText(item.body.appeal) ?? readText(item.body.appeal_restoration);
    }
  }

  let wanted: {
    cid: string;
    decisionCid: string;
    filedAt: string | null;
    seq: number;
  } | null = null;

  if (decision.action === "release") {
    const restored = restoredAppeal === null ? undefined : appeals.get(restoredAppeal);
    if (restored !== undefined && restoredAppeal !== null) {
      wanted = { cid: restoredAppeal, ...restored };
    }
  } else {
    // A decision is appealed once; should a log hold more, the newest stands.
    for (const [cid, appeal] of appeals) {
      if (appeal.decisionCid !== decision.decisionCid) continue;
      if (wanted === null || appeal.seq > wanted.seq) {
        wanted = { cid, ...appeal };
      }
    }
  }

  if (wanted === null) return null;
  const verdict = verdicts.get(wanted.cid) ?? null;

  return {
    appealCid: wanted.cid,
    decisionCid: wanted.decisionCid,
    filedAt: wanted.filedAt,
    outcome: verdict?.outcome ?? null,
    verdictCid: verdict?.cid ?? null,
    decidedAt: verdict?.decidedAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* A filing the page can hear                                                  */
/* -------------------------------------------------------------------------- */

/** An appeal one of this paper's dialogs just had accepted. */
export interface AppealFiledEvent {
  /** The paper the appeal belongs to, so only its banner answers. */
  readonly paperId: string;
  /** The appeal as the reloaded records would report it. */
  readonly appeal: FiledAppeal;
}

type AppealFiledListener = (event: AppealFiledEvent) => void;

const appealFiledListeners = new Set<AppealFiledListener>();

/**
 * Hear about an appeal accepted while the page is open.
 *
 * The banner above the paper is assembled from the public records at load
 * time. Filing an appeal appends a record, so without this the banner behind
 * the dialog would keep saying "You can appeal once." until a reload. The
 * listener gets the filed appeal in the same shape `filedAppeal` reads from the
 * records, so the banner can say exactly what the reload says. Returns the
 * unsubscribe function.
 */
export function subscribeAppealFiled(
  listener: AppealFiledListener,
): () => void {
  appealFiledListeners.add(listener);
  return () => {
    appealFiledListeners.delete(listener);
  };
}

/** Tell the page an appeal was just accepted (called by the dialog). */
export function announceAppealFiled(
  paperId: string,
  appeal: FiledAppeal,
): void {
  for (const listener of [...appealFiledListeners]) {
    listener({ paperId, appeal });
  }
}

/**
 * How a panel's outcome reads after "the panel" in the author's banner.
 * The vocabulary is `appeal.decision`'s schema enum.
 */
const OUTCOME_PHRASES: Readonly<Record<string, string>> = {
  upheld: "upheld the decision",
  overturned: "overturned the decision",
  modified: "modified the decision",
  remanded: "sent the decision back to the moderators",
  granted: "granted the appeal",
  grant: "granted the appeal",
  denied: "denied the appeal",
  deny: "denied the appeal",
  allowed: "allowed the appeal",
  dismissed: "dismissed the appeal",
};

/**
 * The banner sentence for a filed appeal: when it was filed and whether a
 * panel is still to decide it, or the panel's outcome. Dates read as the paper
 * page writes them (`5 March 2027`).
 */
export function appealStatus(appeal: FiledAppeal): string {
  const filed = formatRemovalDate(appeal.filedAt);
  const opened = filed === null ? "Appeal filed" : `Appeal filed on ${filed}`;
  if (appeal.outcome === null) {
    return `${opened} — awaiting panel.`;
  }
  const decided = formatRemovalDate(appeal.decidedAt);
  const phrase =
    OUTCOME_PHRASES[appeal.outcome] ??
    `recorded the outcome “${appeal.outcome}”`;
  return `${opened} — the panel ${phrase}${decided === null ? "" : ` on ${decided}`}.`;
}


/**
 * Sign an `appeal` with the device key behind a passkey prompt.
 *
 * `prev` is `null`: an appeal is a record of its own, appended to the public
 * log, not the next link in the paper’s chain.
 */
export async function signAppeal(body: AppealBody): Promise<SignedRecord> {
  return signRecord(APPEAL_TYPE, body, null, { reason: "Sign and file appeal" });
}

/** Post a signed appeal to `POST /v1/appeals`. */
export async function submitAppeal(
  record: SignedRecord,
  client: Pick<ApiClient, "post"> = api,
): Promise<AppealAccepted> {
  const payload = await client.post<unknown>(APPEALS_ENDPOINT, record);
  return parseAppealAccepted(payload, record.id);
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                     */
/* -------------------------------------------------------------------------- */

/** What the dialog shows when filing fails: a sentence and an optional sign-in. */
export interface AppealFailure {
  readonly message: string;
  readonly signIn: boolean;
}

function failure(message: string, signIn = false): AppealFailure {
  return { message, signIn };
}

/** A sentence from the node's own words, ending in a full stop. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One plain-language failure for whatever filing threw. */
export function describeAppealError(error: unknown): AppealFailure {
  const nothing = NOT_APPEALED;
  const cancelled = `Signing was cancelled, so no appeal was filed. Sign again when you are ready.`;

  if (isPasskeyCancellation(error)) {
    return failure(cancelled);
  }
  if (isRecordSigningError(error)) {
    return failure("The appeal record could not be prepared, so nothing was signed or sent.");
  }
  if (isDeviceKeyError(error)) {
    if (error.code === "passkey-cancelled") {
      return failure(cancelled);
    }
    return failure(
      error.code === "not-found"
        ? `This device has no signing key, so it cannot sign the appeal. ${nothing}`
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
            detail || "Only an author of this paper may appeal this decision",
          )} ${nothing}`,
        );
      case 404:
        return failure(
          `This node could not find the decision. ${nothing} Reload the page and try again.`,
        );
      case 409:
        return failure(
          `${sentence(
            detail || "This decision has already been appealed; a decision can be appealed once",
          )} ${nothing}`,
        );
      case 422:
        return failure(
          `${sentence(detail || "The node did not accept the appeal")} ${nothing} Check the grounds and try again.`,
        );
      default:
        if (error.status >= 500) {
          return failure(
            "Scholium could not save the appeal just now, so it is not confirmed as filed. Try again in a moment.",
          );
        }
        return failure(
          `${sentence(detail || error.title || "The node refused the appeal")} ${nothing}`,
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
      : `The appeal could not be filed. ${nothing}`,
  );
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                   */
/* -------------------------------------------------------------------------- */

/** What can take focus inside the dialog, for keeping Tab inside it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "editing" | "signing" | "filed";

export interface AppealDialogProps {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** cid of the paper’s genesis record: `body.paper`. */
  readonly paperCid: string;
  /** Replace the records read, for tests. */
  readonly load?: LoadAppealableDecision;
  /** Replace the signing and sending seams, for tests. */
  readonly sign?: SignAppeal;
  readonly submit?: SubmitAppeal;
  /** Where “Sign in” goes when a session has ended. */
  readonly signInHref?: string;
}

const DEFAULT_SIGN_IN_HREF = "/signin";

export function AppealDialog({
  paperId,
  paperCid,
  load = loadAppealableDecision,
  sign = signAppeal,
  submit = submitAppeal,
  signInHref = DEFAULT_SIGN_IN_HREF,
}: AppealDialogProps) {
  const [decision, setDecision] = useState<AppealableDecision | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await load(paperId, controller.signal);
        if (!cancelled) setDecision(found);
      } catch {
        // Not offered when the records cannot be read; the action is a
        // convenience, and the API is the gate.
        if (!cancelled) setDecision(null);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [load, paperId]);

  if (decision === null) return null;
  return (
    <AppealButton
      paperId={paperId}
      paperCid={paperCid}
      decision={decision}
      sign={sign}
      submit={submit}
      signInHref={signInHref}
    />
  );
}

interface AppealButtonProps {
  readonly paperId: string;
  readonly paperCid: string;
  readonly decision: AppealableDecision;
  readonly sign: SignAppeal;
  readonly submit: SubmitAppeal;
  readonly signInHref: string;
}

function AppealButton(props: AppealButtonProps) {
  const { paperId } = props;
  const [open, setOpen] = useState(false);
  // A decision can be appealed once: once this dialog has filed it, the action
  // is not offered again, exactly as after a reload. It stays mounted while
  // the "Your appeal is filed" panel is open.
  const [filed, setFiled] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      subscribeAppealFiled((event) => {
        if (event.paperId === paperId) setFiled(true);
      }),
    [paperId],
  );

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  if (filed && !open) return null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ppg-action"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {APPEAL_LABEL}
      </button>
      {open ? <AppealPanel {...props} onClose={close} /> : null}
    </>
  );
}

interface AppealPanelProps extends AppealButtonProps {
  readonly onClose: () => void;
}

function AppealPanel({
  paperId,
  paperCid,
  decision,
  sign,
  submit,
  signInHref,
  onClose,
}: AppealPanelProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const ledeId = `${uid}-lede`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const panel = useRef<HTMLDivElement>(null);
  const groundsField = useRef<HTMLTextAreaElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  const [grounds, setGrounds] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [mistake, setMistake] = useState<string | null>(null);
  const [failed, setFailed] = useState<AppealFailure | null>(null);
  const [filed, setFiled] = useState<AppealAccepted | null>(null);

  const sending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    if (phase === "editing" && mistake === null) groundsField.current?.focus();
    if (phase === "filed") done.current?.focus();
  }, [phase, mistake]);

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

  const send = async (): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setFailed(null);
    setPhase("signing");
    try {
      const body = appealBody(decision.decisionCid, paperCid, grounds);
      const record = await sign(body);
      if (record.type !== APPEAL_TYPE) {
        throw new Error(
          `The signer produced a ${record.type} record, not an appeal record.`,
        );
      }
      const accepted = await submit(record);
      if (!mounted.current) return;
      setFiled(accepted);
      setPhase("filed");
      // The banner behind this dialog reads the same facts from the records on
      // a reload; hand them over now so it does not lag behind the dialog.
      announceAppealFiled(paperId, {
        appealCid: accepted.id,
        decisionCid: decision.decisionCid,
        filedAt: new Date().toISOString(),
        outcome: null,
        verdictCid: null,
        decidedAt: null,
      });
    } catch (error) {
      if (!mounted.current) return;
      setFailed(describeAppealError(error));
      setPhase("editing");
    } finally {
      sending.current = false;
    }
  };

  const submitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    setFailed(null);
    if (grounds.trim() === "") {
      setMistake(APPEAL_EMPTY_GROUNDS);
      return;
    }
    setMistake(null);
    void send();
  };

  const action = APPEAL_ACTION_LABELS[decision.action];

  return createPortal(
    <div
      className="ppg-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        className="ppg-dialog ppg-appeal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ledeId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <div className="ppg-dialog-header">
          <h2 id={titleId} className="ppg-dialog-title">
            {APPEAL_DIALOG_TITLE}
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
          A moderator {action}
          {decision.clause !== null ? <> under policy {decision.clause}</> : null}
          . A panel of three members who were not involved decides the appeal.
          A decision can be appealed once.
        </p>

        {decision.reason !== null ? (
          <blockquote className="ppg-appeal-decision">
            <p className="ppg-appeal-decision-label">The moderator’s reason</p>
            <p className="ppg-appeal-decision-text">{decision.reason}</p>
          </blockquote>
        ) : null}

        {filed !== null ? (
          <section className="ppg-appeal-filed" aria-labelledby={`${uid}-filed`}>
            <h3 id={`${uid}-filed`} className="ppg-appeal-filed-title">
              Your appeal is filed
            </h3>
            <p className="ppg-appeal-done" role="status">
              <Icon name="check" className="ppg-appeal-icon ppg-appeal-icon--verified" />
              <span>
                A panel will be drawn to decide it. The signed record is{" "}
                <span className="ppg-notice-id">{filed.id}</span>.
              </span>
            </p>
            <div className="ppg-appeal-buttons">
              <button
                ref={done}
                type="button"
                className="ppg-appeal-submit"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </section>
        ) : (
          <form
            className="ppg-appeal-form"
            aria-labelledby={titleId}
            onSubmit={submitForm}
            noValidate
          >
            <label className="ppg-appeal-label" htmlFor={`${uid}-grounds`}>
              {APPEAL_GROUNDS_LABEL}
            </label>
            <textarea
              ref={groundsField}
              id={`${uid}-grounds`}
              className="ppg-appeal-grounds"
              name="grounds"
              value={grounds}
              rows={5}
              required
              readOnly={busy}
              aria-invalid={mistake !== null}
              aria-describedby={mistake !== null ? `${hintId} ${errorId}` : hintId}
              onChange={(event) => {
                setGrounds(event.target.value);
                if (mistake !== null) setMistake(null);
              }}
            />
            <p id={hintId} className="ppg-appeal-hint">
              This is signed into the public record and read by the panel, so
              say what the decision got wrong.
            </p>

            {mistake !== null ? (
              <p id={errorId} className="ppg-appeal-error" role="alert">
                <Icon name="alert" className="ppg-appeal-icon ppg-appeal-icon--critical" />
                <span>{mistake}</span>
              </p>
            ) : null}

            <div className="ppg-appeal-buttons">
              <button
                type="submit"
                className="ppg-appeal-submit"
                aria-disabled={busy}
              >
                {busy ? "Signing…" : APPEAL_SUBMIT_LABEL}
              </button>
              <button
                type="button"
                className="ppg-appeal-close"
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
          <p className="ppg-appeal-error" role="alert">
            <Icon name="alert" className="ppg-appeal-icon ppg-appeal-icon--critical" />
            <span>
              {failed.message}
              {failed.signIn ? (
                <>
                  {" "}
                  <a className="ppg-appeal-link" href={signInHref}>
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
