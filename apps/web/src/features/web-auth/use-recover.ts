/**
 * State machine behind the `/recover` page.
 *
 * Kept apart from the markup (`recover-form.tsx`) so the behaviour — identify
 * by ORCID, open the request, read progress, cancel — is unit-testable without
 * a JSX transform, exactly like `use-signin.ts` and `use-onboarding.ts`.
 *
 * The hook owns:
 *
 * - the request this browser is tracking (from `?request=`, or remembered
 *   under {@link RECOVERY_STORAGE_KEY}),
 * - one action at a time (opening, checking, cancelling) with plain-language
 *   progress,
 * - the last status read. A read that fails because the status route is not
 *   there yet is **not** an error: the page keeps what it knows and offers
 *   "Check for approvals" again ({@link isRecoveryStatusUnavailable}).
 *
 * Starting a recovery creates the new passkey on this device when the browser
 * has none — the account is being moved to a key that exists here, and the
 * final step of the design's flow is exactly that new passkey.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient, browserTokenStorage } from "../../lib/api";
import type { TokenStorage } from "../../lib/api";

import { deviceKey } from "./device-key";
import type { DeviceKeyManager } from "./device-key";
import {
  clearPersistedRecovery,
  fetchRecoveryStatus,
  isRecoveryStatusUnavailable,
  loadPersistedRecovery,
  mergeRecoveryStatus,
  normalizeOrcid,
  openRecoveryRequest,
  placeholderRecovery,
  savePersistedRecovery,
  cancelRecoveryRequest,
  type RecoveryClient,
  type RecoverySnapshot,
} from "./recover";
import {
  RECOVER_CANCELLED_NOTICE,
  RECOVER_CANCELLING,
  RECOVER_ORCID_INVALID_MESSAGE,
  RECOVER_REFRESHING,
  RECOVER_STARTED_NOTICE,
  RECOVER_STARTING,
  RECOVER_STARTING_PASSKEY,
  describeRecoveryError,
} from "./recover-messages";

/** The slice of the device key the page uses. */
export type RecoveryDeviceKey = Pick<
  DeviceKeyManager,
  "exists" | "didKey" | "ensure" | "signWithPasskey"
>;

/** The collaborators the page needs; swappable in tests. */
export interface RecoveryServices {
  /** API client slice the recovery actions use. */
  client: RecoveryClient;
  /** Device key: the new key, and the passkey that signs a cancel. */
  deviceKey: RecoveryDeviceKey;
  /** Where the in-flight request is remembered. */
  storage: TokenStorage;
  /** Clock in epoch milliseconds, injectable for tests. */
  now(): number;
}

/** The app-wide services: the real device key, the real API, real storage. */
export const defaultRecoveryServices: RecoveryServices = {
  client: apiClient,
  deviceKey,
  storage: browserTokenStorage,
  now: Date.now,
};

/** Inputs for {@link useRecover}. */
export interface UseRecoverOptions {
  /** Service overrides, for tests. Defaults to the app-wide services. */
  services?: RecoveryServices;
  /** Request id from `?request=` (a link sent to a known contact). */
  requestId?: string;
  /** ORCID iD to prefill on the identify form. */
  initialOrcid?: string;
}

/** What the `/recover` page renders. */
export interface UseRecoverResult {
  /** The browser storage has been read; the first client render is done. */
  ready: boolean;
  /** The request being tracked, or `null` on the identify step. */
  snapshot: RecoverySnapshot | null;
  /** An opening or cancelling action is running. */
  busy: boolean;
  /** A status check is running. */
  refreshing: boolean;
  /** One line describing the current step; empty when idle. */
  progress: string;
  /** Why the last action failed, in plain language; `null` otherwise. */
  error: string | null;
  /** What the last action achieved, in plain language; `null` otherwise. */
  notice: string | null;
  /** A status read has succeeded at least once. */
  statusLive: boolean;
  /** Identify by ORCID and open a recovery request. */
  start(orcid: string): Promise<void>;
  /** Re-read the request's approval progress. */
  refresh(): Promise<void>;
  /** Cancel the recovery, signed by the key still on the account. */
  cancel(): Promise<void>;
  /** Forget this browser's request and show the identify form again. */
  reset(): void;
}

/** Drive the `/recover` page. */
export function useRecover({
  services = defaultRecoveryServices,
  requestId,
  initialOrcid,
}: UseRecoverOptions = {}): UseRecoverResult {
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusLive, setStatusLive] = useState(false);
  const actionInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const mounted = useRef(true);
  // Bumped whenever the page's subject changes (open, cancel, reset), so a
  // status read that started earlier cannot resurrect a stale request.
  const generation = useRef(0);

  const remember = useCallback(
    (next: RecoverySnapshot): void => {
      setSnapshot(next);
      savePersistedRecovery(services.storage, next);
    },
    [services.storage],
  );

  /**
   * Read the request's status and fold it into `current`.
   *
   * Takes `current` explicitly so the mount effect can refresh what it just
   * loaded without waiting a render for state to settle.
   */
  const refreshSnapshot = useCallback(
    async (current: RecoverySnapshot): Promise<void> => {
      if (refreshInFlight.current) {
        return;
      }
      refreshInFlight.current = true;
      const mine = generation.current;
      if (mounted.current) {
        setRefreshing(true);
        setError(null);
        setProgress(RECOVER_REFRESHING);
      }
      try {
        const update = await fetchRecoveryStatus(current.requestId, services.client);
        if (!mounted.current || mine !== generation.current) {
          return;
        }
        remember(mergeRecoveryStatus(current, update));
        setStatusLive(true);
      } catch (failure) {
        if (!mounted.current || mine !== generation.current) {
          return;
        }
        if (!isRecoveryStatusUnavailable(failure)) {
          setError(describeRecoveryError(failure));
        }
        // Either way the last known progress stays on screen.
        setStatusLive(false);
      } finally {
        refreshInFlight.current = false;
        if (mounted.current) {
          setRefreshing(false);
          setProgress("");
        }
      }
    },
    [remember, services.client],
  );

  // Load the request this browser was already tracking (or the one named by
  // `?request=`) and read its progress once. A corrupt or absent entry shows
  // the identify form.
  useEffect(() => {
    mounted.current = true;
    const persisted = loadPersistedRecovery(services.storage);
    let initial: RecoverySnapshot | null;
    if (requestId) {
      initial =
        persisted && persisted.requestId === requestId
          ? persisted
          : placeholderRecovery(
              requestId,
              initialOrcid ?? persisted?.orcid ?? "",
              services.now,
            );
    } else {
      initial = persisted;
    }
    setSnapshot(initial);
    setReady(true);
    if (initial) {
      void refreshSnapshot(initial);
    }
    return () => {
      mounted.current = false;
    };
  }, [initialOrcid, refreshSnapshot, requestId, services.now, services.storage]);

  const start = useCallback(
    async (orcid: string): Promise<void> => {
      if (actionInFlight.current) {
        return;
      }
      const normalized = normalizeOrcid(orcid);
      if (!normalized) {
        setError(RECOVER_ORCID_INVALID_MESSAGE);
        setNotice(null);
        return;
      }

      actionInFlight.current = true;
      generation.current += 1;
      setBusy(true);
      setError(null);
      setNotice(null);
      setProgress(RECOVER_STARTING);

      try {
        // The new key lives on this device. A browser that has none creates
        // one here — the "new passkey" at the end of the design's flow.
        if (!(await services.deviceKey.exists())) {
          if (mounted.current) {
            setProgress(RECOVER_STARTING_PASSKEY);
          }
          await services.deviceKey.ensure({ userName: normalized });
        }
        const newPublicKey = await services.deviceKey.didKey();
        if (mounted.current) {
          setProgress(RECOVER_STARTING);
        }
        const opened = await openRecoveryRequest({
          orcid: normalized,
          newPublicKey,
          client: services.client,
          now: services.now,
        });
        if (!mounted.current) {
          return;
        }
        remember(opened);
        setStatusLive(false);
        setNotice(RECOVER_STARTED_NOTICE);
      } catch (failure) {
        if (mounted.current) {
          setError(describeRecoveryError(failure));
        }
      } finally {
        actionInFlight.current = false;
        if (mounted.current) {
          setBusy(false);
          setProgress("");
        }
      }
    },
    [remember, services.client, services.deviceKey, services.now],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (snapshot) {
      await refreshSnapshot(snapshot);
    }
  }, [refreshSnapshot, snapshot]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!snapshot || actionInFlight.current) {
      return;
    }
    actionInFlight.current = true;
    generation.current += 1;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress(RECOVER_CANCELLING);
    try {
      await cancelRecoveryRequest({
        requestId: snapshot.requestId,
        signer: services.deviceKey,
        client: services.client,
      });
      if (!mounted.current) {
        return;
      }
      remember({ ...snapshot, status: "cancelled" });
      setNotice(RECOVER_CANCELLED_NOTICE);
    } catch (failure) {
      if (mounted.current) {
        setError(describeRecoveryError(failure));
      }
    } finally {
      actionInFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }, [remember, services.client, services.deviceKey, snapshot]);

  const reset = useCallback((): void => {
    generation.current += 1;
    clearPersistedRecovery(services.storage);
    setSnapshot(null);
    setError(null);
    setNotice(null);
    setProgress("");
    setStatusLive(false);
  }, [services.storage]);

  return {
    ready,
    snapshot,
    busy,
    refreshing,
    progress,
    error,
    notice,
    statusLive,
    start,
    refresh,
    cancel,
    reset,
  };
}
