"use client";

/**
 * IdPill: a `sch:` id in monospace that copies on click and confirms with a
 * "Copied" toast (docs/design.md §2 "always copyable", §7).
 *
 * ```tsx
 * <IdPill schId="sch:k3f9-q2xz-7mwd/v3" />
 * <IdPill schId={paper.id} onCopied={(id) => track("id_copied", id)} />
 * ```
 *
 * Pass the whole id, `sch:` included: the pill shows and copies exactly the
 * string it is given (trimmed), and never rewrites it. The prop is `schId`
 * rather than `id` so it cannot be mistaken for the DOM `id` attribute.
 *
 * - It is a real `<button type="button">`, so Tab, Enter and Space work with
 *   no extra code. Its accessible name is "Copy <id>", which contains the
 *   visible text (WCAG 2.5.3).
 * - A click copies, shows the toast "Copied" in a polite live region (so it
 *   is announced, not just seen), and turns the copy glyph into a tick for two
 *   seconds. The tick is the pill's own confirmation: the toast alone would be
 *   lost to anyone who looks away.
 * - If the browser refuses to copy, the toast says "Couldn't copy" and the pill
 *   stays as it was. It never claims a copy that did not happen.
 * - Renders nothing for a blank id: there is nothing to copy.
 *
 * The toast needs no provider; see `./toast`. Plain `.ts` with `createElement`
 * rather than JSX because vitest cannot transform JSX in this app (tsconfig
 * sets `jsx: "preserve"`), and this keeps the real markup under test.
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import { copyText } from "./clipboard";
import { Icon } from "./icons";
import { ensureToastRegion, showToast } from "./toast";
import "./id-pill.css";

/** The toast shown after a successful copy (docs/design.md §7). */
export const COPIED_MESSAGE = "Copied";

/** The toast shown when the browser refuses to copy. */
export const COPY_FAILED_MESSAGE = "Couldn't copy";

/** How long the pill keeps its tick after a copy. */
export const COPIED_RESET_MS = 2000;

export interface IdPillProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "onClick" | "type"
  > {
  /** The id to show and copy, e.g. `sch:k3f9-q2xz-7mwd/v3`. */
  schId: string;
  /**
   * Called with the copied id after the clipboard accepted it, never on failure.
   *
   * Named `onCopied`, not `onCopy`: `onCopy` is already the DOM clipboard-event
   * handler (it fires on Ctrl+C), which still passes through to the button.
   */
  onCopied?: (schId: string) => void;
}

/** The `data-theme` of the nearest themed ancestor, so the toast can match it. */
function themeOf(element: Element): string | null {
  return element.closest("[data-theme]")?.getAttribute("data-theme") ?? null;
}

export function IdPill({
  schId,
  onCopied,
  className,
  ...rest
}: IdPillProps): ReactElement | null {
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCopiedRef = useRef(onCopied);

  // Keep the latest callback without re-creating the click handler.
  useEffect(() => {
    onCopiedRef.current = onCopied;
  }, [onCopied]);

  useEffect(() => {
    mounted.current = true;
    // Have the live region in the page before the first click, so the first
    // "Copied" is announced.
    ensureToastRegion();
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const value = typeof schId === "string" ? schId.trim() : "";
  if (value.length === 0) return null;

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    // Read the theme now: `currentTarget` is gone once the handler returns.
    const theme = themeOf(event.currentTarget);

    // Started synchronously, inside the click, which is what lets the browser
    // allow the clipboard write. Everything after the await is confirmation.
    void copyText(value).then((ok) => {
      if (!ok) {
        showToast(COPY_FAILED_MESSAGE, { theme });
        return;
      }

      showToast(COPIED_MESSAGE, { theme });

      if (mounted.current) {
        setCopied(true);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => {
          if (mounted.current) setCopied(false);
        }, COPIED_RESET_MS);
      }

      // Last, so a callback that throws cannot cost the reader the confirmation.
      onCopiedRef.current?.(value);
    });
  };

  return createElement(
    "button",
    {
      "aria-label": `Copy ${value}`,
      ...rest,
      type: "button",
      className: className ? `sch-id-pill ${className}` : "sch-id-pill",
      "data-copied": copied ? "true" : "false",
      onClick: handleClick,
    },
    createElement("span", { className: "sch-id-pill__id" }, value),
    createElement(Icon, {
      name: copied ? "check" : "copy",
      className: "sch-id-pill__icon",
    }),
  );
}
