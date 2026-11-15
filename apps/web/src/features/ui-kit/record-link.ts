"use client";

/**
 * RecordLink: "View record" opens the raw signed JSON in a side sheet
 * (docs/design.md §7).
 *
 * ```tsx
 * <RecordLink cid={paper.recordCid} />
 * <RecordLink cid={recordCid} label="View this version" />
 * ```
 *
 * The sheet reads `GET /v1/records/{cid}` and shows the response verbatim as
 * pretty-printed JSON: no summary, no rearranged fields, nothing hidden. If
 * the record cannot be read, the sheet says so in one sentence and offers
 * "Try again"; it never shows a stale or partial record.
 *
 * It is a modal side sheet, so it behaves like one:
 * - the trigger is a real `<button>` (it opens a panel, it does not navigate)
 *   with `aria-haspopup="dialog"` and `aria-expanded`;
 * - the panel is `role="dialog" aria-modal="true"`, labelled by its heading
 *   and described by the record id;
 * - focus moves to Close on open, Tab and Shift+Tab stay inside, Escape and
 *   Close dismiss it, and focus returns to the trigger afterwards;
 * - the page behind it does not scroll while it is open.
 *
 * Plain `.ts` with `createElement` rather than JSX because vitest cannot
 * transform JSX in this app (tsconfig sets `jsx: "preserve"`), and this keeps
 * the real markup under test.
 */

import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import { api, ApiError, NetworkError } from "../../lib/api";
import "./record-link.css";

/** The record collection, relative to the API client's `/v1` prefix. */
export const RECORD_PATH = "/records";

/** Fetches one record; the resolved value is what the sheet shows as JSON. */
export type RecordLoader = (
  cid: string,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Read one stored envelope from `GET /v1/records/{cid}`.
 *
 * The route is public, so no bearer token is sent. The cid is URL-encoded:
 * a record id is base32 today, but nothing here assumes it.
 */
export async function fetchRecordJson(
  cid: string,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  return api.get<unknown>(`${RECORD_PATH}/${encodeURIComponent(cid)}`, {
    auth: false,
    signal: options.signal,
  });
}

/** Pretty-print a record for the sheet, with two spaces per level. */
export function formatRecordJson(record: unknown): string {
  try {
    return JSON.stringify(record, null, 2) ?? "";
  } catch {
    // A cyclic or BigInt-bearing value is not JSON; the sheet then reports an
    // empty record rather than throwing inside a render.
    return "";
  }
}

/**
 * One plain sentence for a failed read.
 *
 * The API's problem details are technical ("this node's event log"); the
 * sheet speaks the vocabulary of docs/design.md §8, so 404 and transport
 * failures get their own sentence and everything else shares one.
 */
export function recordErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 404
      ? "This record is not on this server."
      : "This record could not be loaded. Try again.";
  }
  if (error instanceof NetworkError) {
    return "The server could not be reached. Try again.";
  }
  return "This record could not be loaded. Try again.";
}

/** What the sheet is doing: nothing yet, loading, showing, or failed. */
type SheetState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; json: string }
  | { kind: "error"; message: string };

/** Elements that take focus inside the sheet, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface RecordLinkProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "onClick" | "type"
  > {
  /** The record to read: the `{cid}` of `GET /v1/records/{cid}`. */
  cid: string;
  /** Trigger text. Defaults to "View record" (docs/design.md §7). */
  label?: string;
  /** Heading inside the sheet. Defaults to "Signed record". */
  title?: string;
  /** Fetch implementation. Defaults to {@link fetchRecordJson}. */
  loadRecord?: RecordLoader;
  /** Called with `true` when the sheet opens and `false` when it closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The record link and its side sheet.
 *
 * Renders nothing when `cid` is blank: a link with no record to read would
 * open a sheet that can only fail. An empty string from an API response is
 * treated as "there is no record link here", not as an error.
 */
export function RecordLink({
  cid,
  label = "View record",
  title = "Signed record",
  loadRecord = fetchRecordJson,
  onOpenChange,
  className,
  ...rest
}: RecordLinkProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SheetState>({ kind: "idle" });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const loaderRef = useRef(loadRecord);
  const loadedCid = useRef(cid);

  const headingId = useId();
  const cidId = useId();
  const panelId = useId();

  const usableCid = typeof cid === "string" && cid.trim().length > 0;

  // Keep the latest loader without making it an effect dependency: an inline
  // arrow prop would otherwise restart the request on every render.
  useEffect(() => {
    loaderRef.current = loadRecord;
  }, [loadRecord]);

  const load = useCallback(() => {
    if (!usableCid) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "loading" });

    void (async () => {
      try {
        const record = await loaderRef.current(cid, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const json = formatRecordJson(record);
        setState(
          json.length > 0
            ? { kind: "ready", json }
            : { kind: "error", message: "The server returned an empty record." },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: recordErrorMessage(error) });
      }
    })();
  }, [cid, usableCid]);

  const openSheet = useCallback(() => {
    if (!usableCid) return;
    setOpen(true);
    onOpenChange?.(true);
    load();
  }, [load, onOpenChange, usableCid]);

  const closeSheet = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setOpen(false);
    setState({ kind: "idle" });
    onOpenChange?.(false);
  }, [onOpenChange]);

  // A different record needs a different sheet, whether or not it is open.
  useEffect(() => {
    if (loadedCid.current === cid) return;
    loadedCid.current = cid;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ kind: "idle" });
    if (open) load();
  }, [cid, load, open]);

  // Focus, scroll lock, and the return of focus to the trigger.
  useEffect(() => {
    if (!open) return;

    const previous =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    closeRef.current?.focus();

    const body = typeof document !== "undefined" ? document.body : null;
    const previousOverflow = body?.style.overflow ?? "";
    if (body) body.style.overflow = "hidden";

    return () => {
      if (body) body.style.overflow = previousOverflow;
      const target =
        previous && previous.isConnected ? previous : triggerRef.current;
      target?.focus?.();
    };
  }, [open]);

  // A request in flight must not outlive the component.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSheet();
      return;
    }
    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Clicking the scrim dismisses, but a mousedown inside the panel (including
  // a drag that ends on the scrim) must not.
  const handleScrimMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) closeSheet();
  };

  if (!usableCid) return null;

  const trigger = createElement(
    "button",
    {
      ...rest,
      ref: triggerRef,
      type: "button",
      className: className ? `sch-record-link ${className}` : "sch-record-link",
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      "aria-controls": open ? panelId : undefined,
      onClick: openSheet,
    },
    label,
  );

  if (!open) return trigger;

  const body =
    state.kind === "loading"
      ? createElement(
          "p",
          {
            className: "sch-record-sheet__status",
            role: "status",
          },
          "Loading record…",
        )
      : state.kind === "error"
        ? createElement(
            "div",
            { className: "sch-record-sheet__error", role: "alert" },
            createElement("p", null, state.message),
            createElement(
              "button",
              {
                type: "button",
                className: "sch-record-sheet__retry",
                onClick: load,
              },
              "Try again",
            ),
          )
        : state.kind === "ready"
          ? createElement(
              "pre",
              { className: "sch-record-sheet__json" },
              createElement("code", null, state.json),
            )
          : null;

  return createElement(
    Fragment,
    null,
    trigger,
    createElement(
      "div",
      { className: "sch-record-sheet", onMouseDown: handleScrimMouseDown },
      createElement(
        "div",
        {
          ref: panelRef,
          id: panelId,
          className: "sch-record-sheet__panel",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": headingId,
          "aria-describedby": cidId,
          onKeyDown: handleKeyDown,
        },
        createElement(
          "header",
          { className: "sch-record-sheet__header" },
          createElement(
            "div",
            { className: "sch-record-sheet__heading" },
            createElement(
              "p",
              { className: "sch-record-sheet__kicker" },
              "Raw signed JSON",
            ),
            createElement(
              "h2",
              { id: headingId, className: "sch-record-sheet__title" },
              title,
            ),
            createElement(
              "p",
              { id: cidId, className: "sch-record-sheet__cid" },
              cid,
            ),
          ),
          createElement(
            "button",
            {
              ref: closeRef,
              type: "button",
              className: "sch-record-sheet__close",
              onClick: closeSheet,
            },
            "Close",
          ),
        ),
        createElement("div", { className: "sch-record-sheet__body" }, body),
      ),
    ),
  );
}
