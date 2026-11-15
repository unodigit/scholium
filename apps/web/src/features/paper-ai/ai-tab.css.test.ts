import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for ai-tab.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.2 (the AI pre-review tab), §7 (AI finding
 * card) and §9 (accessibility).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a status colour on a word fails here rather
 * than in front of a reader.
 *
 * Unlike every other stylesheet, this one is *required* to use `--ai`: the
 * reserved colour of the AI pre-review (docs/design.md §3). The rest of the
 * colour rules still hold — the purple never touches a word, and the human
 * verdict colours never touch the panel.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const tab = read(join(here, "ai-tab.css"));
const shell = read(join(here, "../../app/(paper-ai)/paper-ai.css"));

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
  ["ai-tab.css", tab],
  ["paper-ai.css", shell],
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

describe("ai-tab.css", () => {
  it("is the AI panel: the reserved --ai colour carries its identity", () => {
    expect(tab.rules).toMatch(/\.ai-banner\s*\{[^}]*border:\s*1px solid var\(--ai\)/);
    expect(tab.rules).toMatch(
      /\.ai-finding\s*\{[^}]*border-inline-start:\s*var\(--space-unit\) solid var\(--ai\)/,
    );
    expect(tab.rules).toMatch(/--ai-soft/);
  });

  it("never puts the AI colour or a status colour on a word (README: 4.5:1 rule)", () => {
    for (const { selector, body } of blocks(tab.rules)) {
      const colouredText = /(^|;|\s)color:\s*var\(--(?:ai|verified|pending|critical)(?:-soft)?\)/;
      if (colouredText.test(body)) {
        expect(selector, `status colour on text in ${selector}`).toMatch(/__icon/);
      }
    }
    // The banner's fill is the tint; its word stays --ink.
    const banner = blocks(tab.rules).find((block) => block.selector === ".ai-banner")!;
    expect(banner.body).toMatch(/background-color:\s*var\(--ai-soft\)/);
    expect(banner.body).toMatch(/(^|;|\s)color:\s*var\(--ink\)/);
  });

  it("a reviewer's verdict is the one human colour here, and only on its icon", () => {
    expect(tab.rules).toMatch(/\.ai-response__icon\s*\{[^}]*color:\s*var\(--verified\)/);
    expect(tab.rules).toMatch(/\.ai-response__icon--wrong\s*\{[^}]*color:\s*var\(--critical\)/);
  });

  it("keeps targets at least 44px, and the ids in monospace", () => {
    for (const selector of [".ai-button", ".ai-provenance__summary"]) {
      const rule = blocks(tab.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/);
    }
    expect(tab.rules).toMatch(
      /\.ai-evidence__value\[data-kind="reference_id"\]/,
    );
    expect(tab.rules).toMatch(/font-family:\s*var\(--family-mono\)/);
  });

  it("lets long claims, quotes and errors wrap instead of overflowing the 360px panel", () => {
    for (const selector of [
      ".ai-finding__claim",
      ".ai-evidence",
      ".ai-evidence__value",
      ".ai-response__text",
      ".ai-finding__error",
      ".ai-provenance__row dd",
    ]) {
      const rule = blocks(tab.rules).find((block) => block.selector === selector);
      expect(rule?.body, selector).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("has a visually hidden class that keeps text readable by assistive technology", () => {
    const hidden = blocks(tab.rules).find((block) => block.selector === ".ai-visually-hidden");
    expect(hidden?.body).toMatch(/position:\s*absolute/);
    expect(hidden?.body).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden?.body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it("quiets its one transition under reduced motion", () => {
    const reduced = tab.rules.slice(tab.rules.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/\.ai-button\s*\{[^}]*transition:\s*none/);
  });

  it("recolours icons, links and buttons in forced-colours mode", () => {
    const forced = tab.rules.slice(tab.rules.indexOf("forced-colors"));
    expect(forced).toMatch(/color:\s*CanvasText/);
    expect(forced).toMatch(/color:\s*LinkText/);
    expect(forced).toMatch(/border-color:\s*ButtonText/);
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...tab.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("ai-"))).toEqual([]);
  });
});

describe("paper-ai.css (the route shell)", () => {
  it("sets no colour of its own: the panel carries its purple", () => {
    for (const { body } of blocks(shell.rules)) {
      expect(body).not.toMatch(/(?:^|;|\s)(?:color|background-color|border[^:]*):\s*[^;]*--(?:ai|verified|pending|critical|accent)\b/);
    }
  });

  it("prefixes every class so nothing leaks into other features", () => {
    const classes = [...shell.rules.matchAll(/\.([a-z][a-z0-9_-]*)/gi)].map((match) => match[1]);
    expect(classes.filter((name) => !name.startsWith("pai-"))).toEqual([]);
  });
});
