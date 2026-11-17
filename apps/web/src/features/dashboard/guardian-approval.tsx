"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { tokenStore, api, ApiError, NetworkError } from "../../lib/api";
import { Card } from "./dashboard-page";
import { EmptyState } from "../ui-kit";
import { deviceKey } from "../web-auth";
import { SECURITY_SIGNIN_HREF } from "./security";
import "./security-page.css";

export interface GuardianApprovalData {
  readonly requestId: string;
  readonly status: string;
  readonly accountDid: string;
  readonly accountName: string | null;
  readonly newPublicKey: string;
  readonly approvals: number;
  readonly threshold: number;
  readonly contestUntil: string | null;
  readonly requestedAt: string | null;
  /** The guardians who have already answered this request. */
  readonly approvalDids?: readonly string[];
  /** When a guardian answered, by DID, when the server records a time. */
  readonly approvalTimes?: Readonly<Record<string, string>>;
}

export interface GuardianApprovalPageProps {
  requestId?: string;
  id?: string;
  request?: string;
  initialRequest?: GuardianApprovalData;
  initialData?: GuardianApprovalData;
  loadRequest?: (requestId: string) => Promise<GuardianApprovalData>;
  loadRecoveryRequest?: (requestId: string) => Promise<GuardianApprovalData>;
  fetchRequest?: (requestId: string) => Promise<GuardianApprovalData>;
  approve?: (requestId: string) => Promise<unknown>;
  approveRequest?: (requestId: string) => Promise<unknown>;
  decline?: (requestId: string) => Promise<unknown>;
  onApproved?: () => void;
  onDeclined?: () => void;
  signedIn?: boolean;
  /** The signed-in guardian's DID; read from the device key when omitted. */
  viewerDid?: string;
}

const DEFAULT_THRESHOLD = 3;

/** The DID and any recorded time carried by one entry of `approvals`. */
function readApproval(entry: unknown): { did: string | null; at: string | null } {
  if (typeof entry === "string") {
    return { did: entry, at: null };
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { did: null, at: null };
  }
  const record = entry as Record<string, unknown>;
  const didKey = ["guardian", "guardian_did", "did", "signer", "approver", "guardianDid"];
  const did =
    didKey
      .map((key) => record[key])
      .find((value): value is string => typeof value === "string" && value !== "") ?? null;
  const timeKey = ["approved_at", "approvedAt", "created_at", "createdAt", "at", "timestamp"];
  const at =
    timeKey
      .map((key) => record[key])
      .find((value): value is string => typeof value === "string" && value !== "") ?? null;
  return { did, at };
}

/** The approvals a request carries, as a count, DIDs and any times. */
function readApprovals(payload: Record<string, unknown>): {
  count: number;
  dids: string[];
  times: Record<string, string>;
} {
  if (Array.isArray(payload.approvals)) {
    const dids: string[] = [];
    const times: Record<string, string> = {};
    for (const entry of payload.approvals) {
      const { did, at } = readApproval(entry);
      if (did !== null) {
        dids.push(did);
        if (at !== null) {
          times[did] = at;
        }
      }
    }
    return { count: payload.approvals.length, dids, times };
  }
  const count =
    typeof payload.approval_count === "number"
      ? payload.approval_count
      : typeof payload.approvals_count === "number"
        ? payload.approvals_count
        : 0;
  return { count, dids: [], times: {} };
}

/** `17 Nov 2026`, in the reader's own zone. */
function formatApprovedOn(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function resolveId(props: GuardianApprovalPageProps): string {
  return props.requestId ?? props.id ?? props.request ?? "";
}

function resolveLoader(props: GuardianApprovalPageProps) {
  return (
    props.loadRequest ??
    props.loadRecoveryRequest ??
    props.fetchRequest ??
    defaultLoadRecoveryRequest
  );
}

async function defaultLoadRecoveryRequest(requestId: string): Promise<GuardianApprovalData> {
  const payload = (await api.get<unknown>(`/recovery/requests/${encodeURIComponent(requestId)}`, {
    cache: "no-store",
  })) as Record<string, unknown>;
  const accountDid =
    (typeof payload.did === "string" && payload.did) ||
    (typeof payload.account_did === "string" && payload.account_did) ||
    (typeof payload.accountDid === "string" && payload.accountDid) ||
    "";
  let accountName: string | null = null;
  if (accountDid) {
    try {
      const profile = (await api.get<unknown>(`/profiles/${encodeURIComponent(accountDid)}`, {
        auth: false,
        cache: "no-store",
      })) as Record<string, unknown>;
      accountName = typeof profile.name === "string" ? profile.name : null;
    } catch {
      accountName = null;
    }
  }
  const approvals = readApprovals(payload);
  const threshold =
    typeof payload.threshold === "number" ? payload.threshold : DEFAULT_THRESHOLD;
  const newPublicKey =
    (typeof payload.new_public_key === "string" && payload.new_public_key) ||
    (typeof payload.newPublicKey === "string" && payload.newPublicKey) ||
    (typeof payload.new_key === "string" && payload.new_key) ||
    (typeof payload.newKey === "string" && payload.newKey) ||
    "";
  const contestUntil =
    typeof payload.contest_until === "string"
      ? payload.contest_until
      : typeof payload.contestUntil === "string"
        ? payload.contestUntil
        : null;
  const requestedAt =
    typeof payload.requested_at === "string"
      ? payload.requested_at
      : typeof payload.requestedAt === "string"
        ? payload.requestedAt
        : null;
  return {
    requestId,
    status: typeof payload.status === "string" ? payload.status : "pending",
    accountDid,
    accountName,
    newPublicKey,
    approvals: approvals.count,
    threshold,
    contestUntil,
    requestedAt,
    approvalDids: approvals.dids,
    approvalTimes: approvals.times,
  };
}

function fingerprint(did: string): string {
  if (did.length <= 16) return did;
  return `${did.slice(0, 12)}…${did.slice(-6)}`;
}

export function GuardianApprovalPage(props: GuardianApprovalPageProps = {}) {
  const requestId = resolveId(props);
  const initial = props.initialRequest ?? props.initialData;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "signed-out" }
    | { status: "error"; message: string }
    | { status: "ready"; data: GuardianApprovalData }
    | { status: "approved"; at: string }
    | { status: "declined" }
  >(() => (initial ? { status: "ready", data: initial } : { status: "loading" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerDid, setViewerDid] = useState(props.viewerDid ?? "");
  const mounted = useRef(true);

  // Who is answering decides whether this guardian has already answered.
  useEffect(() => {
    if (props.viewerDid !== undefined) {
      setViewerDid(props.viewerDid);
      return;
    }
    let cancelled = false;
    deviceKey
      .didKey()
      .then((did) => {
        if (!cancelled) setViewerDid(did);
      })
      .catch(() => {
        // No key on this device: the request is still readable, just not
        // attributable to an answer.
      });
    return () => {
      cancelled = true;
    };
  }, [props.viewerDid]);

  useEffect(() => {
    mounted.current = true;
    if (!(props.signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "signed-out" });
      return;
    }
    if (initial) return;
    let cancelled = false;
    setState({ status: "loading" });
    resolveLoader(props)(requestId)
      .then((data) => {
        if (!cancelled && mounted.current) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled && mounted.current) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Could not load the recovery request.",
          });
        }
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [props, requestId, initial]);

  const approve = useCallback(async () => {
    if (state.status !== "ready" || busy) return;
    const data = state.data;
    // Nobody may add an approval once the quorum is met.
    if (data.threshold > 0 && data.approvals >= data.threshold) return;
    const signer = (props.approve ?? props.approveRequest) ?? (async () => {
      const did = await deviceKey.didKey();
      // Build approval message matching API.
      const canonical = JSON.stringify({
        request_id: data.requestId,
        account_did: data.accountDid,
        new_key: data.newPublicKey,
      });
      const signatureBytes = await deviceKey.signWithPasskey(new TextEncoder().encode(canonical));
      // base64url
      const base64url = btoa(String.fromCharCode(...signatureBytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await api.post(
        `/recovery/requests/${encodeURIComponent(data.requestId)}/approvals`,
        { guardian_did: did, signature: base64url },
        { auth: true },
      );
    });
    setBusy(true);
    setError(null);
    try {
      await signer(data.requestId);
      if (mounted.current) {
        setState({ status: "approved", at: new Date().toISOString() });
        props.onApproved?.();
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [state, busy, props]);

  const decline = useCallback(async () => {
    if (state.status !== "ready" || busy) return;
    const data = state.data;
    const fn = props.decline;
    setBusy(true);
    setError(null);
    try {
      if (fn) await fn(data.requestId);
      if (mounted.current) {
        setState({ status: "declined" });
        props.onDeclined?.();
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Decline failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [state, busy, props]);

  // Form submit handler not needed.

  if (state.status === "signed-out") {
    return (
      <div className="db-notice" role="alert">
        <h2 className="db-notice-title">Sign in to continue</h2>
        <p className="db-notice-text">Guardians manage recovery requests from their own account.</p>
        <a className="db-button" href={SECURITY_SIGNIN_HREF}>
          Sign in
        </a>
      </div>
    );
  }

  if (state.status === "loading") {
    return <p className="db-loading" role="status">Loading recovery request…</p>;
  }

  if (state.status === "error") {
    return (
      <div className="db-notice" role="alert">
        <h2 className="db-notice-title">Couldn’t load the recovery request</h2>
        <p className="db-notice-text">{state.message}</p>
      </div>
    );
  }

  if (state.status === "approved") {
    const on = formatApprovedOn(state.at);
    return (
      <div className="db-notice" role="status">
        <h2 className="db-notice-title">You approved</h2>
        <p className="db-notice-text">
          {on ? `You approved on ${on}.` : "You approved this request."} Your approval
          has been sent to the account.
        </p>
      </div>
    );
  }

  if (state.status === "declined") {
    return (
      <div className="db-notice" role="status">
        <h2 className="db-notice-title">Declined</h2>
        <p className="db-notice-text">You declined this recovery request.</p>
      </div>
    );
  }

  const data = state.data;
  const approvedDids = data.approvalDids ?? [];
  const youAnswered = viewerDid !== "" && approvedDids.includes(viewerDid);
  const answeredAt = youAnswered ? data.approvalTimes?.[viewerDid] ?? null : null;
  const atThreshold = data.threshold > 0 && data.approvals >= data.threshold;
  const closed = data.status !== "pending" && data.status !== "contest";
  const canAct = !youAnswered && !atThreshold && !closed;
  const answerDate = formatApprovedOn(answeredAt ?? data.requestedAt);
  return (
    <div className="db-page">
      <header className="db-header">
        <p className="db-kicker mono-id">scholium / me / recovery</p>
        <h1 className="db-title">Recovery request</h1>
        <p className="db-lede">
          {data.accountName
            ? `${data.accountName} is asking to recover their account.`
            : "A member is asking to recover their account."}
        </p>
      </header>

      <Card title="Request details" anchor="request">
        <dl className="db-facts">
          <div className="db-fact">
            <dt className="meta">Account</dt>
            <dd className="db-cred-id mono-id">{data.accountDid}</dd>
          </div>
          {data.accountName ? (
            <div className="db-fact">
              <dt className="meta">Name</dt>
              <dd>{data.accountName}</dd>
            </div>
          ) : null}
          <div className="db-fact">
            <dt className="meta">New key</dt>
            <dd className="db-cred-id mono-id">{fingerprint(data.newPublicKey)}</dd>
          </div>
          <div className="db-fact">
            <dt className="meta">Approvals</dt>
            <dd>
              {data.approvals} of {data.threshold}
            </dd>
          </div>
          {data.requestedAt ? (
            <div className="db-fact">
              <dt className="meta">Requested</dt>
              <dd>{data.requestedAt}</dd>
            </div>
          ) : null}
        </dl>

        {error ? <p className="db-error" role="alert">{error}</p> : null}

        {youAnswered ? (
          <p className="db-note" role="status">
            {answerDate
              ? `You approved on ${answerDate}.`
              : "You approved this request."}{" "}
            No further action is needed.
          </p>
        ) : null}

        {!youAnswered && atThreshold ? (
          <p className="db-note" role="status">
            Enough guardians have approved. No further action is needed.
          </p>
        ) : null}

        {canAct ? (
          <div className="db-actions">
            <button
              type="button"
              className="db-button"
              data-variant="primary"
              disabled={busy}
              onClick={() => void approve()}
            >
              {busy ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              className="db-button"
              disabled={busy}
              onClick={() => void decline()}
            >
              Decline
            </button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// Aliases.
export const GuardianApproval = GuardianApprovalPage;
export default GuardianApprovalPage;
