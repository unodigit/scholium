"use client";

/**
 * Which rendition the reading column shows, HTML or PDF, and the two places
 * that care: the header's PDF and HTML actions, and the column itself.
 *
 * The header and the column are siblings on the server, so the choice lives in
 * a provider above both ({@link ReadingViewProvider}); the actions read it to
 * say which is current ({@link ReadingViewLink}), the column reads it to show
 * one ({@link ReadingViews}).
 *
 * **The PDF action is still a link.** Its `href` is the PDF file and it opens in
 * a new tab, so with no JavaScript, with a modified click (new tab, new
 * window, save) or on a phone it does exactly that. Only a plain click on a
 * screen wide enough for the column is taken over, to show the PDF in the
 * column. On a phone the PDF opens in the device's own viewer (docs/design.md
 * §10), which does zoom and text selection better than a canvas can.
 *
 * **The view is an address.** `#pdf` shows the PDF and `#reading` the HTML, so a
 * link can say which one it means and the back button works as it does for the
 * tabs: choosing the PDF replaces the address instead of adding to history, and
 * following the HTML action (a plain `#reading` link) is followed as any link.
 * The margin panel ignores both fragments (it only answers to its own tab ids),
 * and going back to an address with no fragment shows the HTML again.
 *
 * **The HTML is never unmounted.** Switching to the PDF hides the text rather
 * than removing it, so a half-written annotation and the reader's place
 * survive a look at the PDF. The PDF side costs nothing until it is first
 * chosen, and then stays, so going back and forth does not fetch it again.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { PdfView } from "./pdf-view";
import type { LoadPdfjs } from "./pdf-render";
import { READING_ID } from "./paper-links";
import { loadPdfjsWithSession } from "./reading";

export type ReadingViewId = "html" | "pdf";

/** The fragment that shows the PDF. The HTML's is {@link READING_ID}. */
export const PDF_HASH = "#pdf";

/** The fragment of the view it names, or `null` for any other fragment. */
export function viewFromHash(hash: string): ReadingViewId | null {
  const id = hash.replace(/^#/, "").trim().toLowerCase();
  if (id === "pdf") {
    return "pdf";
  }
  return id === READING_ID ? "html" : null;
}

/** Narrower than this and the PDF opens in the device's viewer instead. */
const PHONE_QUERY = "(max-width: 639px)";

/** Whether the screen is wide enough for the PDF to be shown in the column. */
function columnFitsPdf(): boolean {
  return (
    typeof window.matchMedia !== "function" || !window.matchMedia(PHONE_QUERY).matches
  );
}

interface ReadingViewState {
  readonly view: ReadingViewId;
  /** Whether the PDF can be shown in the column here: it exists, and the screen is wide enough. */
  readonly pdfHere: boolean;
  showPdf(): void;
}

const ReadingViewContext = createContext<ReadingViewState | null>(null);

export interface ReadingViewProviderProps {
  /** Whether the version has a PDF that can be opened. */
  readonly pdfAvailable: boolean;
  readonly children: ReactNode;
}

export function ReadingViewProvider({ pdfAvailable, children }: ReadingViewProviderProps) {
  const [view, setView] = useState<ReadingViewId>("html");
  const [wide, setWide] = useState(false);

  // Whether the column is wide enough for the PDF, kept current as the window
  // changes. Unknown (false) until the page runs, so the first paint and the
  // server's agree.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setWide(true);
      return;
    }
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setWide(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // The address names a view: on arrival (`/p/…#pdf`) and whenever a link to
  // one is followed. The server cannot see the fragment, so this is where an
  // address that names the PDF first takes effect.
  useEffect(() => {
    const follow = () => {
      const { hash } = window.location;
      const named = viewFromHash(hash);
      if (named === "pdf") {
        if (pdfAvailable && columnFitsPdf()) {
          setView("pdf");
        }
      } else if (named === "html" || hash.replace("#", "") === "") {
        // No fragment at all can only be reached by going back to where the
        // page was opened, which showed the HTML. Any other fragment (a
        // paragraph, a margin tab) says nothing about the view and leaves it.
        setView("html");
      }
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [pdfAvailable]);

  const showPdf = useCallback(() => {
    setView("pdf");
    if (window.location.hash !== PDF_HASH) {
      // A view of the same page, not a new page: replace, so the back button
      // leaves the paper instead of stepping through views.
      window.history.replaceState(null, "", PDF_HASH);
    }
  }, []);

  const state = useMemo<ReadingViewState>(
    () => ({
      // The PDF cannot be the view when it is not there to show.
      view: pdfAvailable ? view : "html",
      pdfHere: pdfAvailable && wide,
      showPdf,
    }),
    [pdfAvailable, view, wide, showPdf],
  );

  return <ReadingViewContext.Provider value={state}>{children}</ReadingViewContext.Provider>;
}

/** The view state, or `null` outside a provider (the page then behaves as a static one). */
function useReadingView(): ReadingViewState | null {
  return useContext(ReadingViewContext);
}

export interface ReadingViewLinkProps {
  /** The rendition this action stands for. */
  readonly view: ReadingViewId;
  readonly className: string;
  /** The PDF's file, or the HTML's fragment: where the link goes on its own. */
  readonly href: string;
  readonly children: ReactNode;
}

/**
 * The header's PDF or HTML action: a real link, marked as the current view.
 *
 * Server-rendered it is the link the page has always had (HTML current; PDF
 * opens in a new tab). Once the page runs, a plain click on PDF shows the PDF
 * in the column instead. The words a screen reader hears after "PDF" say which
 * of the two will happen.
 */
export function ReadingViewLink({ view, className, href, children }: ReadingViewLinkProps) {
  const state = useReadingView();
  const current = (state?.view ?? "html") === view;
  const inColumn = view === "pdf" && state?.pdfHere === true;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      view !== "pdf" ||
      state === null ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !columnFitsPdf()
    ) {
      return;
    }
    event.preventDefault();
    state.showPdf();
  };

  return view === "pdf" ? (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {children}
      <span className="ppg-visually-hidden">
        {inColumn ? " (shows the PDF on this page)" : " (opens in a new tab)"}
      </span>
    </a>
  ) : (
    <a className={className} href={href} aria-current={current ? "true" : undefined}>
      {children}
    </a>
  );
}

export interface ReadingViewsProps {
  /** Where the PDF is served, or `null` when this version has no PDF to open. */
  readonly pdfUrl: string | null;
  /** The HTML rendition: the abstract and the text, rendered by the server. */
  readonly children: ReactNode;
  /** How to fetch PDF.js. Tests pass their own. */
  readonly loadPdf?: LoadPdfjs;
}

/** The column's body: the HTML rendition, or the PDF in its place. */
export function ReadingViews({ pdfUrl, children, loadPdf }: ReadingViewsProps) {
  const state = useReadingView();
  const showing = state?.view ?? "html";
  // The PDF is mounted the first time it is chosen, and kept after that.
  const [opened, setOpened] = useState(false);
  if (showing === "pdf" && !opened) {
    setOpened(true);
  }

  return (
    <>
      <div className="ppg-view" hidden={showing === "pdf"}>
        {children}
      </div>
      {pdfUrl !== null && opened ? (
        <div className="ppg-view" hidden={showing !== "pdf"}>
          {/* The default loader carries the reader's token: an unlisted
              version's bytes are served only to its authors and moderators. */}
          <PdfView url={pdfUrl} loadPdf={loadPdf ?? loadPdfjsWithSession} />
        </div>
      ) : null}
    </>
  );
}
