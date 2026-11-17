import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the review form's stylesheets against docs/design.md §3,
 * §9 and §10: tokens only, the AI colour reserved, status never by colour
 * alone, 44px touch targets, and a split view that stacks on small screens.
 *
 * The stylesheets are read as shipped so a hard-coded colour or a dropped
 * focus ring fails here rather than in front of a reviewer.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Rules only: the header comments deliberately name colours and tokens. */
function rulesOf(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const feature = rulesOf(join(here, "review-form.css"));
const shell = rulesOf(join(here, "../../app/(review-form)/review-form-shell.css"));

describe.each([
  ["features/review-form/review-form.css", feature],
  ["app/(review-form)/review-form-shell.css", shell],
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

describe("review-form.css", () => {
  it("stacks the paper and the form in one column by default", () => {
    expect(feature).toMatch(
      /\.rf-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
  });

  it("goes two-column only from 1024px, paper first and form beside it", () => {
    const wide = feature.match(/@media \(min-width: 64rem\)\s*\{([\s\S]*?)\n\}/);
    expect(wide).not.toBeNull();
    expect(wide?.[1]).toMatch(
      /\.rf-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(24rem,\s*28rem\)/,
    );
  });

  it("keeps the form in view beside the paper and lets it scroll on its own", () => {
    const wide = feature.match(/@media \(min-width: 64rem\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(wide).toMatch(/\.rf-side\s*\{[^}]*position:\s*sticky/);
    expect(wide).toMatch(/\.rf-side\s*\{[^}]*overflow-y:\s*auto/);
    // Below the 64px global navigation, not under it.
    expect(wide).toMatch(/\.rf-side\s*\{[^}]*top:\s*calc\(64px/);
  });

  it("makes every choice a target of at least 44px", () => {
    expect(feature).toMatch(/\.rf-choice\s*\{[^}]*min-height:\s*44px/);
    expect(feature).toMatch(/\.rf-choice\s*\{[^}]*min-width:\s*44px/);
    expect(feature).toMatch(/\.rf-button\s*\{[^}]*min-height:\s*44px/);
  });

  it("draws each legend inside its fieldset, so it does not cut the divider above the row", () => {
    // A legend is rendered on the fieldset's top border unless it is floated.
    expect(feature).toMatch(/\.rf-dimension-name,\s*\.rf-group-legend\s*\{[^}]*float:\s*left/);
    expect(feature).toMatch(
      /\.rf-dimension-name \+ \*,\s*\.rf-group-legend \+ \*\s*\{[^}]*clear:\s*both/,
    );
  });

  it("anchors the visually hidden score text to its label", () => {
    expect(feature).toMatch(/\.rf-choice\s*\{[^}]*position:\s*relative/);
    expect(feature).toMatch(/\.rf-sr-only\s*\{[^}]*position:\s*absolute/);
  });

  it("gives the passphrase fields the same 44px target and visible focus ring", () => {
    expect(feature).toMatch(/\.rf-input\s*\{[^}]*min-height:\s*44px/);
    expect(feature).toMatch(
      /\.rf-input:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("shows a visible focus ring on the justification box", () => {
    expect(feature).toMatch(
      /\.rf-textarea:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("marks an error with the critical colour on the icon and border, not on the words", () => {
    expect(feature).toMatch(/\.rf-error-icon\s*\{[^}]*color:\s*var\(--critical\)/);
    expect(feature).toMatch(
      /\.rf-textarea\[aria-invalid="true"\]\s*\{[^}]*border-color:\s*var\(--critical\)/,
    );
    expect(feature).toMatch(/\.rf-error\s*\{[^}]*color:\s*var\(--ink\)/);
  });

  it("sets the paper in the reading face and the form in the UI face", () => {
    expect(feature).toMatch(/\.rf-form\s*\{[^}]*font-family:\s*var\(--family-sans\)/);
    // The paper's paragraphs use the shared `.reading` role class (serif 18/30).
    expect(feature).not.toMatch(/\.rf-paragraph\s*\{[^}]*font-family/);
  });

  it("gives the confirmed report's Markdown lists their markers back", () => {
    // Tailwind's preflight resets every list to `list-style: none`; the
    // confirmation renders the report's bullets and numbers explicitly.
    expect(feature).toMatch(
      /\.rf-updated__report-body\s+ul\s*\{[^}]*list-style:\s*disc/,
    );
    expect(feature).toMatch(
      /\.rf-updated__report-body\s+ol\s*\{[^}]*list-style:\s*decimal/,
    );
    expect(feature).toMatch(
      /\.rf-updated__report-body\s+ul,\s*\.rf-updated__report-body\s+ol\s*\{[^}]*padding-inline-start:/,
    );
  });

  it("lets a long title or id wrap instead of overflowing the page", () => {
    expect(feature).toMatch(/\.rf-title\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(feature).toMatch(/\.rf-kicker\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(feature).toMatch(/\.rf-paragraph\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});

describe("review-form-shell.css", () => {
  it("is wider than the single 720px reading column, to hold the split view", () => {
    expect(shell).toMatch(/\.rfs-shell\s*\{[^}]*max-width:\s*84rem/);
  });
});
