/**
 * State machine behind the `/onboarding` checklist.
 *
 * Kept apart from the markup (`onboarding-form.tsx`) so the behaviour —
 * which steps are done, what each action does, the guardians gate on
 * finishing — is unit-testable without a JSX transform, exactly like
 * `use-signin.ts`.
 *
 * The hook owns four pieces of state:
 *
 * - the device-key check (passkey step) and the account's did,
 * - the persisted progress (`scholium.web-auth.onboarding` in browser
 *   storage) so a reload or the round-trip to ORCID keeps the checklist,
 * - the in-progress editing state (selected categories, guardian inputs),
 * - one action error at a time, in plain language.
 *
 * **Guardians gate the finish.** `canFinish` is true only once the guardians
 * step is done: the API refuses every submission with 403 until they are
 * set, so the page's primary action stays locked (a gentle "skip for now"
 * is always offered — see `onboarding-messages.ts`).
 *
 * `useOrcidReturn` (below) drives the `/onboarding/orcid` page ORCID redirects
 * back to: it hands the returned `code` and `state` to the authenticated
 * `POST /v1/auth/orcid/complete` and reports how that went.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, apiClient, browserTokenStorage } from "../../lib/api";
import type { ApiClient, TokenStorage } from "../../lib/api";

import { deviceKey } from "./device-key";
import type { DeviceKeyManager } from "./device-key";
import {
  GUARDIAN_COUNT,
  ONBOARDING_CATEGORY_CHOICES,
  ONBOARDING_STEPS,
  checkOrcidLink,
  completeOrcidLink,
  countCompletedSteps,
  emptyPersistedOnboarding,
  followCategories,
  isGuardianSaveError,
  loadPersistedOnboarding,
  normalizeCategory,
  onboardingStepCompletion,
  parseOrcidReturn,
  saveGuardians,
  startOrcidLink,
  updatePersistedOnboarding,
  type GuardianProblem,
  type OnboardingStepId,
  type PersistedOnboarding,
} from "./onboarding";
import {
  CATEGORY_INVALID_MESSAGE,
  ORCID_RETURN_DENIED_MESSAGE,
  ORCID_RETURN_MISSING_MESSAGE,
  describeOnboardingError,
} from "./onboarding-messages";

/** The collaborators the onboarding page needs; swappable in tests. */
export interface OnboardingServices {
  /** Device key: answers "is the passkey step done?" and gives the did. */
  deviceKey: Pick<DeviceKeyManager, "exists" | "didKey">;
  /** API client slice the onboarding actions use. */
  client: Pick<ApiClient, "get" | "put">;
  /** Where the persisted progress lives. */
  storage: TokenStorage;
  /** Send the whole browser to a URL (the ORCID authorize page). */
  openExternalUrl(url: string): void;
}

/** The app-wide services: the real device key, the real API, real storage. */
export const defaultOnboardingServices: OnboardingServices = {
  deviceKey,
  client: apiClient,
  storage: browserTokenStorage,
  openExternalUrl(url: string): void {
    if (typeof window !== "undefined") {
      window.location.assign(url);
    }
  },
};

/** Inputs for {@link useOnboarding}. */
export interface UseOnboardingOptions {
  /** Service overrides, for tests. Defaults to the app-wide services. */
  services?: OnboardingServices;
}

/** The link-ORCID step's state. */
export interface OnboardingOrcidState {
  /** The browser was sent to ORCID at least once. */
  started: boolean;
  /** A linked ORCID iD has been observed on the account. */
  linked: boolean;
  /** The authorize URL is being fetched. */
  starting: boolean;
}

/** The categories step's state. */
export interface OnboardingCategoriesState {
  /** Every category offered as a chip, preset choices first. */
  choices: readonly string[];
  /** The currently toggled-on picks. */
  selected: string[];
  /** The picks are being saved. */
  saving: boolean;
  /** The categories as saved, once saving has succeeded. */
  saved: string[] | null;
  /** False when the picks could only be kept on this device. */
  savedToAccount: boolean;
  /** Why the typed-in category cannot be added, when it cannot. */
  invalidMessage: string | null;
}

/** The guardians step's state. */
export interface OnboardingGuardiansState {
  /** The five inputs, in order. */
  values: string[];
  /** Problems tied to the inputs (or the list as a whole). */
  problems: GuardianProblem[];
  /** The list is being saved. */
  saving: boolean;
  /** The guardians as saved, once saving has succeeded. */
  saved: string[] | null;
}

/** What the `/onboarding` page renders. */
export interface UseOnboardingResult {
  /** False until the first device-key and storage check has run. */
  ready: boolean;
  /** The account's did:key, when a device key exists. */
  did: string | null;
  /** The passkey step: a device key exists on this device. */
  passkeyReady: boolean;
  orcid: OnboardingOrcidState;
  categories: OnboardingCategoriesState;
  guardians: OnboardingGuardiansState;
  /** The four steps in design order, each with its done flag. */
  steps: Array<{ id: OnboardingStepId; done: boolean }>;
  /** How many steps are complete. */
  completedCount: number;
  /** How many steps there are. */
  totalCount: number;
  /** True once the guardians step is done — the gate on finishing. */
  canFinish: boolean;
  /** Why the last action failed, in plain language; `null` otherwise. */
  error: string | null;
  /** Send the browser to ORCID to link the account's iD. */
  linkOrcid(): Promise<void>;
  /** Toggle a category chip. */
  toggleCategory(category: string): void;
  /** Add a typed-in category as a picked chip; false when it cannot be. */
  addCategory(value: string): boolean;
  /** Save the picks (`PUT /v1/me/follows/{category}`, kept locally if absent). */
  saveCategories(): Promise<void>;
  /** Edit one guardian input. */
  setGuardianValue(index: number, value: string): void;
  /** Save the guardians (`PUT /v1/me/guardians`). */
  saveGuardiansAction(): Promise<void>;
}

function emptyGuardiansValues(): string[] {
  return Array.from({ length: GUARDIAN_COUNT }, () => "");
}

/**
 * Drive the `/onboarding` checklist.
 *
 * The first effect loads the persisted progress, checks the device key and
 * (best-effort) whether ORCID is linked. Each action validates before any
 * network call where it can, merges its result into the persisted progress,
 * and reports one plain-language error on failure.
 */
export function useOnboarding(options: UseOnboardingOptions = {}): UseOnboardingResult {
  const servicesRef = useRef<OnboardingServices>(
    options.services ?? defaultOnboardingServices,
  );

  const [ready, setReady] = useState(false);
  const [did, setDid] = useState<string | null>(null);
  const [passkeyReady, setPasskeyReady] = useState(false);
  // Start from "nothing done" rather than reading storage in the initial
  // render: this component is server-rendered too, where storage is empty, and
  // a client render that already showed persisted progress would hydrate
  // against different markup. The mount effect below loads it instead.
  const [persisted, setPersisted] = useState<PersistedOnboarding>(
    emptyPersistedOnboarding,
  );
  const [orcid, setOrcid] = useState<OnboardingOrcidState>(() => ({
    started: false,
    linked: false,
    starting: false,
  }));
  const [categories, setCategories] = useState<OnboardingCategoriesState>(() => ({
    choices: ONBOARDING_CATEGORY_CHOICES,
    selected: [],
    saving: false,
    saved: null,
    savedToAccount: true,
    invalidMessage: null,
  }));
  const [guardians, setGuardians] = useState<OnboardingGuardiansState>(() => ({
    values: emptyGuardiansValues(),
    problems: [],
    saving: false,
    saved: null,
  }));
  const [error, setError] = useState<string | null>(null);

  const busyRef = useRef({ orcid: false, categories: false, guardians: false });

  // One pass on mount: what has this browser already done?
  useEffect(() => {
    const services = servicesRef.current;
    let active = true;

    void (async () => {
      const stored = loadPersistedOnboarding(services.storage);

      let keyReady = false;
      let accountDid: string | null = null;
      try {
        keyReady = await services.deviceKey.exists();
        if (keyReady) {
          accountDid = await services.deviceKey.didKey();
        }
      } catch {
        // A storage failure reads as "no key here"; the step says sign in.
        keyReady = false;
        accountDid = null;
      }

      // Best-effort: if the user was sent to ORCID earlier, the link may
      // have completed since. A missing profile endpoint changes nothing.
      let linkedAt = stored.orcidLinkedAt;
      if (linkedAt === null && stored.orcidStartedAt !== null && accountDid !== null) {
        if (await checkOrcidLink(services.client, accountDid)) {
          linkedAt = new Date().toISOString();
        }
      }

      if (!active) {
        return;
      }
      const next =
        linkedAt !== stored.orcidLinkedAt ? { ...stored, orcidLinkedAt: linkedAt } : stored;
      setPersisted(next);
      setOrcid({
        started: next.orcidStartedAt !== null,
        linked: next.orcidLinkedAt !== null,
        starting: false,
      });
      setPasskeyReady(keyReady);
      setDid(accountDid);
      setReady(true);
    })();

    return () => {
      active = false;
    };
  }, []);

  /** Merge a patch into the persisted progress and persist it. */
  const applyPersisted = useCallback((patch: Partial<PersistedOnboarding>) => {
    setPersisted(updatePersistedOnboarding(servicesRef.current.storage, patch));
  }, []);

  const linkOrcid = useCallback(async (): Promise<void> => {
    if (busyRef.current.orcid) {
      return;
    }
    busyRef.current.orcid = true;
    setError(null);
    setOrcid((current) => ({ ...current, starting: true }));
    try {
      const start = await startOrcidLink(servicesRef.current.client);
      applyPersisted({ orcidStartedAt: new Date().toISOString() });
      setOrcid((current) => ({ ...current, started: true, starting: false }));
      // Full-page navigation: ORCID is another origin.
      servicesRef.current.openExternalUrl(start.authorizeUrl);
    } catch (failure) {
      setOrcid((current) => ({ ...current, starting: false }));
      setError(describeOnboardingError(failure));
    } finally {
      busyRef.current.orcid = false;
    }
  }, [applyPersisted]);

  const toggleCategory = useCallback((category: string) => {
    setCategories((current) => {
      const selected = current.selected.includes(category)
        ? current.selected.filter((entry) => entry !== category)
        : [...current.selected, category];
      return { ...current, selected };
    });
  }, []);

  const addCategory = useCallback((value: string): boolean => {
    const normalized = normalizeCategory(value);
    if (normalized === null) {
      setCategories((current) => ({ ...current, invalidMessage: CATEGORY_INVALID_MESSAGE }));
      return false;
    }
    setCategories((current) => ({
      ...current,
      choices: current.choices.includes(normalized) ? current.choices : [...current.choices, normalized],
      selected: current.selected.includes(normalized)
        ? current.selected
        : [...current.selected, normalized],
      invalidMessage: null,
    }));
    return true;
  }, []);

  const saveCategories = useCallback(async (): Promise<void> => {
    if (busyRef.current.categories) {
      return;
    }
    busyRef.current.categories = true;
    setError(null);
    setCategories((current) => ({ ...current, saving: true }));
    try {
      const result = await followCategories(
        servicesRef.current.client,
        categories.selected,
      );
      applyPersisted({ categories: result.categories });
      setCategories((current) => ({
        ...current,
        saving: false,
        saved: result.categories,
        savedToAccount: result.savedToAccount,
        invalidMessage: null,
      }));
    } catch (failure) {
      setCategories((current) => ({ ...current, saving: false }));
      setError(describeOnboardingError(failure));
    } finally {
      busyRef.current.categories = false;
    }
  }, [applyPersisted, categories.selected]);

  const setGuardianValue = useCallback((index: number, value: string) => {
    if (index < 0 || index >= GUARDIAN_COUNT) {
      return;
    }
    setGuardians((current) => {
      const values = [...current.values];
      values[index] = value;
      // Editing an input clears its own problem; list-level ones stay.
      return {
        ...current,
        values,
        problems: current.problems.filter((problem) => problem.index !== index),
      };
    });
  }, []);

  const saveGuardiansAction = useCallback(async (): Promise<void> => {
    if (busyRef.current.guardians) {
      return;
    }
    busyRef.current.guardians = true;
    setError(null);
    setGuardians((current) => ({ ...current, problems: [], saving: true }));
    try {
      const saved = await saveGuardians(
        servicesRef.current.client,
        did,
        guardians.values,
      );
      applyPersisted({ guardians: saved, guardiansSavedAt: new Date().toISOString() });
      setGuardians((current) => ({ ...current, saving: false, saved, problems: [] }));
    } catch (failure) {
      if (isGuardianSaveError(failure)) {
        setGuardians((current) => ({ ...current, saving: false, problems: failure.problems }));
      } else {
        setGuardians((current) => ({ ...current, saving: false }));
        setError(describeOnboardingError(failure));
      }
    } finally {
      busyRef.current.guardians = false;
    }
  }, [applyPersisted, did, guardians.values]);

  const completion = useMemo(
    () => onboardingStepCompletion(persisted, passkeyReady),
    [persisted, passkeyReady],
  );
  const steps = useMemo(
    () => ONBOARDING_STEPS.map((step) => ({ id: step.id, done: completion[step.id] })),
    [completion],
  );

  return {
    ready,
    did,
    passkeyReady,
    orcid,
    categories,
    guardians,
    steps,
    completedCount: countCompletedSteps(completion),
    totalCount: ONBOARDING_STEPS.length,
    // The API refuses submissions (403) until guardians are set, so this is
    // the one step the finish action is gated on.
    canFinish: completion.guardians,
    error,
    linkOrcid,
    toggleCategory,
    addCategory,
    saveCategories,
    setGuardianValue,
    saveGuardiansAction,
  };
}

// ---------------------------------------------------------------------------
// /onboarding/orcid — where ORCID sends the browser back to
// ---------------------------------------------------------------------------

/** The collaborators the ORCID return page needs; swappable in tests. */
export interface OrcidReturnServices {
  /** API client slice that finishes the link (sends the signed-in user's token). */
  client: Pick<ApiClient, "post">;
  /** Where the persisted onboarding progress lives. */
  storage: TokenStorage;
  /** The query string the browser arrived with (`?code=…&state=…`). */
  readSearch(): string;
  /** Drop the one-time `code` and `state` from the address bar and history entry. */
  clearSearch(): void;
}

/** The real API, real storage and the real address bar. */
export const defaultOrcidReturnServices: OrcidReturnServices = {
  client: apiClient,
  storage: browserTokenStorage,
  readSearch(): string {
    return typeof window === "undefined" ? "" : window.location.search;
  },
  clearSearch(): void {
    if (typeof window === "undefined") {
      return;
    }
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", pathname + hash);
  },
};

/** Inputs for {@link useOrcidReturn}. */
export interface UseOrcidReturnOptions {
  /** Service overrides, for tests. Defaults to the app-wide services. */
  services?: OrcidReturnServices;
}

/** How finishing the link went. */
export type OrcidReturnStatus = "completing" | "linked" | "failed";

/** What the `/onboarding/orcid` page renders. */
export interface UseOrcidReturnResult {
  /** `completing` until the API has answered (or the return is unusable). */
  status: OrcidReturnStatus;
  /** The ORCID iD that was linked, once `linked` and when the API said which. */
  orcid: string | null;
  /** Why the link did not happen, in plain language; `null` otherwise. */
  error: string | null;
  /** The failure is a signed-out session: offer sign-in. */
  sessionExpired: boolean;
}

const COMPLETING: UseOrcidReturnResult = {
  status: "completing",
  orcid: null,
  error: null,
  sessionExpired: false,
};

function failedReturn(error: string, sessionExpired = false): UseOrcidReturnResult {
  return { status: "failed", orcid: null, error, sessionExpired };
}

/**
 * Finish the ORCID link the user just authorised.
 *
 * On mount it reads `code` and `state` from the URL ORCID redirected to,
 * removes them from the address bar (they are one-time values that have no
 * business in history or a bookmark), and sends them to
 * `POST /v1/auth/orcid/complete` as the signed-in user. The API links the iD
 * only when that user is the one who started the flow, and otherwise answers
 * with a problem whose detail is shown as-is.
 *
 * It completes **once**: the state is single-use, so a second request (React
 * StrictMode mounts effects twice in development) would be refused as "already
 * used" and bury the success.
 */
export function useOrcidReturn(options: UseOrcidReturnOptions = {}): UseOrcidReturnResult {
  const servicesRef = useRef<OrcidReturnServices>(
    options.services ?? defaultOrcidReturnServices,
  );
  const [result, setResult] = useState<UseOrcidReturnResult>(COMPLETING);
  const startedRef = useRef(false);
  // Not a per-effect `active` flag: StrictMode runs this effect's cleanup and
  // then the effect again, and the one request must still be able to report.
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void (async () => {
        const services = servicesRef.current;
        const returned = parseOrcidReturn(services.readSearch());
        services.clearSearch();

        let next: UseOrcidReturnResult;
        if (returned.kind === "denied") {
          next = failedReturn(ORCID_RETURN_DENIED_MESSAGE);
        } else if (returned.kind === "missing") {
          next = failedReturn(ORCID_RETURN_MISSING_MESSAGE);
        } else {
          try {
            const linked = await completeOrcidLink(services.client, returned);
            updatePersistedOnboarding(services.storage, {
              orcidLinkedAt: new Date().toISOString(),
            });
            next = { status: "linked", orcid: linked.orcid, error: null, sessionExpired: false };
          } catch (failure) {
            next = failedReturn(
              describeOnboardingError(failure),
              failure instanceof ApiError && failure.isUnauthorized,
            );
          }
        }
        if (mountedRef.current) {
          setResult(next);
        }
      })();
    }
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return result;
}
