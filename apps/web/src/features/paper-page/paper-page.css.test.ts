import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for paper-page.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.2 (the paper page: a 720 px reading column and
 * a 360 px margin panel), §9 (accessibility) and §10 (responsive behaviour).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a lost focus ring fails here rather than in
 * front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const page = read(join(here, "paper-page.css"));
const shell = read(join(here, "../../app/(paper-page)/paper-page-shell.css"));

/** Selector + declarations of every rule, flattening @media blocks. */
function blocks(rules: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(rules); match; match = pattern.exec(rules)) {
    out.push({
      selector: match[1].trim().replace(/^@media[^{]*$/, ""),
      body: match[2],
    });
  }
  return out;
}

/** The declarations of every rule whose selector list includes `selector`. */
function declarations(css: { rules: string }, selector: string): string {
  return blocks(css.rules)
    .filter(({ selector: list }) =>
      list.split(",").some((part) => part.trim() === selector),
    )
    .map(({ body }) => body)
    .join("\n");
}

describe.each([
  ["paper-page.css", page],
  ["paper-page-shell.css", shell],
])("%s", (_name, css) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(css.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("only reads custom properties that exist", () => {
    const defined = new Set(
      [
        ...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g),
        ...css.rules.matchAll(/(--[a-z0-9-]+)\s*:/g),
      ].map((match) => match[1]),
    );
    const used = [...css.rules.matchAll(/var\((--[a-z0-9-]+)/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("never uses the reserved AI colour: nothing here is AI output", () => {
    expect(css.rules).not.toMatch(/--ai\b/);
  });

  it("casts no shadow: only the annotation popover floats", () => {
    expect(css.rules).not.toMatch(/box-shadow|drop-shadow|text-shadow/);
  });
});

describe("the layout (docs/design.md §5.2)", () => {
  it("sets the reading column at the 720 px token, not a number", () => {
    const main = declarations(page, ".ppg-main");
    expect(main).toMatch(/max-inline-size:\s*var\(--reading-column\)/);
    expect(tokens).toMatch(/--reading-column:\s*45rem/);
  });

  it("sets the margin panel at the 360 px token, beside the paper from 1280 px", () => {
    expect(tokens).toMatch(/--margin-panel:\s*22\.5rem/);
    const wide = page.rules.slice(page.rules.indexOf("@media (min-width: 80rem)"));
    expect(wide).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*var\(--reading-column\)\)\s*var\(--margin-panel\)/,
    );
  });

  it("is one column below 1280 px", () => {
    expect(declarations(page, ".ppg")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it("keeps the panel in view while the paper scrolls, only where it sits beside it", () => {
    const sticky = blocks(page.rules).filter(({ body }) => /position:\s*sticky/.test(body));
    expect(sticky).toHaveLength(1);
    expect(sticky[0].selector).toBe(".ppg-margin");
    // The sticky rule lives inside the wide media query, so it never traps a
    // stacked panel.
    const wideStart = page.rules.indexOf("@media (min-width: 80rem)", page.rules.indexOf(".ppg-main"));
    expect(page.rules.indexOf("position: sticky")).toBeGreaterThan(wideStart);
  });

  it("sizes the shell to the two columns and no more", () => {
    expect(declarations(shell, ".ppg-shell")).toMatch(
      /max-width:\s*calc\(\s*var\(--reading-column\)\s*\+\s*var\(--margin-panel\)/,
    );
  });

  it("caps reading lines at the 72-character measure", () => {
    expect(declarations(page, ".ppg-abstract-body")).toMatch(
      /max-inline-size:\s*var\(--measure-reading\)/,
    );
    expect(declarations(page, ".ppg-text .pd-paragraph")).toMatch(
      /max-inline-size:\s*var\(--measure-reading\)/,
    );
  });

  it("sets the abstract in the reading serif at the reading size", () => {
    const abstract = declarations(page, ".ppg-abstract-body");
    expect(abstract).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(abstract).toMatch(/font-size:\s*var\(--type-reading\)/);
    expect(abstract).toMatch(/line-height:\s*var\(--leading-reading\)/);
  });
});

describe("accessibility (docs/design.md §9)", () => {
  it("gives every control a visible 2 px focus ring in the focus colour", () => {
    for (const selector of [
      ".ppg-action:focus-visible",
      ".ppg-tab:focus-visible",
      ".ppg-details:focus-visible",
    ]) {
      expect(declarations(page, selector)).toMatch(
        /outline:\s*2px solid var\(--focus-ring\)/,
      );
    }
  });

  it("makes actions and tabs at least 44 px tall on touch", () => {
    const coarse = page.rules.slice(page.rules.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(/\.ppg-action\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/);
    expect(coarse).toMatch(/\.ppg-tab\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/);
  });

  it("does not rely on colour alone for the open tab or the current view", () => {
    // Fill, border and weight change together with the colour.
    const selected = declarations(page, '.ppg-tab[aria-selected="true"]');
    expect(selected).toMatch(/border-color/);
    expect(selected).toMatch(/background-color/);
    expect(selected).toMatch(/font-weight:\s*600/);

    const current = declarations(page, '.ppg-action[aria-current="true"]');
    expect(current).toMatch(/border-color/);
    expect(current).toMatch(/background-color/);
  });

  it("shows an unavailable action as dashed and quiet, not as a working one", () => {
    const disabled = declarations(page, '.ppg-action[aria-disabled="true"]');
    expect(disabled).toMatch(/border-style:\s*dashed/);
    expect(disabled).toMatch(/color:\s*var\(--ink-2\)/);
  });

  it("keeps hidden tab panels hidden whatever else sets their display", () => {
    expect(declarations(page, ".ppg-tabpanel[hidden]")).toMatch(/display:\s*none/);
  });

  it("hides text visually without removing it from assistive technology", () => {
    const hidden = declarations(page, ".ppg-visually-hidden");
    expect(hidden).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });
});

describe("selectors", () => {
  it("all start from a ppg class, so nothing leaks into other features", () => {
    const selectors = blocks(page.rules)
      .flatMap(({ selector }) => selector.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector !== "");

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      // `.ppg` (the layout root) or `.ppg-…`; the annotation component's own
      // classes are only ever reached through `.ppg-text`.
      expect(selector).toMatch(/^\.ppg(?:-|$|[\s:[])/);
    }
  });
});
