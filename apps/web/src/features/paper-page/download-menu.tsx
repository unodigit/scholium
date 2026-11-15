"use client";

/**
 * **Download ▾**, the paper page's download action (docs/design.md §5.2): a
 * button that opens a small menu of what can be saved, which today is the
 * paper's archive.
 *
 * ```tsx
 * <DownloadMenu href="https://…/v1/export/paper/sch%3Ak3f9-q2xz-7mwd.car" />
 * ```
 *
 * The archive is `GET /v1/export/paper/{id}.car`: every signed record, file and
 * log entry of the paper (all its versions, not only the one on screen) as one
 * file. The node sends it as an attachment, so choosing the item saves it
 * instead of opening it.
 *
 * **Without JavaScript it is still a link.** The server's HTML (and the first
 * client render, so hydration matches) is a plain link to the archive; once the
 * page runs it becomes the menu button.
 *
 * Accessibility, following the WAI-ARIA menu-button pattern: the button says it
 * opens a menu and whether it is open; opening it (click, Enter, Space or
 * ArrowDown) moves focus to the first item, ArrowUp opens it on the last; the
 * arrow keys, Home and End move between items; Escape closes it and puts focus
 * back on the button; Tab closes it and carries on to the next control; a click
 * anywhere else closes it. Each item is a real link, so it can be copied or
 * opened from the context menu. Every target is at least 44 px on touch.
 *
 * The menu stays in the page while closed (hidden) rather than being removed:
 * an item that is taken out of the page the moment it is chosen can lose the
 * download the browser was about to start.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { useEnhanced } from "./use-enhanced";

/** The action's name. */
export const DOWNLOAD_LABEL = "Download";

/** The archive's item: its name, and what is in it. */
export const ARCHIVE_ITEM_LABEL = "Paper archive";
export const ARCHIVE_ITEM_HINT =
  "The whole paper as one file: its signed records, files and log entries.";

export interface DownloadMenuProps {
  /** The paper's archive: `GET /v1/export/paper/{id}.car`. */
  readonly href: string;
}

export function DownloadMenu({ href }: DownloadMenuProps) {
  const enhanced = useEnhanced();

  if (!enhanced) {
    return (
      <a className="ppg-action" href={href} download title={ARCHIVE_ITEM_HINT}>
        {DOWNLOAD_LABEL}
      </a>
    );
  }
  return <DownloadMenuButton href={href} />;
}

function DownloadMenuButton({ href }: DownloadMenuProps) {
  const uid = useId();
  const menuId = `${uid}-menu`;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Which item to focus once the menu is showing: a hidden item cannot take
  // focus, so the focus move waits for the open state to commit.
  const focusOnOpen = useRef<"first" | "last">("first");

  const items = (): HTMLElement[] =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const focusItem = (which: "first" | "last"): void => {
    const stops = items();
    (which === "last" ? stops[stops.length - 1] : stops[0])?.focus();
  };

  const show = (which: "first" | "last"): void => {
    if (open) {
      focusItem(which);
      return;
    }
    focusOnOpen.current = which;
    setOpen(true);
  };

  const hide = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    // `focusItem` only reads refs, so it is the open state alone that matters.
    if (open) focusItem(focusOnOpen.current);
  }, [open]);

  // While open: a press outside closes it (and leaves focus where the reader
  // put it), and Escape closes it wherever focus is.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) {
        hide(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        hide(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, hide]);

  const onButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      show("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      show("last");
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const stops = items();
    const at = stops.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        // Past the last goes round to the first; from outside the items, to the first.
        stops[(at + 1) % stops.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        // Before the first goes round to the last; from outside the items, to the last.
        stops[at <= 0 ? stops.length - 1 : at - 1]?.focus();
        break;
      case "Home":
        event.preventDefault();
        stops[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        stops[stops.length - 1]?.focus();
        break;
      case "Tab":
        // Not prevented: focus goes to the button first, so Tab carries on to
        // the control after it and Shift+Tab to the one before.
        hide(true);
        break;
      default:
        break;
    }
  };

  return (
    <div className="ppg-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="ppg-action ppg-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? hide(false) : show("first"))}
        onKeyDown={onButtonKeyDown}
      >
        {DOWNLOAD_LABEL}
        {/* Decorative: the state is aria-expanded. */}
        <svg
          className="ppg-menu-chevron"
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
      <div
        ref={menu}
        id={menuId}
        className="ppg-menu-list"
        role="menu"
        aria-label={DOWNLOAD_LABEL}
        hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        <a
          className="ppg-menu-item"
          role="menuitem"
          tabIndex={-1}
          href={href}
          download
          onClick={() => hide(true)}
        >
          <span className="ppg-menu-item-name">{ARCHIVE_ITEM_LABEL}</span>
          <span className="ppg-menu-item-hint">{ARCHIVE_ITEM_HINT}</span>
        </a>
      </div>
    </div>
  );
}
