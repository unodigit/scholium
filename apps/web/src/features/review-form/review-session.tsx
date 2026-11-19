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

/** Whether the reviewer already has a review of this paper. */
export type OwnReviewState = "sealed" | "revealed" | null;

/** What the form does with a citation. */
export type CiteHandler = (citation: Citation) => void;

/** The state and the hand-offs the page's pieces share. */
export interface ReviewSession {
  /** The reviewer chose to sign with their name. Anonymous until they do. */
  readonly signed: boolean;
  /** Choose; ignored once the form is signing or sealed. */
  readonly setSigned: (signed: boolean) => void;
  /**
   * The reviewer's existing review of this paper is signed with their name.
   * The form calls it once it has read that review — from the dashboard, a
   * sealed copy on this device, or the record an update revises. The page then
   * starts in the signed state, so it never contradicts the published byline,
   * unless the reviewer has already chosen on this page.
   */
  readonly adoptSignedReview: () => void;
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
  /**
   * A form that would use the identity choice is on the page. A sealed or
   * revealed card has no form, so the choice is not offered there. It starts
   * true because the server's first HTML always carries the form; the form
   * says otherwise once a card replaces it.
   */
  readonly formActive: boolean;
  /** The form reports whether it is showing an editable form. */
  readonly setFormActive: (active: boolean) => void;
  /**
   * The reviewer's own review of this paper, as the server (or this device)
   * reports it. Decides how the conflict check is worded.
   */
  readonly ownReviewState: OwnReviewState;
  /** The form reports the review state it found. */
  readonly setOwnReviewState: (state: OwnReviewState) => void;
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
  // The page's first paint has the form (and the server's HTML cannot know
  // otherwise), so the choice starts offered; a card replaces it once a form
  // reports that it is not there.
  const [formActive, setFormActiveState] = useState(true);
  const [ownReviewState, setOwnReviewStateState] = useState<OwnReviewState>(null);

  const setFormActive = useCallback((active: boolean) => {
    setFormActiveState(active);
  }, []);

  const setOwnReviewState = useCallback((state: OwnReviewState) => {
    setOwnReviewStateState(state);
  }, []);

  // Read by callbacks that must not change identity, or go stale, with state.
  const phaseRef = useRef<FormPhase>("editing");
  const handlerRef = useRef<CiteHandler | null>(null);
  // The reviewer made the choice here; a review read later must not override
  // it. And the review's identity, once adopted, need not be adopted again.
  const chosenRef = useRef(false);
  const adoptedRef = useRef(initialSigned);

  const setPhase = useCallback((next: FormPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const setSigned = useCallback((next: boolean) => {
    // What the page says must be what the commitment covers.
    if (phaseRef.current !== "editing") return;
    chosenRef.current = true;
    setSignedState(next);
  }, []);

  const adoptSignedReview = useCallback(() => {
    // A choice already made here wins, and so does a commit already being
    // signed: its commitment covers what the page said when it started.
    // Unsigned needs no adoption — anonymous is where the page starts.
    if (chosenRef.current || adoptedRef.current) return;
    if (phaseRef.current === "signing") return;
    adoptedRef.current = true;
    setSignedState(true);
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
      adoptSignedReview,
      locked: phase !== "editing",
      canCite: attached && phase === "editing",
      cite,
      attachForm,
      setPhase,
      formActive,
      setFormActive,
      ownReviewState,
      setOwnReviewState,
    }),
    [
      signed,
      setSigned,
      adoptSignedReview,
      phase,
      attached,
      cite,
      attachForm,
      setPhase,
      formActive,
      setFormActive,
      ownReviewState,
      setOwnReviewState,
    ],
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
