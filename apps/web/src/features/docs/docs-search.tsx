"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

/**
 * The docs home's search field.
 *
 * The index is built on the server from `docs/handbook/`
 * (`docs-index.tsx` → `buildDocsSearchIndex`) and handed to this module as
 * plain `{ title, href, chapter }` entries, so no file-system code reaches the
 * browser bundle. This component only filters what it was given: as the reader
 * types, the chapter titles, the `##` / `###` headings and the glossary terms
 * appear as links to `/docs/{slug}#{anchor}` with the chapter name beside each.
 *
 * It is progressive enhancement, not a requirement: the chapter cards and
 * every other link on `/docs` are server-rendered and work without JavaScript.
 * The field is a plain `<input type="search">` inside a search landmark, so it
 * is announced and reachable even before hydration.
 *
 * `/` focuses the field from anywhere on the page, except while the reader is
 * already typing in a field or holding a modifier (so browser shortcuts such
 * as Ctrl+F are never taken over).
 */

/** One thing the docs home can find: a chapter, a section or a glossary term. */
export interface DocsSearchEntry {
  /** The visible text: the chapter title, heading or glossary term. */
  readonly title: string;
  /** Where the match opens, e.g. `/docs/your-account#sign-in-with-a-passkey`. */
  readonly href: string;
  /** The chapter the entry belongs to, shown beside the link. */
  readonly chapter: string;
}

/** How many matches the field lists at most. */
export const MAX_DOCS_SEARCH_RESULTS = 12;

/**
 * The matches for a query, in the index's own order: the chapters in number
 * order, each chapter's sections below it, then the chapter 11 glossary terms.
 * Every word of the query must appear in the title (case-insensitively), so
 * "sign fails" finds "If sign-in fails".
 */
export function searchDocs(
  entries: readonly DocsSearchEntry[],
  query: string,
): DocsSearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const words = needle.split(/\s+/);
  return entries
    .filter((entry) => {
      const title = entry.title.toLowerCase();
      return words.every((word) => title.includes(word));
    })
    .slice(0, MAX_DOCS_SEARCH_RESULTS);
}

/** Whether a key press on `/` should leave the reader's typing alone. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export interface DocsSearchProps {
  /** The searchable index, built on the server by `docs-index.tsx`. */
  entries: readonly DocsSearchEntry[];
}

/** The docs home's search field and its live list of matches. */
export function DocsSearch({ entries }: DocsSearchProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const resultsId = useId();
  const hintId = useId();

  // `/` is the field's shortcut. The listener is on the document so it works
  // wherever the reader is on the page, and it stands aside for a typing
  // surface or a modified chord.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key !== "/") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const trimmed = query.trim();
  const matches = searchDocs(entries, query);

  return (
    <div className="mt-8">
      <form
        role="search"
        aria-label="Docs search"
        className="mt-1"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <label
            htmlFor={inputId}
            className="font-sans text-ui font-medium text-ink"
          >
            Search the docs
          </label>
          <p id={hintId} className="font-sans text-meta text-ink-2">
            Press <kbd className="rounded-control border border-rule bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-mono">/</kbd>{" "}
            to search
          </p>
        </div>
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Titles, sections and the glossary"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-keyshortcuts="/"
          aria-describedby={hintId}
          aria-controls={resultsId}
          className="mt-2 w-full rounded-control border border-rule bg-surface px-3 py-2 font-sans text-ui text-ink placeholder:text-ink-2"
        />
      </form>

      {/*
        Live region: a reader who searches with a screen reader hears each new
        result list replace the last. The visible list is the whole result set
        (never more than MAX_DOCS_SEARCH_RESULTS), so nothing is hidden here.
      */}
      <div
        id={resultsId}
        aria-live="polite"
        aria-atomic="false"
        className="mt-3"
      >
        {trimmed === "" ? null : matches.length === 0 ? (
          <p className="font-sans text-ui text-ink-2">
            No matches for “{trimmed}”.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {matches.map((match) => (
              <li key={`${match.href} ${match.title}`} className="flex flex-wrap items-baseline gap-x-2">
                <Link href={match.href} className="font-sans text-ui text-accent">
                  {match.title}
                </Link>
                {/* A chapter's own title is the chapter name; say it once. */}
                {match.chapter === match.title ? null : (
                  <span className="font-sans text-meta text-ink-2">
                    {match.chapter}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default DocsSearch;
