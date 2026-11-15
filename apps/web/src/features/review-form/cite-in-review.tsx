"use client";

/**
 * **Cite in review**: the button that appears beside selected paper text
 * (spec feature 167, docs/design.md §5.5).
 *
 * `CiteInReview` wraps the paper's abstract and text. While a form is on the
 * page to receive a quote, it watches the document's selection; when the
 * reviewer has selected words inside the paper it floats a **Cite in review**
 * button just under the end of the selection. Pressing it hands the quote to
 * the form (see `citation.ts` for what is quoted and how it is named) and
 * clears the selection.
 *
 * How it behaves:
 *
 * - The button is absolutely placed inside the wrapper, so it scrolls with the
 *   text it belongs to and needs no scroll listener.
 * - While the pointer is down (a drag-select in progress) nothing is offered,
 *   and a button left from the last selection goes; the button appears once
 *   the reviewer lets go, or — for the keyboard and a touch selection, which
 *   have no pointer-up — when the selection has been still for a moment.
 * - Pressing the button does not take focus from the selection
 *   (`mousedown` is cancelled), so the selection survives to be quoted.
 * - A selection that reaches outside the paper (into the form, the page
 *   header) offers nothing: it is not only the paper's words.
 * - While the form is signing, or once it is sealed, nothing is offered: the
 *   draft may no longer change.
 * - **Escape** dismisses the button.
 *
 * Without a {@link ReviewSessionProvider} there is no form to cite into, so
 * the wrapper is just a `div` around its children.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Icon } from "../ui-kit/icons";
import { CITE_LABEL, citationFromSelection, type Citation } from "./citation";
import { useReviewSession } from "./review-session";
import "./review-cite.css";

/** How long a selection must be still before the button is offered (ms). */
export const SELECTION_SETTLE_MS = 120;

interface Offer {
  readonly citation: Citation;
  /** Where the selection ends, in pixels from the wrapper's top-left. */
  readonly x: number;
  readonly y: number;
}

function sameOffer(a: Offer | null, b: Offer): boolean {
  return (
    a !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.citation.quote === b.citation.quote &&
    a.citation.source === b.citation.source
  );
}

export function CiteInReview({ children }: { children?: ReactNode }) {
  const session = useReviewSession();
  const canCite = session?.canCite === true;

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!canCite || root === null) {
      setOffer(null);
      return undefined;
    }

    let dragging = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const update = (): void => {
      timer = undefined;
      // Mid-drag the selection is not the reviewer's yet; pointer-up looks again.
      if (dragging) return;
      const found = citationFromSelection(root, document.getSelection());
      if (found === null) {
        // A browser may collapse the selection as focus moves onto the button;
        // the button must not vanish from under the keyboard.
        const button = buttonRef.current;
        if (button !== null && button.contains(document.activeElement)) return;
        setOffer(null);
        return;
      }
      const box = root.getBoundingClientRect();
      const next: Offer = {
        citation: found.citation,
        x: found.point === null ? 0 : found.point.right - box.left,
        y: found.point === null ? 0 : found.point.bottom - box.top,
      };
      setOffer((current) => (sameOffer(current, next) ? current : next));
    };

    const schedule = (): void => {
      if (dragging) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(update, SELECTION_SETTLE_MS);
    };

    const onPointerDown = (event: Event): void => {
      // Pressing the button is not the start of a new selection; hiding it now
      // would take it from under the pointer before the click lands.
      const button = buttonRef.current;
      if (
        button !== null &&
        event.target instanceof Node &&
        button.contains(event.target)
      ) {
        return;
      }
      // `update` looks at nothing while this is set, so a pause already running
      // for the selection being replaced does nothing when it ends.
      dragging = true;
      // A new selection is starting: the old one's button no longer applies.
      setOffer(null);
    };
    const onPointerUp = (): void => {
      if (!dragging) return;
      dragging = false;
      schedule();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOffer(null);
    };

    root.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keydown", onKeyDown);
    // A selection made before the form could take a citation is still there.
    schedule();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      root.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canCite]);

  const cite = (): void => {
    if (offer === null || session === null) return;
    session.cite(offer.citation);
    document.getSelection()?.removeAllRanges();
    setOffer(null);
  };

  const position = offer === null
    ? undefined
    : ({ "--rc-x": `${offer.x}px`, "--rc-y": `${offer.y}px` } as CSSProperties);

  return (
    <div className="rc-root" ref={rootRef}>
      {children}
      {canCite && offer !== null ? (
        <div className="rc-offer" style={position}>
          <button
            ref={buttonRef}
            type="button"
            className="rc-button"
            // Keep the selection: pressing a button would otherwise move focus
            // off the text and, in some browsers, collapse it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={cite}
          >
            <Icon name="pencil" className="rc-button-icon" />
            {CITE_LABEL}
          </button>
        </div>
      ) : null}
    </div>
  );
}
