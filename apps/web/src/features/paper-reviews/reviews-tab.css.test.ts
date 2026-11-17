import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for reviews-tab.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.2 (the Reviews tab), §7 (review card) and §9
 * (accessibility).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on a word fails here rather
 * than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const tab = read(join(here, "reviews-tab.css"));
const shell = read(join(here, "../../app/(paper-reviews)/paper-reviews.css"));

/** Selector + declarations of every rule, flattening @media blocks. */
function blocks(rules: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(rules); match; match = pattern.exec(rules)) {
    out.push({ selector: match[1].trim().replace(/^@media[^{]*$/, ""), body: match[2] });
  }
  return out;
}

describe.each([
  ["reviews-tab.css", tab],
  ["paper-reviews.css", shell],
])("%s", (_name, css) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(css.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("only reads custom properties that exist", () => {
    const defined = new Set(
      [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...css.rules.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(
        (match) => match[1],
      ),
    );
    const used = [...css.rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });
});

describe("reviews-tab.css", () => {
  it("is paper reviews, not AI output: the reserved --ai colour never appears", () => {
    expect(tab.rules).not.toMatch(/var\(--ai(?:-soft)?\)/);
  });

  it("draws the rubric dots in the neutral accent, not a paper status colour", () => {
    expect(tab.rules).toMatch(/\.pr-dot--on\s*\{[^}]*background-color:\s*var\(--accent\)/);
    expect(tab.rules).toMatch(/\.pr-dot--on\s*\{[^}]*border-color:\s*var\(--accent\)/);
  });

  it("never puts a status colour on a word (README: 4.5:1 rule)", () => {
    for (const { selector, body } of blocks(tab.rules)) {
      const colouredText = /(^|;|\s)color:\s*var\(--(?:verified|pending|critical)(?:-soft)?\)/;
      if (colouredText.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/svg/);
      }
    }
    // The recommendation's fill is the tint; its word stays --ink.
    expect(tab.rules).toMatch(/\.pr-recommendation\s*\{[^}]*color:\s*var\(--ink\)/);
  });

  it("keeps a sealed report calm and a served report's paragraphs intact", () => {
    expect(tab.rules).toMatch(/\.pr-report__body\s*\{[^}]*white-space:\s*pre-wrap/);
    expect(tab.rules).toMatch(/\.pr-report__sealed\s*\{/);
  });

  it("gives the report's Markdown lists their markers back", () => {
    // Tailwind's preflight resets every list to `list-style: none`; a report's
    // bullets and numbers must be drawn explicitly or the text renders as
    // unmarked lines.
    expect(tab.rules).toMatch(
      /\.pr-report__body\s+ul,\s*\.pr-history__report-body\s+ul\s*\{[^}]*list-style:\s*disc/,
    );
    expect(tab.rules).toMatch(
      /\.pr-report__body\s+ol,\s*\.pr-history__report-body\s+ol\s*\{[^}]*list-style:\s*decimal/,
    );
    expect(tab.rules).toMatch(
      /\.pr-report__body\s+ul,\s*\.pr-report__body\s+ol,\s*\.pr-history__report-body\s+ul,\s*\.pr-history__report-body\s+ol\s*\{[^}]*padding-inline-start:/,
    );
  });

  it("gives the report's summary a 44 px target (§9)", () => {
    expect(tab.rules).toMatch(/\.pr-report__summary\s*\{[^}]*min-block-size:\s*2\.75rem/);
  });

  it("stacks the summary and rubric rows in a narrow panel (§10)", () => {
    expect(tab.rules).toMatch(/@media\s*\(max-width:\s*30rem\)/);
  });
});

describe("the reviews page's reading layout (docs/design.md §4, §10)", () => {
  it("widens the route shell, sized for one 360 px panel, to the reading column plus the margin panel", () => {
    // The shell alone is 22.5rem + 16 units wide: about 375 px of content on a
    // 1440 px desktop. A page that carries the tab is given the paper page's
    // frame instead, and only a page that carries it.
    expect(tab.rules).toMatch(
      /\.prs-shell:has\(>\s*\.pr-tab\)\s*\{[^}]*max-width:\s*calc\(\s*var\(--reading-column\)\s*\+\s*var\(--margin-panel\)/,
    );
  });

  it("puts the reading column beside the margin panel on a wide screen", () => {
    expect(tab.rules).toMatch(/@media\s*\(min-width:\s*80rem\)/);
    expect(tab.rules).toMatch(
      /\.prs-shell\s+\.pr-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*var\(--reading-column\)\)\s+minmax\(0,\s*var\(--margin-panel\)\)/,
    );
  });

  it("keeps a single column to the reading width below that, and reports to 72 characters", () => {
    expect(tab.rules).toMatch(/\.prs-shell\s+\.pr-layout\s*\{[^}]*max-width:\s*var\(--reading-column\)/);
    expect(tab.rules).toMatch(/\.pr-report__body[^{]*\{[^}]*max-width:\s*var\(--measure-reading\)/);
  });

  it("styles the rendered Markdown with tokens, not the browser's defaults", () => {
    expect(tab.rules).toMatch(/\.pr-report__body\s+code[^{]*\{[^}]*font-family:\s*var\(--family-mono\)/);
    expect(tab.rules).toMatch(/\.pr-report__body\s+a[^{]*\{[^}]*color:\s*var\(--accent\)/);
  });
});

