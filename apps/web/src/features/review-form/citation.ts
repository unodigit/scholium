/**
 * "Cite in review": quoting the paper in the review (spec feature 167,
 * docs/design.md §5.5 — "selecting text offers Cite in review").
 *
 * The reviewer selects words in the paper on the left and cites them; the
 * quote lands in a justification box on the right, followed by where it came
 * from:
 *
 * ```text
 * “We define a safety score for each branch.” [¶ 2 · 3fa9c1d2]
 * ```
 *
 * The citation is plain text inside the justification, so it is part of the
 * sealed review and shows wherever a justification is shown. It names the
 * paragraph by number (for a reader counting down the paper) and by the
 * stable id `data-paragraph-id` carries (the sha256 of its text, shortened),
 * which does not move when a version is re-typeset.
 *
 * This module is split in two: pure formatting (below), and the one function
 * that reads a browser selection (`citationFromSelection`), which takes the
 * DOM it is given and touches nothing else.
 */

/** The button that quotes the selection (docs/design.md §5.5). */
export const CITE_LABEL = "Cite in review";

/** The longest quote kept; a longer selection is cut at a word and ended with "…". */
export const MAX_QUOTE_CHARS = 300;

/** How many characters of a paragraph's id a citation names. */
export const PARAGRAPH_ID_CHARS = 8;

/** The attribute on a citable block: how a citation names it. */
export const CITE_ATTRIBUTE = "data-cite";

/** How a citation names the abstract, which has no paragraph id. */
export const ABSTRACT_SOURCE = "abstract";

/** A quote from the paper and where in the paper it is. */
export interface Citation {
  /** The words, whitespace collapsed, shortened if long. */
  readonly quote: string;
  /** Where they are: `abstract`, `¶ 7 · 3fa9c1d2`, or a range of those. */
  readonly source: string;
}

/** Collapse every run of whitespace (newlines between paragraphs too) to one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Shorten a quote to at most `max` characters of the original, cutting at a
 * word and ending with "…". A quote that fits is returned as it is.
 */
export function shortenQuote(text: string, max: number = MAX_QUOTE_CHARS): string {
  const clean = collapseWhitespace(text);
  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  // Cut at a word unless that would leave next to nothing (one very long token).
  const kept = space >= max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s.,;:!?…-]+$/u, "")}…`;
}

/**
 * How a citation names paragraph `number` (1-based) with id `id`:
 * `¶ 7 · 3fa9c1d2`. The server writes this onto each paragraph, so the page
 * and the citation cannot disagree about the number.
 */
export function paragraphSource(number: number, id: string): string {
  const short = id.trim().slice(0, PARAGRAPH_ID_CHARS);
  return short === "" ? `¶ ${number}` : `¶ ${number} · ${short}`;
}

/**
 * Where a selection starts and ends: one name when it sits in one block, the
 * first and last (`¶ 3 · aaaa – ¶ 5 · bbbb`) when it spans several.
 */
export function sourceRange(first: string, last: string): string {
  return first === last ? first : `${first} – ${last}`;
}

/** The citation as it is written into a justification. */
export function formatCitation(citation: Citation): string {
  return `“${citation.quote}” [${citation.source}]`;
}

/**
 * `text` with the citation added after what the reviewer has written, on its
 * own paragraph, and a fresh line below it to carry on typing. Nothing the
 * reviewer wrote is changed.
 */
export function appendCitation(text: string, citation: Citation): string {
  const written = text.replace(/\s+$/, "");
  const cited = formatCitation(citation);
  return written === "" ? `${cited}\n` : `${written}\n\n${cited}\n`;
}

/** Where a citation was placed, said for a screen reader (the box is out of sight). */
export function describeCitation(citation: Citation, dimensionLabel: string): string {
  return `Quoted ${citation.source} in the justification for ${dimensionLabel}.`;
}

// ---- Reading a selection --------------------------------------------------

/** Where the end of a selection is on screen, for placing the button. */
export interface SelectionPoint {
  readonly right: number;
  readonly bottom: number;
}

/** What a selection in the paper offers: the citation and where to put the button. */
export interface SelectedCitation {
  readonly citation: Citation;
  /** The last line's end, or `null` where the browser cannot measure a range. */
  readonly point: SelectionPoint | null;
}

/** The citable blocks under `root`, in reading order. */
function citableBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${CITE_ATTRIBUTE}]`));
}

/** The part of `range` that lies inside `block`, or `null` when it holds none. */
function clipToBlock(range: Range, block: HTMLElement): Range | null {
  const inside = block.ownerDocument.createRange();
  inside.selectNodeContents(block);

  // The selection ends at or before the block's first character, or begins at
  // or after its last one: a triple-click that ends at the start of the next
  // paragraph selects none of it.
  if (range.compareBoundaryPoints(Range.START_TO_END, inside) <= 0) return null;
  if (range.compareBoundaryPoints(Range.END_TO_START, inside) >= 0) return null;

  const clipped = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, inside) < 0) {
    clipped.setStart(inside.startContainer, inside.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, inside) > 0) {
    clipped.setEnd(inside.endContainer, inside.endOffset);
  }
  return clipped;
}

function endOfRange(range: Range): SelectionPoint | null {
  const rects =
    typeof range.getClientRects === "function"
      ? Array.from(range.getClientRects()).filter(
          (rect) => rect.width > 0 || rect.height > 0,
        )
      : [];
  const last = rects[rects.length - 1];
  if (last !== undefined) return { right: last.right, bottom: last.bottom };

  if (typeof range.getBoundingClientRect === "function") {
    const box = range.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) {
      return { right: box.right, bottom: box.bottom };
    }
  }
  return null;
}

/**
 * What the current selection in `root` can cite, or `null` when it cannot cite
 * anything: nothing is selected, the selection reaches outside `root` (it is
 * not only the paper), or it holds no text of a citable block.
 *
 * `root` holds the paper's blocks, each marked with {@link CITE_ATTRIBUTE}
 * naming itself. The quote is only the text inside those blocks, so a heading
 * between the abstract and the full text never ends up in the quote.
 */
export function citationFromSelection(
  root: HTMLElement,
  selection: Selection | null,
): SelectedCitation | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  const parts: { source: string; text: string }[] = [];
  for (const block of citableBlocks(root)) {
    const clipped = clipToBlock(range, block);
    if (clipped === null) continue;
    const text = collapseWhitespace(clipped.toString());
    if (text === "") continue;
    parts.push({ source: block.getAttribute(CITE_ATTRIBUTE) ?? "", text });
  }
  if (parts.length === 0) return null;

  const first = parts[0];
  const last = parts[parts.length - 1];
  return {
    citation: {
      quote: shortenQuote(parts.map((part) => part.text).join(" ")),
      source: sourceRange(first.source, last.source),
    },
    point: endOfRange(range),
  };
}
