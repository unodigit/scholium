"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { tokenStore } from "../../lib/api";
import { EmptyState, RecordLink } from "../ui-kit";
import { RECOVER_PATH } from "../web-auth";

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
  loadSecurity as fetchSecurity,
  type DeviceInfo,
  type GuardianState,
  type KeyRotation,
  type SecurityData,
} from "./security";
import { eraseProfile as defaultEraseProfile } from "./profile";
import "./dashboard-page.css";
import "./security-page.css";

/** Loads the security screen; replaceable in tests. */
export type LoadSecurity = () => Promise<SecurityData>;

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

function reloadPage(): void {
  globalThis.location?.reload();
}

/** `/me/security`: devices, recovery guardians, last key rotation, Rotate key. */
export function SecurityPage({
  initialSecurity,
  loadSecurity,
  rotate = defaultRotateKey,
  eraseProfile = defaultEraseProfile,
  onRotated = reloadPage,
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
            <GuardiansCard guardians={state.data.guardians} />
            <RecoveryRequestsCard requests={state.data.recoveryRequests ?? []} />
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

function GuardiansCard({ guardians }: { guardians: GuardianState }) {
  const source = describeGuardianSource(guardians);
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
      <p className="db-guardian-status">{describeGuardians(guardians)}</p>
      {guardians.dids.length > 0 ? (
        <ol className="db-guardians" aria-label="Your recovery guardians">
          {guardians.dids.map((did) => (
            <li className="db-cred-id mono-id" key={did}>
              {did}
              {(guardians.localDids ?? []).includes(did) ? (
                <span className="db-cred-note meta"> (also on this device)</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {source ? <p className="db-cred-note meta">{source}</p> : null}
      {guardiansComplete(guardians) ? null : (
        <a className="db-button" href={GUARDIANS_SETUP_HREF}>
          Set recovery guardians
        </a>
      )}
    </Card>
  );
}

// ---- Key rotation ----------------------------------------------------------


function RecoveryRequestsCard({ requests }: { requests: readonly { requestId: string; accountDid: string; status: string; approvals: number; threshold: number }[] }) {
  return (
    <Card title="Recovery requests" anchor="recovery-requests">
      {requests.length > 0 ? (
        <ul className="db-list">
          {requests.map((request) => (
            <li key={request.requestId}>
              <a className="db-link" href={`/me/recovery/${encodeURIComponent(request.requestId)}`}>
                {request.accountDid || request.requestId}
              </a>
              <span className="db-cred-note meta">
                {" "}
                {request.approvals} of {request.threshold} approvals
              </span>
            </li>
          ))}
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

function EraseProfileCard({
  did,
  eraseProfile,
}: {
  did: string;
  eraseProfile: (did: string) => Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleErase = useCallback(async () => {
    setPhase("working");
    setMessage(null);
    try {
      await eraseProfile(did);
      setPhase("done");
      setMessage("Your profile has been erased.");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Could not erase your profile.");
    }
  }, [did, eraseProfile]);

  return (
    <section className="db-card" aria-labelledby="erase-profile-heading">
      <h2 className="db-card-heading" id="erase-profile-heading">
        Erase my profile
      </h2>
      <p className="db-cred-note meta">
        Remove your name, affiliation, email and ORCID from this profile. Your
        signed reviews and trust tier remain.
      </p>
      <button
        type="button"
        className="db-button"
        onClick={handleErase}
        disabled={phase === "working" || phase === "done"}
      >
        {phase === "working" ? "Erasing…" : "Erase my profile"}
      </button>
      {message ? <p className="db-note" role="status">{message}</p> : null}
    </section>
  );
}
