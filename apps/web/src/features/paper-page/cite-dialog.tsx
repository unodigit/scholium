"use client";

/**
 * **Cite**, the paper page's citation action (docs/design.md §5.2, PRD READ-7):
 * a button that opens a dialog with the version on screen cited
 * as BibTeX and as RIS, each one copied with a click.
 *
 * ```tsx
 * <CiteDialog paperId="sch:k3f9-q2xz-7mwd" version={2}
 *             href="https://…/v1/papers/…/v2/cite?format=bibtex" />
 * ```
 *
 * Both entries are read from `GET /v1/papers/{id}/cite?format=bibtex|ris` when
 * the dialog opens (`cite.ts`), one request each, so a paper that was retracted
 * since the page was rendered is cited with its retraction note. What the node
 * says is what is shown and what is copied: nothing here edits a citation.
 *
 * **Without JavaScript it is still a link.** The server's HTML (and the first
 * client render, so hydration matches) is a plain link to the BibTeX that
 * opens in a new tab, which is what the action was before the dialog existed.
 * Once the page runs it becomes a button.
 *
 * Accessibility (docs/design.md §9): a modal dialog (`role="dialog"`,
 * `aria-modal`) named by its title and described by what it cites. Focus moves
 * into it on open, Tab and Shift+Tab stay inside it, Escape or a click on the
 * backdrop closes it, and focus goes back to the button that opened it. Each
 * citation sits in a read-only text field with its own label, so it can be
 * selected and copied by hand if the clipboard is refused; "Copied" is words
 * and an icon, announced from inside the dialog because a toast outside a
 * modal is not read out. Every control is at least 44 px on touch.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { copyText } from "../ui-kit/clipboard";
import { Icon } from "../ui-kit/icons";
import {
  CITE_FORMATS,
  describeCiteError,
  loadCitation,
  type CiteFormat,
  type LoadCitation,
} from "./cite";
import { useEnhanced } from "./use-enhanced";

/** The action's name. */
export const CITE_LABEL = "Cite";

/** The dialog's title. */
export const CITE_DIALOG_TITLE = "Cite this paper";

/** How long a Copy button says "Copied" before it offers to copy again. */
export const COPIED_FOR_MS = 2000;

/** The most lines a citation's field shows before it scrolls. */
const MAX_FIELD_ROWS = 12;

/** What can take focus inside the dialog, for keeping Tab inside it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CiteDialogProps {
  /** The paper, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** The version on screen: the one both citations name. */
  readonly version: number;
  /** The BibTeX, as a plain link: what the action is until the page runs. */
  readonly href: string;
  /** Replace the request, for tests. */
  readonly load?: LoadCitation;
}

export function CiteDialog({ paperId, version, href, load = loadCitation }: CiteDialogProps) {
  const enhanced = useEnhanced();

  if (!enhanced) {
    return (
      <a className="ppg-action" href={href} target="_blank" rel="noopener noreferrer">
        {CITE_LABEL}
        <span className="ppg-visually-hidden"> as BibTeX (opens in a new tab)</span>
      </a>
    );
  }
  return <CiteButton paperId={paperId} version={version} load={load} />;
}

interface CiteButtonProps {
  readonly paperId: string;
  readonly version: number;
  readonly load: LoadCitation;
}

function CiteButton({ paperId, version, load }: CiteButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Back to where the reader was. Not left to the browser: Safari does not
    // focus a button on click, so "where focus was" can be the page itself.
    trigger.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ppg-action"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {CITE_LABEL}
      </button>
      {open ? (
        <CitePanel paperId={paperId} version={version} load={load} onClose={close} />
      ) : null}
    </>
  );
}

interface CitePanelProps extends CiteButtonProps {
  readonly onClose: () => void;
}

function CitePanel({ paperId, version, load, onClose }: CitePanelProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const ledeId = `${uid}-lede`;
  const panel = useRef<HTMLDivElement>(null);

  // Take focus on open, and keep the page behind from scrolling under the
  // scrim. Once: this must not run again when a parent re-renders.
  useEffect(() => {
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  // Escape closes the dialog wherever focus is inside the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Tab goes round inside the dialog instead of out into the page behind it.
  const keepFocusInside = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || panel.current === null) return;

    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (stops.length === 0) {
      event.preventDefault();
      panel.current.focus();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="ppg-dialog-backdrop"
      // A press on the scrim itself, not on the dialog above it: pressing in
      // a field and dragging out to select text must not close the dialog.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="ppg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ledeId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <div className="ppg-dialog-header">
          <h2 id={titleId} className="ppg-dialog-title">
            {CITE_DIALOG_TITLE}
          </h2>
          <button
            type="button"
            className="ppg-dialog-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="cross" className="ppg-dialog-close-icon" />
          </button>
        </div>
        <p id={ledeId} className="ppg-dialog-lede">
          Both entries name the version on screen,{" "}
          <span className="ppg-cite-id">
            {paperId}/v{version}
          </span>
          .
        </p>
        {CITE_FORMATS.map((format) => (
          <CiteEntry
            key={format.id}
            format={format}
            paperId={paperId}
            version={version}
            load={load}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

type Entry =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly text: string }
  | { readonly phase: "failed"; readonly message: string };

type Copying = "idle" | "copied" | "refused";

interface CiteEntryProps {
  readonly format: CiteFormat;
  readonly paperId: string;
  readonly version: number;
  readonly load: LoadCitation;
}

/** One format: its heading, the node's text in a field, and a Copy button. */
function CiteEntry({ format, paperId, version, load }: CiteEntryProps) {
  const uid = useId();
  const headingId = `${uid}-heading`;
  const [entry, setEntry] = useState<Entry>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [copying, setCopying] = useState<Copying>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  // Read the citation on open, and again when the reader asks to try again. A
  // dialog closed before the answer arrives drops it.
  useEffect(() => {
    let current = true;
    setEntry({ phase: "loading" });
    setCopying("idle");
    void (async () => {
      try {
        const text = await load(paperId, version, format.id);
        if (current) setEntry({ phase: "ready", text });
      } catch (error) {
        if (current) {
          setEntry({ phase: "failed", message: describeCiteError(error, format.label) });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, format.id, format.label, load, paperId, version]);

  // `copyText` is called first thing in the click: the browser only lets a
  // page write to the clipboard during that gesture.
  const copy = async (text: string): Promise<void> => {
    const copied = await copyText(text);
    if (!mounted.current) return;
    clearTimeout(timer.current);
    if (!copied) {
      // Never "Copied" for text that was not copied.
      setCopying("refused");
      return;
    }
    setCopying("copied");
    timer.current = setTimeout(() => setCopying("idle"), COPIED_FOR_MS);
  };

  const ready = entry.phase === "ready";

  return (
    <section className="ppg-cite-entry" aria-labelledby={headingId}>
      <div className="ppg-cite-entry-head">
        <h3 id={headingId} className="ppg-cite-entry-title">
          {format.label}
        </h3>
        <button
          type="button"
          className="ppg-cite-copy"
          // The visible word is "Copy"; the name starts with it and adds which
          // one, because two buttons both named "Copy" cannot be told apart.
          aria-label={`${copying === "copied" ? "Copied" : "Copy"} ${format.label}`}
          disabled={!ready}
          onClick={() => {
            if (entry.phase === "ready") void copy(entry.text);
          }}
        >
          {copying === "copied" ? (
            <>
              <Icon name="check" className="ppg-cite-icon" />
              Copied
            </>
          ) : (
            "Copy"
          )}
        </button>
      </div>

      {entry.phase === "ready" ? (
        <textarea
          className="ppg-cite-text"
          readOnly
          wrap="off"
          spellCheck={false}
          rows={Math.min(entry.text.trimEnd().split("\n").length, MAX_FIELD_ROWS)}
          value={entry.text}
          aria-labelledby={headingId}
        />
      ) : null}

      {entry.phase === "loading" ? (
        <p className="ppg-cite-loading">Loading the {format.label}…</p>
      ) : null}

      {entry.phase === "failed" ? (
        <div className="ppg-cite-error" role="alert">
          <Icon name="alert" className="ppg-cite-icon ppg-cite-icon--critical" />
          <span className="ppg-cite-error-text">{entry.message}</span>
          <button
            type="button"
            className="ppg-cite-retry"
            aria-label={`Try again loading the ${format.label}`}
            onClick={() => setAttempt((previous) => previous + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}

      {copying === "refused" ? (
        <p className="ppg-cite-error" role="alert">
          <Icon name="alert" className="ppg-cite-icon ppg-cite-icon--critical" />
          <span className="ppg-cite-error-text">
            Couldn’t copy. Select the text above and copy it by hand.
          </span>
        </p>
      ) : null}

      {/* Always mounted, so the confirmation is announced when it is written. */}
      <p className="ppg-visually-hidden" role="status">
        {copying === "copied" ? `${format.label} copied to the clipboard.` : ""}
      </p>
    </section>
  );
}
