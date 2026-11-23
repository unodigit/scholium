"use client";

/**
 * One handbook chapter, as the docs shell renders it at `/docs/{slug}`.
 *
 * The page is the reading column of a chapter:
 *
 * 1. the "Chapter N" eyebrow, the H1 and the summary from README.md's table;
 * 2. the chapter video, behind a click (`chapter-video.tsx`);
 * 3. the Markdown body with its screenshots, rendered on the server
 *    (`markdown.tsx`) and handed in as `children`, so `node:fs` never reaches
 *    the browser bundle;
 * 4. previous and next chapter links, absent at either end of the handbook.
 *
 * "On this page" is the list of the chapter's `##` and `###` headings. One
 * list, two shapes, decided by the same 1100px breakpoint as the docs shell
 * (`chapter.css`):
 *
 * - 1100px and wider: a sticky list in the right margin, beside the article;
 * - below that: a "On this page" disclosure above the article. It is a native
 *   `<details>`, so it opens and closes without JavaScript, and the server
 *   renders it open so every heading link is in the first HTML.
 *
 * The list marks the section in view with `aria-current="location"`, driven by
 * an `IntersectionObserver` (the fallback the modern-web scrollspy guidance
 * prescribes where `scroll-target-group` / `:target-current` is unavailable).
 * The active link is styled with accent colour *and* semibold weight and an
 * indicator bar, never colour alone.
 *
 * This is a client module because the scrollspy and the disclosure's
 * breakpoint behaviour need the DOM. The article's Markdown arrives as
 * children, so the server-rendered body is unaffected.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ChapterVideo } from "./chapter-video";
import type { HandbookHeading, HandbookVideo } from "./handbook";

import "./chapter.css";

/** A previous or next chapter: enough to render the link. */
export interface ChapterLink {
  readonly title: string;
  readonly href: string;
}

/** Props for {@link ChapterPage}. */
export interface ChapterPageProps {
  /** The chapter number, 1 to 11, shown as "Chapter N" above the H1. */
  number: number;
  /** The chapter title without its number, e.g. `Your account`. */
  title: string;
  /** The README.md summary: one line on what the chapter is for. */
  summary: string;
  /** The chapter's `##` and `###` headings, in document order. */
  headings: readonly HandbookHeading[];
  /** The chapter's video entry, or null when it has none. */
  video: HandbookVideo | null;
  /** The video transcript's paragraphs, read on the server. */
  transcript?: readonly string[];
  /** The chapter before this one, or null for Chapter 1. */
  previous: ChapterLink | null;
  /** The chapter after this one, or null for Chapter 11. */
  next: ChapterLink | null;
  /** The server-rendered Markdown body, screenshots included. */
  children: ReactNode;
}

/** The width at which the contents list becomes the right margin column. */
const SIDEBAR_QUERY = "(min-width: 1100px)";

/** The band of the viewport in which a heading counts as the section in view. */
const SPY_ROOT_MARGIN = "-20% 0px -60% 0px";

/** A chevron for the "On this page" disclosure; it turns when opened. */
function Chevron() {
  return (
    <svg
      className="chapter-toc-chevron"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

/**
 * "On this page": the chapter's headings, with the one being read marked.
 *
 * The same `<details>` serves both shapes. At 1100px and wider its summary is
 * hidden and the list is the sticky right column; a reader who collapsed it on
 * a narrow window gets it back when the window grows, since the wide layout has
 * no trigger to reopen it. Collapsing on the way down stays the reader's
 * choice.
 */
function ContentsList({ headings }: { headings: readonly HandbookHeading[] }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // The summary is the trigger below 1100px and is hidden above it.
  useEffect(() => {
    const details = detailsRef.current;
    if (!details || typeof window.matchMedia !== "function") return;
    const sidebar = window.matchMedia(SIDEBAR_QUERY);
    const reveal = () => {
      if (sidebar.matches) details.open = true;
    };
    reveal();
    sidebar.addEventListener("change", reveal);
    return () => sidebar.removeEventListener("change", reveal);
  }, []);

  // Highlight the section crossing the reading band. The observer is the
  // documented fallback for browsers without `scroll-target-group`; the last
  // heading in document order that is in the band wins, so two headings close
  // together resolve the way the page reads.
  useEffect(() => {
    if (headings.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;

    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) inBand.add(id);
          else inBand.delete(id);
        }
        let current: string | null = null;
        for (const heading of headings) {
          if (inBand.has(heading.id)) current = heading.id;
        }
        if (current !== null) setActiveId(current);
      },
      { rootMargin: SPY_ROOT_MARGIN, threshold: 0 },
    );

    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null);
    for (const element of elements) observer.observe(element);

    // A link to /docs/slug#heading starts with that section active, before
    // scrolling moves the band.
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (id !== "" && headings.some((heading) => heading.id === id)) {
        setActiveId(id);
      }
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);

    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", fromHash);
    };
  }, [headings]);

  return (
    <nav className="chapter-toc" aria-label="On this page">
      {/* Visible in the wide layout, where the disclosure trigger is hidden. */}
      <h2 className="chapter-toc-title">On this page</h2>
      <details className="chapter-toc-details" open ref={detailsRef}>
        <summary className="chapter-toc-toggle">
          <Chevron />
          On this page
        </summary>
        <ol className="chapter-toc-list">
          {headings.map((heading) => (
            <li
              className="chapter-toc-item"
              key={heading.id}
              data-level={heading.level}
            >
              <a
                className="chapter-toc-link"
                href={`#${heading.id}`}
                aria-current={activeId === heading.id ? "location" : undefined}
                onClick={() => setActiveId(heading.id)}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ol>
      </details>
    </nav>
  );
}

/** Previous and next chapter links, with no link at either end of the book. */
function ChapterPager({
  previous,
  next,
}: {
  previous: ChapterLink | null;
  next: ChapterLink | null;
}) {
  if (previous === null && next === null) return null;

  return (
    <nav className="chapter-pager" aria-label="Previous and next chapter">
      {previous !== null && (
        <Link
          className="chapter-pager-link chapter-pager-previous"
          href={previous.href}
          rel="prev"
        >
          <span className="chapter-pager-label">
            <span aria-hidden="true">←</span> Previous chapter
          </span>
          <span className="chapter-pager-title">{previous.title}</span>
        </Link>
      )}
      {next !== null && (
        <Link
          className="chapter-pager-link chapter-pager-next"
          href={next.href}
          rel="next"
        >
          <span className="chapter-pager-label">
            Next chapter <span aria-hidden="true">→</span>
          </span>
          <span className="chapter-pager-title">{next.title}</span>
        </Link>
      )}
    </nav>
  );
}

/** One chapter: eyebrow, title, summary, video, body, contents and pager. */
export function ChapterPage({
  number,
  title,
  summary,
  headings,
  video,
  transcript,
  previous,
  next,
  children,
}: ChapterPageProps) {
  return (
    <div className="chapter-page">
      <ContentsList headings={headings} />

      <article className="chapter-article" aria-labelledby="chapter-title">
        <p className="chapter-eyebrow">Chapter {number}</p>
        <h1 className="chapter-title" id="chapter-title">
          {title}
        </h1>
        {summary !== "" && <p className="chapter-summary">{summary}</p>}

        {video !== null && (
          <ChapterVideo
            className="chapter-video-block"
            title={title}
            video={video}
            transcript={transcript}
          />
        )}

        <div className="chapter-body">{children}</div>

        <ChapterPager previous={previous} next={next} />
      </article>
    </div>
  );
}

export default ChapterPage;
