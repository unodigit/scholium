"use client";

/**
 * The docs shell — the chapter navigation and reading frame every `/docs`
 * page renders inside, mounted by the route-group layout
 * (`app/(docs)/layout.tsx`).
 *
 * One chapter list, two shapes, decided by the 1100px breakpoint
 * (`docs.css`):
 *
 * - ≥1100px: the list is a sticky left sidebar beside the reading column.
 * - <1100px: the same list collapses into a "Chapters" disclosure above the
 *   content. It is a native `<details>`, so it opens and closes without
 *   JavaScript, and the server renders it open — every chapter link is
 *   present and visible in the first HTML.
 *
 * The current chapter is marked `aria-current="page"` from the pathname: the
 * shell lives in a layout, which persists across navigations, so it is the
 * client hook that follows the page underneath.
 *
 * The chapters arrive as props from the server layout. The handbook itself
 * is read from disk at build time (`features/docs/handbook.ts`, `node:fs`),
 * and this is a client component, so it must not import that module — only
 * the plain `{ title, href }` pairs cross the server/client boundary.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import "./docs.css";

/** One entry in the chapter list: a handbook chapter's title and route. */
export type DocsChapterLink = {
  readonly title: string;
  readonly href: string;
};

/** Props for {@link DocsShell}. */
export interface DocsShellProps {
  /** The chapters in number order, from `features/docs/handbook.ts`. */
  chapters: readonly DocsChapterLink[];
  /** The docs page itself: the index at `/docs` or a chapter page. */
  children: ReactNode;
}

/** The viewport width at which the chapter list becomes the sticky sidebar. */
const SIDEBAR_QUERY = "(min-width: 1100px)";

/** The docs shell: chapter navigation on the left, the page on the right. */
export function DocsShell({ chapters, children }: DocsShellProps) {
  const pathname = usePathname();
  const chaptersRef = useRef<HTMLDetailsElement>(null);

  // A reader who collapsed the "Chapters" disclosure on a narrow window gets
  // the sidebar back when the window grows past the sidebar breakpoint (the
  // sidebar has no trigger to reopen it). Collapsing on the way down stays
  // the reader's choice.
  useEffect(() => {
    const details = chaptersRef.current;
    if (!details || typeof window.matchMedia !== "function") return;
    const sidebar = window.matchMedia(SIDEBAR_QUERY);
    const reveal = () => {
      if (sidebar.matches) details.open = true;
    };
    reveal();
    sidebar.addEventListener("change", reveal);
    return () => sidebar.removeEventListener("change", reveal);
  }, []);

  // `/docs` itself is not a chapter, and an unknown slug (a 404) must not
  // light any chapter up, so only an exact match counts.
  const currentHref = chapters.find((chapter) => chapter.href === pathname)
    ?.href;

  return (
    <div className="ds-shell">
      <nav className="ds-nav" aria-labelledby="docs-chapters-title">
        <h2 className="ds-title" id="docs-chapters-title">
          <Link className="ds-title-link" href="/docs">
            Docs
          </Link>
        </h2>
        <details className="ds-chapters" open ref={chaptersRef}>
          <summary className="ds-toggle">
            <svg
              className="ds-chevron"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            Chapters
          </summary>
          <ol className="ds-list">
            {chapters.map((chapter) => (
              <li className="ds-item" key={chapter.href}>
                <Link
                  className="ds-link"
                  href={chapter.href}
                  aria-current={
                    chapter.href === currentHref ? "page" : undefined
                  }
                >
                  {chapter.title}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      </nav>
      <div className="ds-content">{children}</div>
    </div>
  );
}

export default DocsShell;
