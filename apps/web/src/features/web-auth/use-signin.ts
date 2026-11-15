/**
 * State machine behind the `/signin` card.
 *
 * Kept apart from the markup (`signin-form.tsx`) so the behaviour — one flow
 * at a time, progress copy, failure copy, redirect — is unit-testable without
 * a JSX transform.
 */

import { useEffect, useRef, useState } from "react";

import { deviceKey } from "./device-key";
import {
  signIn,
  type SignInOptions,
  type SignInResult,
  type SignInStage,
} from "./signin";
import {
  SIGNIN_STAGE_MESSAGES,
  SIGNIN_SUCCESS_MESSAGE,
  describeSignInError,
} from "./signin-messages";

/** The two things the sign-in UI needs from the auth layer; swappable in tests. */
export interface SignInAuth {
  /** Run the whole sign-in flow. */
  signIn(options: SignInOptions): Promise<SignInResult>;
  /** True when this browser can create and use the device key. */
  isSupported(): boolean;
}

/** The app-wide auth layer: the real device key and the real API. */
export const defaultSignInAuth: SignInAuth = {
  signIn,
  isSupported: () => deviceKey.isSupported(),
};

/** Inputs for {@link useSignIn}. */
export interface UseSignInOptions {
  /** Where a returning user should land (from `?next=`); sanitised by `signIn`. */
  next?: string;
  /** Called with the destination once the sign-in has succeeded. */
  navigate: (path: string) => void;
  /** Auth layer override, for tests. */
  auth?: SignInAuth;
}

/** What the sign-in UI renders. */
export interface SignInState {
  /** A sign-in is running (passkey prompt or network). */
  working: boolean;
  /** The sign-in succeeded and navigation has been requested. */
  done: boolean;
  /** The browser cannot create a passkey-protected key (known after mount). */
  unsupported: boolean;
  /** One line describing the current step; empty when idle. */
  progress: string;
  /** Why the last attempt failed, in plain language; `null` otherwise. */
  error: string | null;
  /** Start a sign-in. A call while one is running is ignored. */
  start(): Promise<void>;
}

type Phase = "idle" | "working" | "done";

/** Drive a sign-in from a button. */
export function useSignIn({
  next,
  navigate,
  auth = defaultSignInAuth,
}: UseSignInOptions): SignInState {
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState<SignInStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `null` until the browser has been asked, so server and first client
  // render agree.
  const [supported, setSupported] = useState<boolean | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setSupported(auth.isSupported());
    return () => {
      mounted.current = false;
    };
  }, [auth]);

  async function start(): Promise<void> {
    // A second click while a passkey sheet is open must not start a second flow.
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setError(null);
    setStage(null);
    setPhase("working");

    let result: SignInResult;
    try {
      result = await auth.signIn({
        next,
        onProgress: (nextStage) => {
          if (mounted.current) {
            setStage(nextStage);
          }
        },
      });
    } catch (failure) {
      if (mounted.current) {
        setError(describeSignInError(failure));
        setStage(null);
        setPhase("idle");
      }
      return;
    } finally {
      inFlight.current = false;
    }

    // Outside the try: the user *is* signed in, so a navigation hiccup must
    // not be reported as a failed sign-in.
    if (mounted.current) {
      setPhase("done");
      setStage(null);
    }
    navigate(result.redirectTo);
  }

  const progress =
    phase === "done"
      ? SIGNIN_SUCCESS_MESSAGE
      : stage
        ? SIGNIN_STAGE_MESSAGES[stage]
        : phase === "working"
          ? "Starting…"
          : "";

  return {
    working: phase === "working",
    done: phase === "done",
    unsupported: supported === false,
    progress,
    error,
    start,
  };
}
