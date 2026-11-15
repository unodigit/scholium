"use client";

/**
 * What the pieces of the review page share (spec feature 167).
 *
 * The review page is a server-rendered split view, but three of its parts have
 * to agree with one another:
 *
 * - **The anonymity notice** at the top of the right column offers "Sign with
 *   my name instead"; **the form** below it seals the choice into the commit
 *   and shows the stylometry tip only while the review is anonymous. Both read
 *   {@link ReviewSession.signed}.
 * - **The paper** on the left offers "Cite in review" for selected text; **the
 *   form** puts the quote into a justification box. The paper calls
 *   {@link ReviewSession.cite}; the form is what it reaches.
 * - **The form's phase** decides what may still change. While the commit is
 *   being signed, and once it is sealed, the choice to sign is fixed (what the
 *   page says must be what the commitment covers) and nothing may be cited.
 *
 * {@link ReviewSessionProvider} holds that state. `ReviewPage` mounts one
 * around the split view; a `ReviewForm` rendered on its own mounts its own, so
 * it works the same without the page.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Citation } from "./citation";

/** Where the form is: still editable, waiting on the passkey, or sealed. */
export type FormPhase = "editing" | "signing" | "sealed";

/** What the form does with a citation. */
export type CiteHandler = (citation: Citation) => void;

/** The state and the hand-offs the page's pieces share. */
export interface ReviewSession {
  /** The reviewer chose to sign with their name. Anonymous until they do. */
  readonly signed: boolean;
  /** Choose; ignored once the form is signing or sealed. */
  readonly setSigned: (signed: boolean) => void;
  /** The choice is fixed: the commit is being signed or is sealed. */
  readonly locked: boolean;
  /** A form is on the page and still takes a citation. */
  readonly canCite: boolean;
  /** Send a citation to the form (no-op when {@link canCite} is false). */
  readonly cite: (citation: Citation) => void;
  /** The form announces itself and what to call to cite; returns the undo. */
  readonly attachForm: (handler: CiteHandler) => () => void;
  /** The form reports where it is. */
  readonly setPhase: (phase: FormPhase) => void;
}

const SessionContext = createContext<ReviewSession | null>(null);

export interface ReviewSessionProviderProps {
  /** Start with the name option chosen (tests; a draft restored with it). */
  initialSigned?: boolean;
  children?: ReactNode;
}

/** Holds the page's shared state; renders no element of its own. */
export function ReviewSessionProvider({
  initialSigned = false,
  children,
}: ReviewSessionProviderProps) {
  const [signed, setSignedState] = useState(initialSigned);
  const [phase, setPhaseState] = useState<FormPhase>("editing");
  const [attached, setAttached] = useState(false);

  // Read by callbacks that must not change identity, or go stale, with state.
  const phaseRef = useRef<FormPhase>("editing");
  const handlerRef = useRef<CiteHandler | null>(null);

  const setPhase = useCallback((next: FormPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const setSigned = useCallback((next: boolean) => {
    // What the page says must be what the commitment covers.
    if (phaseRef.current !== "editing") return;
    setSignedState(next);
  }, []);

  const attachForm = useCallback((handler: CiteHandler) => {
    handlerRef.current = handler;
    setAttached(true);
    return () => {
      // Only undo our own attachment: a newer form may have taken over.
      if (handlerRef.current === handler) {
        handlerRef.current = null;
        setAttached(false);
      }
    };
  }, []);

  const cite = useCallback((citation: Citation) => {
    if (phaseRef.current !== "editing") return;
    handlerRef.current?.(citation);
  }, []);

  const value = useMemo<ReviewSession>(
    () => ({
      signed,
      setSigned,
      locked: phase !== "editing",
      canCite: attached && phase === "editing",
      cite,
      attachForm,
      setPhase,
    }),
    [signed, setSigned, phase, attached, cite, attachForm, setPhase],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * The page's shared state, or `null` outside a provider. A piece used on its
 * own (the notice, the paper) then does without it: it shows what it always
 * showed and offers nothing that needs the others.
 */
export function useReviewSession(): ReviewSession | null {
  return useContext(SessionContext);
}
