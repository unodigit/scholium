"use client";

/**
 * The version's paragraphs, with the margin markers and the `A` shortcut of
 * the Discussion feature (feature 150) beside them.
 *
 * `MarginMarkers` takes the annotation loader as a function, and a function
 * cannot travel from the server route to a client component as a prop. This
 * thin client wrapper is where the loader is chosen, so the reading column can
 * stay a server component and still hand over plain paragraphs.
 */

import { MarginMarkers, loadAnnotations } from "../paper-discussion/annotations";
import type { ReadingParagraph } from "./reading";

export interface ReadingTextProps {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly paperId: string;
  /** The version whose paragraphs these are. */
  readonly version: number;
  /** Id of that version's record: an annotation is anchored to it. */
  readonly versionCid: string;
  readonly paragraphs: readonly ReadingParagraph[];
}

export function ReadingText({
  paperId,
  version,
  versionCid,
  paragraphs,
}: ReadingTextProps) {
  return (
    <MarginMarkers
      className="ppg-text"
      paperId={paperId}
      version={version}
      versionCid={versionCid}
      paragraphs={paragraphs}
      load={loadAnnotations}
    />
  );
}
