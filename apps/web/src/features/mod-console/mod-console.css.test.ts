import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the console's stylesheets against docs/design.md §3 and
 * §9: tokens only, status never by colour alone, 44px touch targets.
 *
 * The stylesheets are read as shipped so a hard-coded colour or a dropped
 * focus ring fails here rather than in front of a moderator.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Rules only: the header comments deliberately name colours and tokens. */
function rulesOf(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const feature = rulesOf(join(here, "mod-console.css"));
const shell = rulesOf(join(here, "../../app/(mod-console)/mod-console.css"));

describe.each([
  ["features/mod-console/mod-console.css", feature],
  ["app/(mod-console)/mod-console.css", shell],
])("%s", (_name, rules) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });
});

describe("mod-console.css", () => {
  it("colours a signal from the status tokens", () => {
    expect(feature).toMatch(/\.mc-signal--ok[^}]*var\(--verified-soft\)/);
    expect(feature).toMatch(/\.mc-signal--warn[^}]*var\(--pending-soft\)/);
    expect(feature).toMatch(/\.mc-signal--bad[^}]*var\(--critical-soft\)/);
  });

  it("keeps a signal's words in ink: the status colour is on the icon and border", () => {
    expect(feature).toMatch(/\.mc-signal\s*\{[^}]*color:\s*var\(--ink\)/);
    expect(feature).toMatch(/\.mc-signal--ok \.mc-signal-icon\s*\{[^}]*color:\s*var\(--verified\)/);
    expect(feature).toMatch(/\.mc-signal--warn \.mc-signal-icon\s*\{[^}]*color:\s*var\(--pending\)/);
    expect(feature).toMatch(/\.mc-signal--bad \.mc-signal-icon\s*\{[^}]*color:\s*var\(--critical\)/);
  });

  it("scrolls the wide table inside a frame with a visible focus ring", () => {
    expect(feature).toMatch(/\.mc-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(feature).toMatch(
      /\.mc-table-wrap:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("sets table text in the UI face from the type tokens", () => {
    expect(feature).toMatch(/font-family:\s*var\(--family-sans\)/);
    expect(feature).toMatch(/font-size:\s*var\(--type-ui\)/);
    expect(feature).toMatch(/line-height:\s*var\(--leading-ui\)/);
  });

  it("lines up the numeric columns", () => {
    expect(feature).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("keeps ages, similarities and every signal on one line", () => {
    // Seen in a real browser: "2 d 4 h" split in two, and a wrapped "Not
    // checked" left its icon stranded from the word.
    expect(feature).toMatch(/\.mc-cell-num\s*\{[^}]*white-space:\s*nowrap/);
    expect(feature).toMatch(/\.mc-signal\s*\{[^}]*white-space:\s*nowrap/);
  });

  it("keeps buttons at least 44px tall (touch target, design.md §9)", () => {
    expect(feature).toMatch(/\.mc-button\s*\{[^}]*min-height:\s*44px/);
  });

  it("marks the notice with a border as well as a colour", () => {
    expect(feature).toMatch(/\.mc-notice\s*\{[^}]*border-inline-start:\s*4px solid var\(--critical\)/);
  });

  it("has no drop shadow (design.md §3: only the annotation popover has one)", () => {
    expect(feature).not.toMatch(/box-shadow/);
  });
});

describe("mod-console.css detail view", () => {
  it("puts the paper and the decision form side by side, stacking on a narrow screen", () => {
    expect(feature).toMatch(/\.mc-detail-grid\s*\{[^}]*display:\s*grid/);
    expect(feature).toMatch(/\.mc-detail-grid\s*\{[^}]*grid-template-columns/);
    expect(feature).toMatch(
      /@media \(max-width: 64rem\)\s*\{[^}]*\.mc-detail-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
  });

  it("sizes form controls to the 44px touch target and gives them a focus ring", () => {
    expect(feature).toMatch(
      /\.mc-select,\s*\.mc-input,\s*\.mc-textarea\s*\{[^}]*min-height:\s*44px/,
    );
    expect(feature).toMatch(
      /\.mc-select:focus-visible,\s*\.mc-input:focus-visible,\s*\.mc-textarea:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("marks validation with words and an icon, not colour alone", () => {
    expect(feature).toMatch(/\.mc-field-error\s*\{[^}]*color:\s*var\(--ink\)/);
    expect(feature).toMatch(
      /\.mc-field-error-icon[^{]*\{[^}]*color:\s*var\(--critical\)/,
    );
  });

  it("states the public-record sentence in accent, not in a human status colour", () => {
    expect(feature).toMatch(
      /\.mc-record-notice\s*\{[^}]*border:\s*1px solid var\(--accent\)/,
    );
    expect(feature).not.toMatch(/\.mc-record-notice[^}]*var\(--(verified|pending|critical)\)/);
  });
});

describe("app/(mod-console)/mod-console.css", () => {
  it("gives the seven-column table more room than the reading column", () => {
    expect(shell).toMatch(/\.mc-shell\s*\{[^}]*max-width:\s*72rem/);
    expect(shell).not.toMatch(/--reading-column/);
  });
});
