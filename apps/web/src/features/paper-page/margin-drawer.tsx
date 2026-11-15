"use client";

/**
 * The frame around the margin panel (docs/design.md §5.2, §10): where the panel
 * sits, and whether it can be put away.
 *
 * ```text
 * ≥ 1280 px      beside the paper, always in view (no toggle)
 * 1024–1279 px   a drawer on the right edge: a tab to open it, a bar to close it
 * < 1024 px      a bottom sheet: a bar above the tab bar to open it, and to close it
 * ```
 *
 * **One panel, restyled — not three panels.** The drawer and the sheet are the
 * same `MarginPanel` with the same six tabs; only the CSS around it changes with
 * the width (`paper-page.css`). That is what keeps a half-written reply, the open
 * tab and the running Proof check alive when a tablet turns or a window is
 * resized, and it means no second copy of any tab is ever mounted. The panel
 * stays mounted while collapsed; it is only taken out of the page (so it is out
 * of the tab order and away from assistive technology as well as out of sight).
 *
 * **Without JavaScript nothing collapses.** The server renders the panel in the
 * flow, after the text, exactly as before: the toggle is not in the HTML at all,
 * and the drawer and sheet styles apply only once `data-enhanced` is set. A
 * shared link, a crawler and a reader whose script failed still get the Reviews
 * tab.
 *
 * **It starts collapsed**, so the paper has the screen. It opens when the reader
 * asks (the toggle) or when the address names a tab (`/p/…#files`, `#proof`):
 * a tab is an address, and a link to one must not land inside a closed drawer.
 * It closes when the address moves to anywhere else on the page (the HTML or PDF
 * action, a paragraph), so the thing the reader asked to see is not behind it.
 * From 1280 px the open state means nothing, which is why changing it from the
 * address is harmless there.
 */

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { tabFromHash } from "./paper-links";

/** The id of the panel's body: what the toggle controls. */
export const MARGIN_BODY_ID = "ppg-margin-body";

/** The toggle's name. A word the page already uses for this panel (§1, §5.2). */
export const MARGIN_TOGGLE_LABEL = "Margin";

/** What is inside, said quietly beside the name, where the width allows it. */
const MARGIN_TOGGLE_HINT = "Reviews, discussion, proof";

export interface MarginDrawerProps {
  /** The margin panel. */
  readonly children: ReactNode;
}

const subscribeNever = (): (() => void) => () => {};
const onClient = (): boolean => true;
const onServer = (): boolean => false;

export function MarginDrawer({ children }: MarginDrawerProps) {
  // False in the server's HTML and while the browser hydrates it, true after:
  // the page has JavaScript from then on, so the panel may collapse.
  const enhanced = useSyncExternalStore(subscribeNever, onClient, onServer);
  const [open, setOpen] = useState(false);

  // The address decides: a tab opens the panel (on arrival, and whenever a link
  // to one is followed); any other fragment puts it away.
  useEffect(() => {
    const follow = () => {
      const { hash } = window.location;
      if (tabFromHash(hash) !== null) {
        setOpen(true);
      } else if (hash !== "") {
        setOpen(false);
      }
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  return (
    <aside
      className="ppg-margin"
      aria-label="Margin of the paper"
      data-enhanced={enhanced ? "true" : undefined}
      data-open={open ? "true" : "false"}
    >
      {enhanced ? (
        <button
          type="button"
          className="ppg-margin-toggle"
          aria-expanded={open}
          aria-controls={MARGIN_BODY_ID}
          onClick={() => setOpen((previous) => !previous)}
        >
          <span className="ppg-margin-toggle-label">{MARGIN_TOGGLE_LABEL}</span>
          <span className="ppg-margin-toggle-hint" aria-hidden="true">
            {MARGIN_TOGGLE_HINT}
          </span>
          {/* Decorative: the state is aria-expanded. CSS turns it to point the
              way the panel will move. */}
          <svg
            className="ppg-margin-chevron"
            width={16}
            height={16}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4.5 6.5 8 10l3.5-3.5" />
          </svg>
        </button>
      ) : null}
      <div className="ppg-margin-body" id={MARGIN_BODY_ID}>
        {children}
      </div>
    </aside>
  );
}
