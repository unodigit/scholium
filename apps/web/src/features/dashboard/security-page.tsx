"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ApiError, apiClient, tokenStore } from "../../lib/api";
import { EmptyState, RecordLink } from "../ui-kit";
import {
  RECOVER_PATH,
  deviceKey,
  isGuardianSaveError,
  isPasskeyCancellation,
  saveGuardians as saveGuardiansSigned,
  type GuardianProblem,
} from "../web-auth";

import { ME_PATH } from "./dashboard";
import { Card } from "./dashboard-page";
import {
  ROTATION_REASON_MAX_LENGTH,
  TERMINAL_ROTATION_CODES,
  describeRotationError,
  isRotationError,
  rotateKey as defaultRotateKey,
  type RotateKey,
} from "./rotate-key";
import {
  GUARDIANS_SETUP_HREF,
  GUARDIAN_SCHEME,
  GUARDIAN_THRESHOLD,
  GUARDIAN_TOTAL,
  SECURITY_SIGNIN_HREF,
  SECURITY_TITLE,
  describeGuardianSource,
  describeGuardians,
  describeSecurityError,
  formatDay,
  formatInstant,
  guardiansComplete,
  RECOVERY_REQUESTS_ENDPOINT,
  loadProfileNames,
  loadSecurity as fetchSecurity,
  type DeviceInfo,
  type GuardianState,
  type KeyRotation,
  type RecoveryRequestSummary,
  type SecurityData,
} from "./security";
import { eraseProfile as defaultEraseProfile } from "./profile";
import "./dashboard-page.css";
import "./security-page.css";

/** Loads the security screen; replaceable in tests. */
export type LoadSecurity = () => Promise<SecurityData>;

/**
 * Saves a replacement guardian list, signed by this device's key.
 *
 * {@link GuardiansCard} calls this; the default prompts for the passkey and
 * sends the detached signature the API needs to redirect a saved set.
 */
export type SaveGuardians = (did: string, values: readonly string[]) => Promise<string[]>;

/** The default: sign the new list with this device's key, behind a passkey. */
function saveGuardiansWithPasskey(did: string, values: readonly string[]): Promise<string[]> {
  return saveGuardiansSigned(apiClient, did, values, { signer: deviceKey });
}

/** The default: cancel a recovery using the signed-in session. */
function defaultCancelRecovery(requestId: string): Promise<void> {
  return apiClient.post<void>(
    `${RECOVERY_REQUESTS_ENDPOINT}/${encodeURIComponent(requestId)}/cancel`,
    {},
    { auth: true },
  ).then(() => undefined);
}

/** Props for {@link SecurityPage}. Everything is optional. */
export interface SecurityPageProps {
  /** Security data already in hand (tests, or a server route that fetched it). */
  initialSecurity?: SecurityData;
  /** Replace the loader, for tests or an alternate API client. */
  loadSecurity?: LoadSecurity;
  /** Replace the rotation, for tests. */
  rotate?: RotateKey;
  /** Replace the profile erasure, for tests. */
  eraseProfile?: (did: string) => Promise<void>;
  /** Replace the signed guardian save, for tests. */
  saveGuardians?: SaveGuardians;
  /** Replace the recovery cancel, for tests. */
  cancelRecovery?: (requestId: string) => Promise<void>;
  /**
   * Called once the key has changed. The default reloads the page: the app's
   * in-memory device key still holds the old key until it is read again.
   */
  onRotated?: () => void;
  /** Pin the sign-in state. When omitted it is read from the shared token store. */
  signedIn?: boolean;
}

type SecurityState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SecurityData };

/** `did:key:z6Mk…AbCdEf`, short enough to sit beside a name. */
export function shortDid(did: string): string {
  return did.length <= 24 ? did : `${did.slice(0, 16)}…${did.slice(-6)}`;
}

function reloadPage(): void {
  globalThis.location?.reload();
}

function rotatedRedirect(): void {
  if (typeof globalThis.location !== "undefined") {
    globalThis.location.href = "/signin?rotated=1";
  }
}

/** `/me/security`: devices, recovery guardians, last key rotation, Rotate key. */
export function SecurityPage({
  initialSecurity,
  loadSecurity,
  rotate = defaultRotateKey,
  eraseProfile = defaultEraseProfile,
  saveGuardians = saveGuardiansWithPasskey,
  cancelRecovery = defaultCancelRecovery,
  onRotated = rotatedRedirect,
  signedIn,
}: SecurityPageProps = {}) {
  const [state, setState] = useState<SecurityState>(() =>
    initialSecurity ? { status: "ready", data: initialSecurity } : { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "signed-out" });
      return;
    }
    if (initialSecurity && attempt === 0) {
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    (loadSecurity ?? fetchSecurity)().then(
      (data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeSecurityError(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, initialSecurity, loadSecurity, signedIn]);

  return (
    <div className="db-page">
      <SecurityHeader />

      {state.status === "signed-out" ? (
        <div className="db-notice" role="alert">
          <h2 className="db-notice-title">Sign in to continue</h2>
          <p className="db-notice-text">Your security settings are private to your account.</p>
          <a className="db-button" href={SECURITY_SIGNIN_HREF}>
            Sign in
          </a>
        </div>
      ) : null}

      {state.status === "loading" ? (
        <p className="db-loading" role="status">
          Loading your security settings…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="db-notice" role="alert">
          <h2 className="db-notice-title">Couldn&rsquo;t load your security settings</h2>
          <p className="db-notice-text">{state.message}</p>
          <button type="button" className="db-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <>
          <div className="db-grid">
            <DevicesCard data={state.data} />
            <GuardiansCard
              did={state.data.did}
              guardians={state.data.guardians}
              names={state.data.profileNames}
              saveGuardians={saveGuardians}
            />
            <RecoveryRequestsCard
              requests={(state.data.recoveryRequests ?? []).filter(
                (request) => !isOwnRecovery(request, state.data.did),
              )}
              names={state.data.profileNames}
            />
            <RecoveryInProgressCard
              requests={(state.data.recoveryRequests ?? []).filter((request) =>
                isOwnRecovery(request, state.data.did),
              )}
              cancelRecovery={cancelRecovery}
            />
            <KeyRotationCard data={state.data} rotate={rotate} onRotated={onRotated} />
          </div>
          <EraseProfileCard did={state.data.did} eraseProfile={eraseProfile} />
        </>
      ) : null}
    </div>
  );
}

function SecurityHeader() {
  return (
    <header className="db-header">
      <p className="db-kicker mono-id">scholium / me / security</p>
      <h1 className="db-title">{SECURITY_TITLE}</h1>
      <p className="db-lede">
        The device that holds your key, the guardians who can help you recover it, and
        when it last changed.
      </p>
      <a className="db-link" href={ME_PATH}>
        Back to your dashboard
      </a>
    </header>
  );
}

// ---- Devices ---------------------------------------------------------------

function DevicesCard({ data }: { data: SecurityData }) {
  return (
    <Card title="Devices" anchor="devices">
      {data.devices.length > 0 ? (
        <ul className="db-list">
          {data.devices.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      ) : data.devicesReadable ? (
        <EmptyState
          sentence="This browser holds no signing key."
          action={{ label: "Sign in", href: SECURITY_SIGNIN_HREF }}
        />
      ) : (
        <p className="db-note" role="status">
          This browser&rsquo;s key store could not be read, so its key is not shown.
          Storage may be blocked in this window.
        </p>
      )}
      <p className="db-cred-note meta">Scholium lists the key held by this device.</p>
    </Card>
  );
}

function DeviceRow({ device }: { device: DeviceInfo }) {
  const created = formatDay(device.createdAt);
  return (
    <li className="db-device">
      <div className="db-device-head">
        <span className="db-device-name">This device</span>
        <span className="db-chip" data-tone={device.holdsActiveKey ? "verified" : "pending"}>
          {device.holdsActiveKey ? "Active signing key" : "Not the active key"}
        </span>
      </div>
      <p className="db-device-meta meta">
        {created ? `Passkey created ${created}` : "Passkey creation date unknown"}
      </p>
      <p className="db-cred-id mono-id">{device.did}</p>
      {device.holdsActiveKey ? null : (
        <p className="db-note">
          Your account now signs with a different key, so this device cannot sign for it.
        </p>
      )}
    </li>
  );
}

// ---- Recovery guardians ----------------------------------------------------

type GuardiansPhase = "idle" | "editing" | "working";

/** Five field values: the saved list, with blanks for the gaps. */
function guardianFields(dids: readonly string[]): string[] {
  return Array.from({ length: GUARDIAN_TOTAL }, (_, index) => dids[index] ?? "");
}

/** The page's words for a guardian change that did not go through. */
function describeGuardiansChangeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return "Your session has ended. Sign in again to change your guardians.";
    }
    return error.detail || error.title;
  }
  if (isPasskeyCancellation(error)) {
    return "Cancelled. Your guardians are unchanged.";
  }
  const detail =
    error instanceof Error && error.message
      ? error.message
      : "Could not change your guardians.";
  const sentence = /[.!?]$/.test(detail) ? detail : `${detail}.`;
  return `${sentence} Your guardians are unchanged.`;
}

function GuardiansCard({
  did,
  guardians,
  names,
  saveGuardians = saveGuardiansWithPasskey,
}: {
  did: string;
  guardians: GuardianState;
  names?: Readonly<Record<string, string>>;
  saveGuardians?: SaveGuardians;
}) {
  const [phase, setPhase] = useState<GuardiansPhase>("idle");
  const [current, setCurrent] = useState<string[]>(() => [...guardians.dids]);
  const [values, setValues] = useState<string[]>(() => guardianFields(guardians.dids));
  const [problems, setProblems] = useState<GuardianProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [namesState, setNamesState] = useState<Record<string, string>>(() => ({ ...(names ?? {}) }));

  const headingId = useId();
  const fieldId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);
  const previous = useRef<GuardiansPhase>("idle");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A reload or retry replaced the loaded list: follow it.
  useEffect(() => {
    setCurrent([...guardians.dids]);
    setValues(guardianFields(guardians.dids));
  }, [guardians.dids]);

  useEffect(() => {
    setNamesState({ ...(names ?? {}) });
  }, [names]);

  // Move focus with the interface, as Rotate key does: into the form when it
  // opens, back to the button when it closes.
  useEffect(() => {
    if (phase === "editing" && previous.current === "idle") {
      headingRef.current?.focus();
    }
    if (phase === "idle" && previous.current !== "idle") {
      triggerRef.current?.focus();
    }
    // A rejected entry takes focus once the fields are enabled again, so its
    // message is read, the way a failed native submit focuses the first
    // invalid field.
    if (phase === "editing" && pendingFocus.current !== null) {
      const index = pendingFocus.current;
      pendingFocus.current = null;
      fieldRefs.current[index]?.focus();
    }
    previous.current = phase;
  }, [phase]);

  function open() {
    setValues(guardianFields(current));
    setProblems([]);
    setError(null);
    setSaved(null);
    setPhase("editing");
  }

  function setValue(index: number, value: string) {
    setValues((list) => list.map((entry, at) => (at === index ? value : entry)));
    setProblems((list) => list.filter((problem) => problem.index !== index));
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "working") {
      return;
    }
    setPhase("working");
    setProblems([]);
    setError(null);
    try {
      const next = await saveGuardians(did, values);
      if (!mounted.current) {
        return;
      }
      setCurrent(next);
      setValues(next);
      setSaved("Guardians updated. Scholium has told you about the change.");
      void loadProfileNames(next).then((fetched) => {
        if (mounted.current) {
          setNamesState((prev) => ({ ...prev, ...fetched }));
        }
      });
      setPhase("idle");
    } catch (failure) {
      if (!mounted.current) {
        return;
      }
      if (isGuardianSaveError(failure)) {
        setProblems(failure.problems);
        const first = failure.problems.find((problem) => problem.index !== null)?.index;
        pendingFocus.current = first === undefined ? null : first;
      } else {
        pendingFocus.current = null;
        setError(describeGuardiansChangeError(failure));
      }
      setPhase("editing");
    }
  }

  // What the card shows after a save is the server's answer, not the old prop.
  const shown: GuardianState =
    saved === null
      ? { ...guardians, dids: current }
      : { ...guardians, dids: current, source: "server" };
  const source = describeGuardianSource(shown);
  const working = phase === "working";
  const listProblem = problems.find((problem) => problem.index === null);

  return (
    <Card title="Recovery guardians" anchor="guardians">
      <p className="db-stat">
        <span className="db-stat-value">{GUARDIAN_SCHEME}</span>
        <span className="db-stat-label meta">guardians approve a recovery</span>
      </p>
      <p className="db-cred-note meta">
        If you lose your device, any {GUARDIAN_THRESHOLD} of your {GUARDIAN_TOTAL} guardians
        can approve a new key. A 72-hour safety window follows.
      </p>
      <p className="db-guardian-status">{describeGuardians(shown)}</p>
      {current.length > 0 ? (
        <ol className="db-guardians" aria-label="Your recovery guardians">
          {current.map((guardianDid) => {
            const name = namesState?.[guardianDid];
            return (
              <li className="db-guardian" key={guardianDid}>
                {name ? <span className="db-guardian-name">{name}</span> : null}
                <span className="db-cred-id mono-id db-guardian-did" title={guardianDid}>
                  {shortDid(guardianDid)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {source ? <p className="db-cred-note meta">{source}</p> : null}
      {guardiansComplete(shown) ? null : (
        <a className="db-button" href={GUARDIANS_SETUP_HREF}>
          Set recovery guardians
        </a>
      )}

      {phase === "idle" ? (
        current.length > 0 ? (
          <div className="db-rotate-action">
            <button type="button" className="db-button" ref={triggerRef} onClick={open}>
              Change guardians
            </button>
            {saved ? (
              <p className="db-note" role="status">
                {saved}
              </p>
            ) : null}
          </div>
        ) : null
      ) : (
        <form className="db-rotate" aria-labelledby={headingId} onSubmit={confirm}>
          <h3 className="db-rotate-title" id={headingId} tabIndex={-1} ref={headingRef}>
            Change your recovery guardians?
          </h3>
          <p className="db-rotate-text">
            Replace any of the five. Saving asks for your passkey: this device signs the new
            list with your account&rsquo;s key, so a stolen session alone cannot redirect your
            recovery. Scholium tells you about every change.
          </p>
          {values.map((value, index) => {
            const problem = problems.find((entry) => entry.index === index);
            const inputId = `${fieldId}-guardian-${index}`;
            return (
              <div className="db-field" key={inputId}>
                <label className="db-field-label" htmlFor={inputId}>
                  Guardian {index + 1}
                </label>
                <input
                  id={inputId}
                  className="db-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="did:key:z6Mk…"
                  value={value}
                  disabled={working}
                  ref={(element) => {
                    fieldRefs.current[index] = element;
                  }}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? `${inputId}-problem` : undefined}
                  onChange={(event) => setValue(index, event.target.value)}
                />
                {problem ? (
                  <p className="db-error" id={`${inputId}-problem`}>
                    {problem.message}
                  </p>
                ) : null}
              </div>
            );
          })}
          {listProblem ? (
            <p className="db-error" role="alert">
              {listProblem.message}
            </p>
          ) : null}
          {error ? (
            <p className="db-error" role="alert">
              {error}
            </p>
          ) : null}
          {working ? (
            <p className="db-note" role="status">
              Waiting for your passkey…
            </p>
          ) : null}
          <div className="db-actions">
            <button type="submit" className="db-button" data-variant="primary" disabled={working}>
              Save guardians
            </button>
            <button
              type="button"
              className="db-button"
              disabled={working}
              onClick={() => setPhase("idle")}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ---- Recovery in progress (the account owner's own) -------------------------

/**
 * True when the caller is the account the request would recover.
 *
 * The list marks the caller's own request `role: "owner"` (round 15); a node
 * that does not is still recognisable by its account DID. Such a request is
 * never a guardian's to approve, so it is kept out of the guardian card and
 * the dashboard's attention list.
 */
function isOwnRecovery(request: RecoveryRequestSummary, viewerDid: string): boolean {
  return request.role === "owner" || (viewerDid !== "" && request.accountDid === viewerDid);
}

const RECOVERY_CANCELLED_MESSAGE =
  "Recovery cancelled. Your account stays with your current key.";

function RecoveryInProgressCard({
  requests,
  cancelRecovery,
}: {
  requests: readonly RecoveryRequestSummary[];
  cancelRecovery: (requestId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<readonly RecoveryRequestSummary[]>(() => [...requests]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    setItems([...requests]);
    if (requests.length > 0) {
      setConfirmation(null);
    }
  }, [requests]);

  if (items.length === 0) {
    return confirmation !== null ? (
      <p className="db-note" role="status">
        {confirmation}
      </p>
    ) : null;
  }

  async function cancel(requestId: string) {
    setCancelling(requestId);
    setError(null);
    try {
      await cancelRecovery(requestId);
      setItems((prev) => prev.filter((item) => item.requestId !== requestId));
      setConfirmation(RECOVERY_CANCELLED_MESSAGE);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not cancel this recovery.");
    } finally {
      setCancelling(null);
    }
  }

  return (
    <Card title="Recovery in progress" anchor="recovery-in-progress">
      <ul className="db-list">
        {items.map((request) => {
          const started = formatDay(request.requestedAt);
          const completes = formatDay(request.contestUntil);
          const approvals = request.approvals ?? 0;
          const threshold = request.threshold ?? GUARDIAN_THRESHOLD;
          const hours = request.safetyWindowHours ?? 72;
          return (
            <li key={request.requestId} className="db-requester">
              <span>
                Someone started a recovery of your account.
                {started !== null ? ` Started ${started}.` : null}
                {completes !== null
                  ? ` It can complete after ${completes}.`
                  : ` ${approvals} of ${threshold} guardians have approved. If ${threshold} approve, it can complete ${hours} hours later unless you cancel it.`}
              </span>
              <button
                type="button"
                className="db-button"
                disabled={cancelling === request.requestId}
                onClick={() => cancel(request.requestId)}
              >
                {cancelling === request.requestId ? "Cancelling…" : "Cancel this recovery"}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? <p className="db-error" role="alert">{error}</p> : null}
    </Card>
  );
}

// ---- Key rotation ----------------------------------------------------------


function RecoveryRequestsCard({
  requests,
  names,
}: {
  requests: readonly {
    requestId: string;
    accountDid: string;
    status: string;
    approvals: number;
    threshold: number;
  }[];
  names?: Readonly<Record<string, string>>;
}) {
  return (
    <Card title="Recovery requests" anchor="recovery-requests">
      {requests.length > 0 ? (
        <ul className="db-list">
          {requests.map((request) => {
            const name = names?.[request.accountDid];
            return (
              <li key={request.requestId} className="db-requester">
                <a className="db-link" href={`/me/recovery/${encodeURIComponent(request.requestId)}`}>
                  {name ?? (shortDid(request.accountDid) || request.requestId)}
                </a>
                {name && request.accountDid ? (
                  <span
                    className="db-cred-id mono-id db-requester-did"
                    title={request.accountDid}
                  >
                    {shortDid(request.accountDid)}
                  </span>
                ) : null}
                <span className="db-cred-note meta">
                  {" "}
                  {request.approvals} of {request.threshold} approvals
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState sentence="No recovery requests need your approval right now." action={{ label: "Manage security", href: "/me/security" }} />
      )}
    </Card>
  );
}

function KeyRotationCard({
  data,
  rotate,
  onRotated,
}: {
  data: SecurityData;
  rotate: RotateKey;
  onRotated: () => void;
}) {
  return (
    <Card title="Key rotation" anchor="rotation">
      <dl className="db-facts">
        <div className="db-fact">
          <dt className="meta">Last key rotation</dt>
          <dd>
            <LastRotation rotation={data.lastRotation} />
          </dd>
        </div>
        <div className="db-fact">
          <dt className="meta">Active key</dt>
          <dd className="db-cred-id mono-id">{data.activeKey}</dd>
        </div>
      </dl>
      <RotateKeyAction data={data} rotate={rotate} onRotated={onRotated} />
    </Card>
  );
}

function LastRotation({ rotation }: { rotation: KeyRotation | null }) {
  if (rotation === null) {
    return (
      <>
        <span className="db-fact-value">Never rotated</span>
        <span className="db-cred-note meta">
          You still sign with the key your account was created with.
        </span>
      </>
    );
  }
  return (
    <>
      <span className="db-fact-value">
        {formatInstant(rotation.effectiveAt) ?? "Date not recorded"}
      </span>
      {rotation.reason ? <span className="db-cred-note meta">{rotation.reason}</span> : null}
      <RecordLink cid={rotation.recordCid} label="View rotation record" />
    </>
  );
}

type RotatePhase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "working" }
  | { kind: "error"; message: string; terminal: boolean }
  | { kind: "done" };

function RotateKeyAction({
  data,
  rotate,
  onRotated,
}: {
  data: SecurityData;
  rotate: RotateKey;
  onRotated: () => void;
}) {
  // Only the key being retired may sign the record that retires it.
  const device = data.devices.find((candidate) => candidate.holdsActiveKey) ?? null;

  const [phase, setPhase] = useState<RotatePhase>({ kind: "idle" });
  const [reason, setReason] = useState("");

  const headingId = useId();
  const reasonId = useId();
  const noteId = useId();
  const mounted = useRef(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef<RotatePhase["kind"]>("idle");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Move focus with the interface: into the question when it opens, back to
  // the button when it is dismissed.
  useEffect(() => {
    if (phase.kind === "confirming" && previous.current === "idle") {
      headingRef.current?.focus();
    }
    if (phase.kind === "idle" && previous.current !== "idle") {
      triggerRef.current?.focus();
    }
    previous.current = phase.kind;
  }, [phase.kind]);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (device === null || phase.kind === "working") {
      return;
    }
    setPhase({ kind: "working" });
    try {
      await rotate({
        accountDid: data.did,
        activeKey: data.activeKey,
        deviceDid: device.did,
        prev: data.lastRotation?.recordCid ?? null,
        reason,
      });
    } catch (error) {
      if (mounted.current) {
        setPhase({
          kind: "error",
          message: describeRotationError(error),
          terminal: isRotationError(error) && TERMINAL_ROTATION_CODES.includes(error.code),
        });
      }
      return;
    }
    if (mounted.current) {
      setPhase({ kind: "done" });
    }
    onRotated();
  }

  if (phase.kind === "done") {
    return (
      <p className="db-note" role="status">
        Key rotated. This device now signs with your new key. Reloading…
      </p>
    );
  }

  if (phase.kind === "idle") {
    return (
      <div className="db-rotate-action">
        <button
          type="button"
          className="db-button"
          data-variant="primary"
          ref={triggerRef}
          disabled={device === null}
          aria-describedby={device === null ? noteId : undefined}
          onClick={() => setPhase({ kind: "confirming" })}
        >
          Rotate key
        </button>
        {device === null ? (
          <p className="db-cred-note meta" id={noteId}>
            Rotate from the device that holds your current signing key. If you no longer
            have it, <a href={RECOVER_PATH}>recover your account</a>.
          </p>
        ) : null}
      </div>
    );
  }

  const working = phase.kind === "working";
  const terminal = phase.kind === "error" && phase.terminal;

  return (
    <form className="db-rotate" aria-labelledby={headingId} onSubmit={confirm}>
      <h3 className="db-rotate-title" id={headingId} tabIndex={-1} ref={headingRef}>
        {terminal ? "Your key may have changed" : "Rotate your signing key?"}
      </h3>

      {terminal ? null : (
        <>
          <p className="db-rotate-text">
            Scholium creates a new key on this device, protected by a new passkey. Your
            current key signs one record that hands your account over to the new key, and
            can&rsquo;t sign anything afterwards. Your papers and reviews still verify.
            This can&rsquo;t be undone.
          </p>
          <p className="db-cred-note meta">
            You&rsquo;re signing with your passkey. Scholium never sees your key. You will
            be asked for your passkey twice.
          </p>
          <div className="db-field">
            <label className="db-field-label" htmlFor={reasonId}>
              Reason (optional)
            </label>
            <input
              id={reasonId}
              className="db-input"
              type="text"
              value={reason}
              maxLength={ROTATION_REASON_MAX_LENGTH}
              disabled={working}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </>
      )}

      {working ? (
        <p className="db-note" role="status">
          Waiting for your passkey…
        </p>
      ) : null}

      {phase.kind === "error" ? (
        <p className="db-error" role="alert">
          {phase.message}
        </p>
      ) : null}

      {terminal ? (
        <div className="db-actions">
          <a className="db-button" href={RECOVER_PATH}>
            Recover your account
          </a>
          <button type="button" className="db-button" onClick={onRotated}>
            Reload this page
          </button>
        </div>
      ) : (
        <div className="db-actions">
          <button type="submit" className="db-button" data-variant="primary" disabled={working}>
            Rotate key
          </button>
          <button
            type="button"
            className="db-button"
            disabled={working}
            onClick={() => setPhase({ kind: "idle" })}
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );
}


// ---- Erase profile ---------------------------------------------------------

/**
 * What erasure removes and what it leaves behind.
 *
 * Erasure drops the name, affiliation and email. The account is untouched, and
 * the ORCID link is not removed either: the profile stops showing it and it is
 * kept only so the account can still be recovered (profiles/views.py,
 * recovery/opening.py). Saying so before the click is the point.
 */
export const ERASE_SCOPE_NOTE =
  "Erase your name, affiliation and email from your profile. Your account, DID, trust tier and your signed papers and reviews stay. Your ORCID link stays too: your profile stops showing it, and Scholium keeps it only so you can recover your account.";

/** The confirmation, in the same words as the note. */
export const ERASE_CONFIRM_TEXT =
  "This can't be undone. Scholium erases the name, affiliation and email on your profile and keeps none of them. Your account, DID, trust tier and signed papers and reviews stay. Your ORCID link stays too, hidden from your profile and used only if you need to recover your account.";

type ErasePhase = "idle" | "confirming" | "working" | "done" | "error";

function describeEraseError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return "Your session has ended. Sign in again to erase your profile.";
    }
    return error.detail || error.title;
  }
  return error instanceof Error && error.message
    ? error.message
    : "Could not erase your profile.";
}

function EraseProfileCard({
  did,
  eraseProfile,
}: {
  did: string;
  eraseProfile: (did: string) => Promise<void>;
}) {
  const [phase, setPhase] = useState<ErasePhase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previous = useRef<ErasePhase>("idle");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase === "confirming" && previous.current === "idle") {
      headingRef.current?.focus();
    }
    if (phase === "idle" && previous.current !== "idle") {
      triggerRef.current?.focus();
    }
    previous.current = phase;
  }, [phase]);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "working") {
      return;
    }
    setPhase("working");
    setMessage(null);
    try {
      await eraseProfile(did);
    } catch (error) {
      if (mounted.current) {
        setPhase("error");
        setMessage(describeEraseError(error));
      }
      return;
    }
    if (mounted.current) {
      setPhase("done");
      setMessage("Your profile has been erased.");
    }
  }

  const working = phase === "working";

  return (
    <section className="db-card" aria-labelledby="erase-profile-heading">
      <h2 className="db-card-title" id="erase-profile-heading">
        Erase my profile
      </h2>
      <p className="db-cred-note meta">{ERASE_SCOPE_NOTE}</p>

      {phase === "done" ? (
        <p className="db-note" role="status">
          {message}
        </p>
      ) : phase === "idle" ? (
        <div>
          <button
            type="button"
            className="db-button"
            ref={triggerRef}
            onClick={() => {
              setMessage(null);
              setPhase("confirming");
            }}
          >
            Erase my profile
          </button>
        </div>
      ) : (
        <form className="db-rotate" aria-labelledby={headingId} onSubmit={confirm}>
          <h3 className="db-rotate-title" id={headingId} tabIndex={-1} ref={headingRef}>
            Erase your profile?
          </h3>
          <p className="db-rotate-text">{ERASE_CONFIRM_TEXT}</p>

          {working ? (
            <p className="db-note" role="status">
              Erasing…
            </p>
          ) : null}

          {phase === "error" && message ? (
            <p className="db-error" role="alert">
              {message}
            </p>
          ) : null}

          <div className="db-actions">
            <button type="submit" className="db-button" data-variant="primary" disabled={working}>
              Erase my profile
            </button>
            <button
              type="button"
              className="db-button"
              disabled={working}
              onClick={() => {
                setMessage(null);
                setPhase("idle");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
