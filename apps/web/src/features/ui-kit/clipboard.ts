/**
 * `copyText`: put a string on the system clipboard and say whether it worked.
 *
 * The async Clipboard API is tried first. It only exists in a secure context
 * (HTTPS or localhost) and it can be refused by the browser, so a failure
 * falls back to the legacy `execCommand("copy")` route, which still works on
 * a plain-HTTP node. Only when both fail does this resolve `false`.
 *
 * The result is a boolean rather than a thrown error because callers show it:
 * a "Copied" confirmation must never appear for text that was not copied.
 *
 * Call it directly from the click handler. Browsers only let a page write to
 * the clipboard during a user gesture, and the first await ends that window,
 * so nothing may be awaited before this is called.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions policy, unfocused document): try the legacy route.
    }
  }
  return legacyCopy(text);
}

/** Copy through a throwaway, off-screen `<textarea>` and `execCommand`. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  // Off-screen and inert, but not `display: none`: a hidden node cannot be
  // selected. Fixed position stops the page scrolling to it.
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";

  // `select()` moves focus into the textarea; put it back afterwards so a
  // keyboard user is not dropped at the top of the page.
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);

  let copied = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    if (previous && previous.isConnected) previous.focus?.();
  }
  return copied;
}
