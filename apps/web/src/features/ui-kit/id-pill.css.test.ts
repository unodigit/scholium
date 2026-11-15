import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for id-pill.css against docs/design.md §3, §7, §9 and §10.
 *
 * They read the shipped stylesheet, so a hard-coded colour, an id that can
 * outgrow its column, a reset focus ring or a touch target below 44 px fails
 * here instead of in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "id-pill.css"), "utf8");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first `selector { … }` block with no nested braces. */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (!match) throw new Error(`No block found for ${selector}`);
  return match[1];
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/(-{0,2}[a-z][\w-]*)\s*:\s*([^;]+);/g)) {
    result[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return result;
}

describe("id-pill.css colour", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("is neutral: an id is reference text, so it takes no status colour", () => {
    for (const token of ["verified", "pending", "critical"]) {
      expect(rules).not.toMatch(new RegExp(`--${token}\\b`));
      expect(rules).not.toMatch(new RegExp(`--${token}-soft\\b`));
    }
  });
});

describe("id-pill.css pill", () => {
  const pill = declarations(block(rules, ".sch-id-pill"));

  it("sets the id in the design's monospace ID style", () => {
    expect(pill["font-family"]).toBe("var(--family-mono)");
    expect(pill["font-size"]).toBe("var(--type-mono)");
    expect(pill["line-height"]).toBe("var(--leading-mono)");
    expect(pill["font-variant-ligatures"]).toBe("none");
  });

  it("is a hairline pill in the rule colour", () => {
    expect(pill.display).toBe("inline-flex");
    expect(pill.border).toBe("1px solid var(--rule)");
    expect(pill["border-radius"]).toBe("var(--corner-pill)");
    expect(pill.color).toBe("var(--ink)");
  });

  it("is reset to the button's box and still reads as clickable", () => {
    expect(pill.appearance).toBe("none");
    expect(pill.cursor).toBe("pointer");
  });

  it("tints through a mix of the ink token, not a fixed colour", () => {
    expect(pill["background-color"]).toBe(
      "color-mix(in srgb, var(--ink) 4%, transparent)",
    );
  });

  it("never outgrows its container", () => {
    expect(pill["max-inline-size"]).toBe("100%");
    const id = declarations(block(rules, ".sch-id-pill__id"));
    expect(id["overflow-wrap"]).toBe("anywhere");
    expect(id["min-inline-size"]).toBe("0");
  });

  it("sets no margin, so consumers' spacing utilities still apply", () => {
    expect(rules).not.toMatch(/\.sch-id-pill\s*\{[^}]*margin\s*:/);
  });

  it("does not reset the outline: the global 2 px focus ring applies", () => {
    expect(rules).not.toMatch(/outline\s*:/);
    expect(rules).not.toMatch(/outline-(?:width|style|color|offset)\s*:/);
  });

  it("turns off the browser's square tap flash: :active is the feedback", () => {
    const pill = declarations(block(rules, ".sch-id-pill"));
    expect(pill["-webkit-tap-highlight-color"]).toBe("transparent");
  });

  it("applies hover only on hover-capable pointers, so it cannot stick after a tap", () => {
    expect(rules).toMatch(
      /@media\s*\(hover:\s*hover\)\s*\{\s*\.sch-id-pill:hover\s*\{/,
    );
    // ...and nowhere outside that query.
    const outside = rules.replace(
      /@media\s*\(hover:\s*hover\)\s*\{[\s\S]*?\n\}/,
      "",
    );
    expect(outside).not.toMatch(/:hover/);
  });

  it("responds to hover and press with a darker rule and tint", () => {
    const hover = declarations(block(rules, ".sch-id-pill:hover"));
    expect(hover["border-color"]).toBe("var(--ink-2)");
    expect(hover["background-color"]).toBe(
      "color-mix(in srgb, var(--ink) 8%, transparent)",
    );
    const active = declarations(block(rules, ".sch-id-pill:active"));
    expect(active["background-color"]).toBe(
      "color-mix(in srgb, var(--ink) 12%, transparent)",
    );
  });
});

describe("id-pill.css glyph", () => {
  it("keeps its size and never shrinks beside a wrapping id", () => {
    const icon = declarations(block(rules, ".sch-id-pill__icon"));
    expect(icon.flex).toBe("none");
    expect(icon["inline-size"]).toBe("calc(var(--space-unit) * 3.5)");
    expect(icon["block-size"]).toBe("calc(var(--space-unit) * 3.5)");
    expect(icon.color).toBe("var(--ink-2)");
  });

  it("darkens after a copy, so the tick is not a colour change alone", () => {
    const copied = declarations(
      block(rules, '.sch-id-pill[data-copied="true"] .sch-id-pill__icon'),
    );
    expect(copied.color).toBe("var(--ink)");
  });
});

describe("id-pill.css accessibility and responsiveness", () => {
  it("gives a touch target 44 px (design.md §9)", () => {
    const coarse =
      /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.sch-id-pill\s*\{([^}]*)\}/.exec(
        rules,
      );
    expect(coarse).not.toBeNull();
    expect(declarations(coarse?.[1] ?? "")["min-block-size"]).toBe(
      "calc(var(--space-unit) * 11)",
    );
  });

  it("is at least 24 px tall for a pointer, as a compact inline element", () => {
    const pill = declarations(block(rules, ".sch-id-pill"));
    expect(pill["min-block-size"]).toBe("calc(var(--space-unit) * 6)");
  });

  it("drops its transition under reduced motion", () => {
    const reduced =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.sch-id-pill\s*\{([^}]*)\}/.exec(
        rules,
      );
    expect(reduced).not.toBeNull();
    expect(declarations(reduced?.[1] ?? "").transition).toBe("none");
  });

  it("keeps its border and glyph visible in forced-colours mode", () => {
    expect(rules).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(rules).toMatch(/border-color:\s*ButtonText/);
    expect(rules).toMatch(/\.sch-id-pill__icon\s*\{\s*color:\s*ButtonText/);
  });
});
