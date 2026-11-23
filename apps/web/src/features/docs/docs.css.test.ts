import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for docs.css against docs/design.md §3 and §9 and the docs
 * spec's shape: token-only colour, the 1100px sidebar breakpoint, the
 * reading measure for the article column, and grid tracks that shrink
 * instead of overflowing.
 *
 * The stylesheet is read as shipped, so a hard-coded colour or a dropped
 * breakpoint fails here rather than in front of a reader mid-handbook.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "docs.css"), "utf8");
/** Rules only: the header comment deliberately names tokens and colours. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of the first `@media (min-width: …) { … }` block whose query is
 * `query`. The stylesheet keeps every block's closing brace at the start of
 * a line and inner closings indented, so the first `\n}` ends the block.
 */
function mediaBlock(query: string): string {
  const match = new RegExp(
    `@media \\(${query.replace(/[()]/g, "\\$&")}\\) \\{([\\s\\S]*?)\\n\\}`,
  ).exec(rules);
  if (match === null) {
    throw new Error(`No @media (${query}) block in docs.css`);
  }
  return match[1];
}

describe("docs.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("makes the chapter list a sticky left sidebar from 1100px", () => {
    const sidebar = mediaBlock("min-width: 1100px");

    // Two grid tracks: the sidebar column beside the reading column.
    expect(sidebar).toMatch(
      /grid-template-columns:\s*minmax\([^)]*\)\s*minmax\(0,\s*1fr\)/,
    );
    // The nav sticks below the 64px global header (components/nav).
    expect(sidebar).toMatch(/\.ds-nav\s*\{[^}]*position:\s*sticky/);
    expect(sidebar).toMatch(/top:\s*calc\(64px\s*\+/);
    // The sidebar list is always open, so the disclosure trigger disappears.
    expect(sidebar).toMatch(/\.ds-toggle\s*\{\s*display:\s*none/);
  });

  it("keeps the article column at the reading measure", () => {
    // --reading-column is the 720px form of the 72-character measure
    // (--measure-reading) from docs/design.md §3.
    expect(rules).toMatch(
      /\.ds-content\s*\{[^}]*max-width:\s*var\(--reading-column\)/,
    );
  });

  it("lets the columns shrink, so the page never scrolls sideways", () => {
    // Grid items refuse to shrink below their content unless minmax(0, 1fr)
    // and min-width: 0 say otherwise — the classic sideways-scroll cause.
    expect(rules).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rules).toMatch(/\.ds-content\s*\{[^}]*min-width:\s*0/);
  });

  it("frames the screenshot lightbox at the viewport and its image inside the frame", () => {
    // The dialog is the 95vw × 90vh border-box frame; the image inside must
    // be capped against the dialog's content box (max-width: 100%), not
    // against viewport units — a 95vw image in a 95vw box with 32px padding
    // overflows it by exactly that padding and scrolls sideways at 375px.
    expect(rules).toMatch(/dialog\.screenshot-lightbox\s*\{[^}]*max-width:\s*95vw/);
    expect(rules).toMatch(/dialog\.screenshot-lightbox\s*\{[^}]*max-height:\s*90vh/);
    expect(rules).toMatch(/dialog\.screenshot-lightbox img\s*\{[^}]*max-width:\s*100%/);
    expect(rules).not.toMatch(
      /dialog\.screenshot-lightbox img\s*\{[^}]*max-width:\s*(?:95vw|100vw)/,
    );
    // The image leaves room for the caption, close button and padding, so the
    // whole overlay fits without an inner scrollbar.
    expect(rules).toMatch(
      /dialog\.screenshot-lightbox img\s*\{[^}]*max-height:\s*calc\(90vh\s*-\s*11rem\)/,
    );
  });
});
