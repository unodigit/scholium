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

import { useEffect, useRef } from "react";
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
  /** How to fetch the math renderer. Tests pass their own. */
  readonly loadMath?: LoadMath;
}

export function ReadingText({
  paperId,
  version,
  versionCid,
  paragraphs,
  loadMath = loadKatex,
}: ReadingTextProps) {
  const scope = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scope.current;
    if (root === null || !hasMath(paragraphs)) {
      return;
    }
    let cancelled = false;
    loadMath().then(
      (renderer) => {
        if (!cancelled) {
          typesetParagraphs(root, paragraphs, renderer);
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
  }, [paragraphs, loadMath]);

  return (
    <div ref={scope}>
      <MarginMarkers
        className="ppg-text"
        paperId={paperId}
        version={version}
        versionCid={versionCid}
        paragraphs={paragraphs}
        load={loadAnnotations}
      />
    </div>
  );
}
