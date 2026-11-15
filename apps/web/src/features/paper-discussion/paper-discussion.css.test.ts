import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for paper-discussion.css and the route's shell against
 * docs/design.md §3 (tokens), §5.2, §9 (accessibility) and §11.
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on text fails here rather
 * than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const tab = read(join(here, "paper-discussion.css"));
const shell = read(join(here, "../../app/(paper-discussion)/discussion.css"));

/** Selector + declarations of every rule, flattening @media blocks. */
function blocks(rules: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(rules); match; match = pattern.exec(rules)) {
    out.push({ selector: match[1].trim().replace(/^@media[^{]*$/, ""), body: match[2] });
  }
  return out;
}

function rule(selector: string): string {
  const found = blocks(tab.rules).find((block) => block.selector === selector);
  if (found === undefined) throw new Error(`No rule for ${selector}`);
  return found.body;
}

describe.each([
  ["paper-discussion.css", tab],
  ["app/(paper-discussion)/discussion.css", shell],
])("%s", (_name, css) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(css.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour: discussion is people, not AI output", () => {
    expect(css.rules).not.toMatch(/--ai\b|--ai-soft\b/);
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

  it("casts no shadow except the annotation popover (design.md §3)", () => {
    const withoutPopover = css.rules.replace(/\.pd-annotation-popover\s*\{[^}]*\}/g, "");
    expect(withoutPopover).not.toMatch(/box-shadow|text-shadow|drop-shadow|--popover-shadow/);
  });

  it("never removes the keyboard focus ring", () => {
    expect(css.rules).not.toMatch(/outline:\s*(?:none|0)\b/);
  });
});

describe("paper-discussion.css", () => {
  it("puts status colour on icons and borders, never on the words", () => {
    for (const { selector, body } of blocks(tab.rules)) {
      if (/(^|;|\s)color:\s*var\(--(verified|pending|critical)\)/.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/__icon/);
      }
    }
    expect(tab.rules).not.toMatch(/(^|;|\s)color:\s*var\(--(verified|pending|critical)-soft\)/);
  });

  it("says a failure in ink beside a critical rule, so it never depends on red", () => {
    const body = rule(".pd-error-text");
    expect(body).toMatch(/border-inline-start:\s*3px solid var\(--critical\)/);
    expect(body).toMatch(/color:\s*var\(--ink\)/);
  });

  it("says 'already marked' with a different rule from a fault", () => {
    expect(tab.rules).toMatch(/\.pd-error-text\[data-already-done\]\s*\{[^}]*border-inline-start-color:\s*var\(--accent\)/);
  });

  it("marks a reported post with a verified check icon, the word carrying the meaning", () => {
    expect(rule(".pd-reported__icon")).toMatch(/color:\s*var\(--verified\)/);
    expect(rule(".pd-reported")).toMatch(/color:\s*var\(--ink\)/);
  });

  it("keeps every control at least 44px tall (touch target, design.md §9)", () => {
    const minimum = /min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/;
    expect(rule(".pd-button,\n.pd-action")).toMatch(minimum);
    expect(rule(".pd-reported")).toMatch(minimum);
    expect(rule(".pd-reason__label")).toMatch(minimum);
  });

  it("gives every control a visible focus ring", () => {
    const ring = tab.rules.slice(tab.rules.indexOf(".pd-button:focus-visible"));
    const selector = ring.slice(0, ring.indexOf("{"));
    for (const name of [".pd-button", ".pd-action", ".pd-link", ".pd-compose__text", ".pd-reason__input", ".pd-post", ".pd-note"]) {
      expect(selector, name).toContain(`${name}:focus-visible`);
    }
    expect(ring).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
  });

  it("lets long ids, quotes and posts wrap, and keeps a reader's line breaks", () => {
    expect(rule(".pd-post__author")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".pd-post__author")).toMatch(/font-family:\s*var\(--family-mono\)/);
    expect(rule(".pd-post__text")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".pd-post__text")).toMatch(/white-space:\s*pre-wrap/);
    expect(rule(".pd-post__quote")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".pd-error-text")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("stops indenting replies after four levels: a 360px panel has no room for a staircase", () => {
    expect(rule(".pd-replies")).toMatch(/margin-inline-start:\s*calc\(var\(--space-unit\) \* 2\)/);
    const flat = rule(".pd-replies .pd-replies .pd-replies .pd-replies");
    expect(flat).toMatch(/margin-inline-start:\s*0/);
    expect(flat).toMatch(/padding-inline-start:\s*0/);
  });

  it("lets actions wrap rather than scroll", () => {
    expect(rule(".pd-post__actions")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".pd-compose__actions,\n.pd-report__actions")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("draws the over-limit count heavier as well as saying it in words", () => {
    expect(tab.rules).toMatch(/\.pd-compose__count\[data-over="true"\]\s*\{[^}]*font-weight:\s*600/);
  });

  it("turns the loading ring, and stops it under reduced motion", () => {
    expect(rule(".pd-loading__icon")).toMatch(/animation:\s*pd-spin 900ms linear infinite/);
    const reduced = tab.rules.slice(tab.rules.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.pd-loading__icon[\s\S]*animation:\s*none/);
  });

  it("recolours icons, links and controls in forced-colours mode", () => {
    const forced = tab.rules.slice(tab.rules.indexOf("forced-colors"));
    expect(forced).toMatch(/color:\s*CanvasText/);
    expect(forced).toMatch(/color:\s*LinkText/);
    expect(forced).toMatch(/border-color:\s*ButtonText/);
  });

  it("has a visually hidden class that keeps text readable by assistive technology", () => {
    const hidden = rule(".pd-visually-hidden");
    expect(hidden).toMatch(/position:\s*absolute/);
    expect(hidden).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...tab.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pd-"))).toEqual([]);
  });
});

describe("the route shell", () => {
  it("prefixes every class with pdisc-", () => {
    const classes = [...shell.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pdisc-"))).toEqual([]);
  });

  it("centres the page in a column of its own width", () => {
    const found = blocks(shell.rules).find((block) => block.selector === ".pdisc-shell");
    expect(found?.body).toMatch(/max-width:\s*calc\(var\(--margin-panel\)/);
    expect(found?.body).toMatch(/margin-inline:\s*auto/);
  });
});
