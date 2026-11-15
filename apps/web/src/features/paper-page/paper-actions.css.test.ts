import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for paper-actions.css (the Download menu and the Cite dialog)
 * against docs/design.md §3 (tokens: no shadow, 6/10 px radii), §5.2, §9
 * (accessibility) and §10 (responsive behaviour).
 *
 * The stylesheet is read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores), a lost focus ring or a menu that cannot be
 * hidden fails here rather than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const actions = read(join(here, "paper-actions.css"));

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
    .filter(({ selector: list }) => list.split(",").some((part) => part.trim() === selector))
    .map(({ body }) => body)
    .join("\n");
}

/** The text inside every `@media <query> { … }` block, brace-matched. */
function inMedia(css: { rules: string }, query: string): string {
  const inside: string[] = [];
  const marker = `@media ${query} {`;
  for (
    let at = css.rules.indexOf(marker);
    at !== -1;
    at = css.rules.indexOf(marker, at + marker.length)
  ) {
    const open = at + marker.length - 1;
    let depth = 0;
    let end = open;
    for (; end < css.rules.length; end += 1) {
      if (css.rules[end] === "{") depth += 1;
      if (css.rules[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    inside.push(css.rules.slice(open + 1, end));
  }
  return inside.join("\n");
}

const declarationsIn = (query: string, selector: string): string =>
  declarations({ rules: inMedia(actions, query) }, selector);

/** The `z-index` another stylesheet gives `selector`. */
function zIndexOf(relativePath: string, selector: string): number {
  const css = read(join(here, relativePath));
  const value = /z-index:\s*(\d+)/.exec(declarations(css, selector));
  if (value === null) throw new Error(`${relativePath} gives ${selector} no z-index`);
  return Number(value[1]);
}

const PHONE = "(width < 40rem)";
const FOCUS_RING = /outline:\s*2px solid var\(--focus-ring\)/;
const TOUCH_TARGET = /min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/;

describe("paper-actions.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(actions.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(actions.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("only reads custom properties that exist", () => {
    const defined = new Set(
      [
        ...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g),
        ...actions.rules.matchAll(/(--[a-z0-9-]+)\s*:/g),
      ].map((match) => match[1]),
    );
    const used = [...actions.rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("never uses the reserved AI colour: nothing here is AI output", () => {
    expect(actions.rules).not.toMatch(/--ai\b/);
  });

  it("casts no shadow: only the annotation popover floats", () => {
    expect(actions.rules).not.toMatch(/box-shadow|drop-shadow|text-shadow/);
  });

  it("starts every selector from a ppg class, so nothing leaks into other features", () => {
    const selectors = blocks(actions.rules)
      .flatMap(({ selector }) => selector.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector !== "");

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toMatch(/^\.ppg(?:-|$|[\s:[])/);
    }
  });
});

describe("layering", () => {
  it("puts the menu above the margin drawer and under the global nav", () => {
    const menu = zIndexOf("paper-actions.css", ".ppg-menu-list");
    expect(menu).toBeGreaterThan(zIndexOf("paper-page.css", ".ppg-margin[data-enhanced=\"true\"]"));
    expect(menu).toBeLessThan(zIndexOf("../../components/nav/nav.css", ".gn-header"));
  });

  it("puts the dialog above the record side sheet and under the toast", () => {
    const dialog = zIndexOf("paper-actions.css", ".ppg-dialog-backdrop");
    expect(dialog).toBeGreaterThan(zIndexOf("../ui-kit/record-link.css", ".sch-record-sheet"));
    expect(dialog).toBeLessThan(zIndexOf("../ui-kit/toast.css", ".sch-toast-region"));
  });

  it("covers the whole viewport with the scrim token, so it follows light and dark", () => {
    const backdrop = declarations(actions, ".ppg-dialog-backdrop");
    expect(backdrop).toMatch(/position:\s*fixed/);
    expect(backdrop).toMatch(/inset:\s*0/);
    expect(backdrop).toMatch(/background-color:\s*var\(--scrim\)/);
  });
});

describe("the Download menu", () => {
  it("keeps a closed menu hidden whatever else sets its display", () => {
    expect(declarations(actions, ".ppg-menu-list[hidden]")).toMatch(/display:\s*none/);
  });

  it("hangs from its button, so it opens under it", () => {
    expect(declarations(actions, ".ppg-menu")).toMatch(/position:\s*relative/);
    expect(declarations(actions, ".ppg-menu-list")).toMatch(/position:\s*absolute/);
  });

  it("takes the width of the whole row on a phone, so it never leaves the screen", () => {
    expect(declarations(actions, ".ppg-actions")).toMatch(/position:\s*relative/);
    expect(declarationsIn(PHONE, ".ppg-menu")).toMatch(/position:\s*static/);
    expect(declarationsIn(PHONE, ".ppg-menu-list")).toMatch(/inset-inline:\s*0/);
  });

  it("marks the open menu by fill and border as well as the chevron, never colour alone", () => {
    const open = declarations(actions, '.ppg-menu-button[aria-expanded="true"]');
    expect(open).toMatch(/border-color:\s*var\(--accent\)/);
    expect(open).toMatch(/background-color:\s*var\(--accent-soft\)/);
    expect(declarations(actions, '.ppg-menu-button[aria-expanded="true"] .ppg-menu-chevron')).toMatch(
      /transform:\s*rotate\(180deg\)/,
    );
  });

  it("gives an item a visible 2 px focus ring and a fill, and 44 px on touch", () => {
    expect(declarations(actions, ".ppg-menu-item:focus-visible")).toMatch(FOCUS_RING);
    expect(declarations(actions, ".ppg-menu-item:focus-visible")).not.toBe("");
    expect(declarations(actions, ".ppg-menu-item:hover")).toMatch(/background-color:\s*var\(--accent-soft\)/);
    expect(declarationsIn("(pointer: coarse)", ".ppg-menu-item")).toMatch(TOUCH_TARGET);
  });

  it("sets the chevron's turn on the motion tokens, which reduced motion collapses", () => {
    expect(declarations(actions, ".ppg-menu-chevron")).toMatch(
      /transition:\s*transform var\(--duration-fast\) var\(--ease-decel\)/,
    );
  });
});

describe("the Cite dialog", () => {
  it("sets the dialog on the surface with a border and the 10 px card radius", () => {
    const dialog = declarations(actions, ".ppg-dialog");
    expect(dialog).toMatch(/background-color:\s*var\(--surface\)/);
    expect(dialog).toMatch(/border:\s*1px solid var\(--rule\)/);
    expect(dialog).toMatch(/border-radius:\s*var\(--corner-card\)/);
  });

  it("scrolls inside the viewport instead of running off it", () => {
    const dialog = declarations(actions, ".ppg-dialog");
    expect(dialog).toMatch(/max-block-size:\s*100%/);
    expect(dialog).toMatch(/overflow-y:\s*auto/);
    expect(declarations(actions, ".ppg-dialog-backdrop")).toMatch(/overflow-y:\s*auto/);
  });

  it("gives every control a visible 2 px focus ring in the focus colour", () => {
    for (const selector of [
      ".ppg-dialog-close:focus-visible",
      ".ppg-cite-copy:focus-visible",
      ".ppg-cite-retry:focus-visible",
      ".ppg-cite-text:focus-visible",
    ]) {
      expect(declarations(actions, selector)).toMatch(FOCUS_RING);
    }
  });

  it("makes every button at least 44 px on touch", () => {
    for (const selector of [".ppg-dialog-close", ".ppg-cite-copy", ".ppg-cite-retry"]) {
      expect(declarationsIn("(pointer: coarse)", selector)).toMatch(TOUCH_TARGET);
    }
    expect(declarationsIn("(pointer: coarse)", ".ppg-dialog-close")).toMatch(
      /min-inline-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/,
    );
  });

  it("shows a Copy button that cannot be used yet as dashed and quiet", () => {
    const disabled = declarations(actions, ".ppg-cite-copy:disabled");
    expect(disabled).toMatch(/border-style:\s*dashed/);
    expect(disabled).toMatch(/color:\s*var\(--ink-2\)/);
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
  });

  it("sets the citation in the code face, unwrapped, so what is copied is what is seen", () => {
    const text = declarations(actions, ".ppg-cite-text");
    expect(text).toMatch(/font-family:\s*var\(--family-mono\)/);
    expect(text).toMatch(/white-space:\s*pre/);
    expect(text).toMatch(/overflow:\s*auto/);
  });

  it("sets the version id in the code face, because it is read character by character", () => {
    expect(declarations(actions, ".ppg-cite-id")).toMatch(/font-family:\s*var\(--family-mono\)/);
  });

  it("does not rely on colour alone for a failure: the words stay in the ink colour", () => {
    expect(declarations(actions, ".ppg-cite-error")).toMatch(/color:\s*var\(--ink\)/);
    expect(declarations(actions, ".ppg-cite-icon--critical")).toMatch(/color:\s*var\(--critical\)/);
  });

  it("gives the dialog itself no focus ring: it is not a control, it only takes focus to be named", () => {
    expect(declarations(actions, ".ppg-dialog:focus")).toMatch(/outline:\s*none/);
  });

  it("keeps its edges visible in forced-colours mode, where fills are dropped", () => {
    const forced = inMedia(actions, "(forced-colors: active)");
    expect(forced).toContain(".ppg-dialog");
    expect(forced).toContain(".ppg-menu-list");
    expect(forced).toMatch(/border-color:\s*CanvasText/);
  });
});
