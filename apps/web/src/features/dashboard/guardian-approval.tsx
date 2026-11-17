"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { tokenStore, api, ApiError, NetworkError } from "../../lib/api";
import { Card } from "./dashboard-page";
import { EmptyState } from "../ui-kit";
import { deviceKey } from "../web-auth";
import { SECURITY_SIGNIN_HREF } from "./security";

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
}

const DEFAULT_THRESHOLD = 3;

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
  const approvals = Array.isArray(payload.approvals)
    ? payload.approvals.length
    : typeof payload.approval_count === "number"
      ? payload.approval_count
      : typeof payload.approvals_count === "number"
        ? payload.approvals_count
        : 0;
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
    approvals,
    threshold,
    contestUntil,
    requestedAt,
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
    | { status: "approved" }
    | { status: "declined" }
  >(() => (initial ? { status: "ready", data: initial } : { status: "loading" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

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
        setState({ status: "approved" });
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
    return (
      <div className="db-notice" role="status">
        <h2 className="db-notice-title">Approval recorded</h2>
        <p className="db-notice-text">Your approval has been sent.</p>
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
      </Card>
    </div>
  );
}

// Aliases.
export const GuardianApproval = GuardianApprovalPage;
export default GuardianApprovalPage;
