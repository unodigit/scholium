"use client";

/**
 * The version's paragraphs, with the margin markers and the `A` shortcut of
 * the Discussion feature (feature 150) beside them, and the paper's math
 * typeset.
 *
 * `MarginMarkers` takes the annotation loader as a function, and a function
 * cannot travel from the server route to a client component as a prop. This
 * thin client wrapper is where the loader is chosen, so the reading column can
 * stay a server component and still hand over plain paragraphs.
 *
 * **Math.** The paragraphs are server-rendered as the plain text the node
 * stored, so the first HTML has every word and a reader with no JavaScript gets
 * a formula as the LaTeX the author wrote. Once the page runs, this component
 * swaps each paragraph that has math for typeset text (`math-typeset.ts`); a
 * paper with no math never loads KaTeX. If KaTeX cannot be fetched the LaTeX
 * stays, which is still readable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import "katex/dist/katex.min.css";

import { MarginMarkers, loadAnnotations } from "../paper-discussion/annotations";
import { hasMath, loadKatex, typesetParagraphs, type LoadMath } from "./math-typeset";
import type { ReadingParagraph } from "./reading";

export interface ReadingTextProps {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** The version whose paragraphs these are. */
  readonly version: number;
  /** Id of that version's record: an annotation is anchored to it. */
  readonly versionCid: string;
  readonly paragraphs: readonly ReadingParagraph[];
  /**
   * The version's signed title. When the extracted text opens by repeating it,
   * the repeat is dropped: the page shows the title above the column.
   */
  readonly title?: string;
  /**
   * The version's abstract. The page shows it above the column, so a PDF's
   * text layer repeating it does not show it twice.
   */
  readonly abstract?: string;
  /** How to fetch the math renderer. Tests pass their own. */
  readonly loadMath?: LoadMath;
}

/** The heading and abstract the paper page renders above the reading column. */
const PAGE_TITLE_ID = "ppg-title";
const PAGE_ABSTRACT_SELECTOR = ".ppg-abstract-body";

/** Text compared with its whitespace and case flattened. */
function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** How many paragraphs from the top may hold the PDF's front matter. */
const FRONT_MATTER_WINDOW = 8;

/**
 * The paragraphs from the body onward.
 *
 * A PDF's text layer opens with the front matter: the title, the byline (and
 * sometimes a notice), an "Abstract" heading and the abstract. The page
 * already shows all of that above the column, so the reading view should start
 * at the first body paragraph.
 *
 * The abstract is the anchor: everything up to and including it is dropped,
 * which also discards the byline and any notice between the title and it. Only
 * a match near the top counts, so an abstract quoted later in the paper still
 * appears where it belongs. Without an abstract, the title is the anchor; a
 * text that repeats neither is left exactly as it arrived.
 */
export function bodyParagraphs(
  paragraphs: readonly ReadingParagraph[],
  title: string | null | undefined,
  abstract: string | null | undefined,
): readonly ReadingParagraph[] {
  const titleKey = title === null || title === undefined ? "" : normalized(title);
  const abstractKey =
    abstract === null || abstract === undefined ? "" : normalized(abstract);

  let titleAt = -1;
  let abstractAt = -1;
  const window = Math.min(paragraphs.length, FRONT_MATTER_WINDOW);
  for (let index = 0; index < window; index += 1) {
    const key = normalized(paragraphs[index].text);
    if (titleAt < 0 && titleKey !== "" && key === titleKey) {
      titleAt = index;
    }
    if (
      abstractAt < 0 &&
      ((abstractKey !== "" && key === abstractKey) || key === "abstract")
    ) {
      abstractAt = index;
    }
  }

  let first = 0;
  if (abstractAt >= 0) {
    first = abstractAt + 1;
  } else if (titleAt >= 0) {
    first = titleAt + 1;
  } else {
    return paragraphs;
  }

  // The anchor paragraph and anything repeated directly after it (an abstract
  // split from its heading, say) go too.
  const repeated = new Set<string>(["abstract"]);
  if (titleKey !== "") repeated.add(titleKey);
  if (abstractKey !== "") repeated.add(abstractKey);
  while (first < paragraphs.length && repeated.has(normalized(paragraphs[first].text))) {
    first += 1;
  }
  return paragraphs.slice(first);
}

/** The title and abstract already on the page, for callers that do not pass them. */
function pageFacts(): { title: string | null; abstract: string | null } {
  if (typeof document === "undefined") {
    return { title: null, abstract: null };
  }
  const title = document.getElementById(PAGE_TITLE_ID)?.textContent ?? null;
  const abstract =
    document.querySelector(PAGE_ABSTRACT_SELECTOR)?.textContent ?? null;
  return { title, abstract };
}

export function ReadingText({
  paperId,
  version,
  versionCid,
  paragraphs,
  title,
  abstract,
  loadMath = loadKatex,
}: ReadingTextProps) {
  const scope = useRef<HTMLDivElement>(null);

  // The unlisted page passes the signed title and abstract; the listed page's
  // column is a server component that cannot, so its heading and abstract are
  // read from the page once it runs.
  const [onPage, setOnPage] = useState<{
    title: string | null;
    abstract: string | null;
  } | null>(null);
  useEffect(() => {
    if (title !== undefined && abstract !== undefined) {
      return;
    }
    // Read only when a fact is missing; the props always win over the page.
    setOnPage(pageFacts());
  }, [title, abstract]);

  const shown = useMemo(
    () =>
      bodyParagraphs(
        paragraphs,
        title ?? onPage?.title ?? null,
        abstract ?? onPage?.abstract ?? null,
      ),
    [paragraphs, title, abstract, onPage],
  );

  useEffect(() => {
    const root = scope.current;
    if (root === null || !hasMath(shown)) {
      return;
    }
    let cancelled = false;
    loadMath().then(
      (renderer) => {
        if (!cancelled) {
          typesetParagraphs(root, shown, renderer);
        }
      },
      () => {
        // KaTeX could not be fetched: the LaTeX the author wrote stays on the
        // page, which a reader can still read.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shown, loadMath]);

  return (
    <div ref={scope}>
      <MarginMarkers
        className="ppg-text"
        paperId={paperId}
        version={version}
        versionCid={versionCid}
        paragraphs={shown}
        load={loadAnnotations}
      />
    </div>
  );
}
