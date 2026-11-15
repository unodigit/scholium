/**
 * Toast: a short confirmation that appears, is announced, and goes away by
 * itself (docs/design.md §7: the ID pill's "Copied").
 *
 * ```ts
 * showToast("Copied");
 * showToast("Couldn't copy", { duration: 4000 });
 * dismissToast();
 * ```
 *
 * It is a function, not a component, so it needs no provider and no edit to a
 * shared layout: whichever component wants to confirm something can call it.
 * The toast lives in one `role="status"` region appended to `<body>`, so
 * - a newer toast replaces the one on screen instead of stacking under it,
 * - the region exists before the first message, which is what lets screen
 *   readers announce that message (a live region inserted together with its
 *   text is often skipped), and
 * - it is outside every component tree, so it is never clipped by an
 *   `overflow: hidden` ancestor and sits above the record side sheet.
 *
 * The region is created lazily and only in a browser; calling these during
 * server rendering does nothing. Create it from an effect or an event
 * handler, never during render, so hydration never sees it.
 */

import "./toast.css";

/** `id` of the live region every toast is written into. */
export const TOAST_REGION_ID = "sch-toast-region";

/** How long a toast stays up unless the caller says otherwise. */
export const TOAST_DURATION_MS = 2000;

export interface ShowToastOptions {
  /** Milliseconds before the toast goes away. Defaults to {@link TOAST_DURATION_MS}. */
  duration?: number;
  /**
   * A `data-theme` value (`"dark"` or `"light"`) to render the toast in.
   * The region sits on `<body>`, outside any themed subtree, so a caller
   * inside one passes its theme to keep the toast matching what it sits in.
   */
  theme?: string | null;
}

let dismissTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The live region toasts are written into, created on first use.
 *
 * Returns `null` outside a browser. Components call this when they mount so
 * the region is already in the page, and announced to assistive technology,
 * before the first toast is shown.
 */
export function ensureToastRegion(): HTMLElement | null {
  if (typeof document === "undefined") return null;

  const existing = document.getElementById(TOAST_REGION_ID);
  if (existing) return existing;

  const region = document.createElement("div");
  region.id = TOAST_REGION_ID;
  region.className = "sch-toast-region";
  region.setAttribute("role", "status");
  // `role="status"` implies polite, but older assistive technology wants it said.
  region.setAttribute("aria-live", "polite");
  document.body.appendChild(region);
  return region;
}

/**
 * Show `message`, replacing any toast already on screen, and remove it after
 * `options.duration`. A blank message is ignored: an empty toast is noise.
 */
export function showToast(message: string, options: ShowToastOptions = {}): void {
  if (typeof message !== "string" || message.trim().length === 0) return;

  const region = ensureToastRegion();
  if (!region) return;

  const duration =
    Number.isFinite(options.duration) && (options.duration as number) > 0
      ? (options.duration as number)
      : TOAST_DURATION_MS;

  // A fresh element each time, so the same text shown twice is announced twice.
  const toast = document.createElement("div");
  toast.className = "sch-toast";
  if (options.theme) toast.setAttribute("data-theme", options.theme);
  toast.textContent = message;

  clearTimeout(dismissTimer);
  region.replaceChildren(toast);
  dismissTimer = setTimeout(dismissToast, duration);
}

/** Remove the toast now, if one is showing. The live region stays. */
export function dismissToast(): void {
  clearTimeout(dismissTimer);
  dismissTimer = undefined;
  if (typeof document === "undefined") return;
  document.getElementById(TOAST_REGION_ID)?.replaceChildren();
}
