import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PAPER_STATUSES, STATUS_CHIP_SPECS, type StatusTone } from "./status";

/**
 * Contract tests for status-chip.css against docs/design.md §3 and §9.
 *
 * They read the shipped stylesheet and the shipped tokens, so a token or a
 * colour change that would push a chip below 4.5:1 (text) or 3:1 (icon) fails
 * here instead of in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const chipCss = readFileSync(join(here, "status-chip.css"), "utf8");
/** The rules only: the header comment talks about --ai and 4.5:1 on purpose. */
const chipRules = chipCss.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = readFileSync(join(here, "..", "..", "styles", "tokens.css"), "utf8");

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

/** `var(--x)` → `x`. */
function tokenOf(value: string): string {
  const match = /^var\(--([\w-]+)\)$/.exec(value);
  if (!match) throw new Error(`Expected a single var(--token), got "${value}"`);
  return match[1];
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (foreground: string, background: string) => {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
};

const toneDeclarations = (tone: StatusTone) =>
  declarations(
    tone === "neutral"
      ? block(chipCss, ".sch-chip")
      : block(chipCss, `.sch-chip[data-tone="${tone}"]`),
  );

const TONES_IN_USE = [
  ...new Set(PAPER_STATUSES.map((status) => STATUS_CHIP_SPECS[status].tone)),
];

describe("status-chip.css tokens", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(chipRules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(chipRules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour: AI output must not look like human status", () => {
    expect(chipRules).not.toMatch(/--ai\b/);
    expect(chipRules).not.toMatch(/--ai-soft\b/);
  });

  it("gives every colour family in use a rule that sets icon, fill and edge", () => {
    expect(TONES_IN_USE.sort()).toEqual(["critical", "neutral", "pending", "verified"]);
    for (const tone of TONES_IN_USE) {
      const rule = toneDeclarations(tone);
      expect(rule["--chip-icon"], `${tone} icon`).toBeTruthy();
      expect(rule["--chip-fill"], `${tone} fill`).toBeTruthy();
      expect(rule["--chip-edge"], `${tone} edge`).toBeTruthy();
    }
  });

  it("maps each colour family onto its own design.md §3 tokens", () => {
    for (const tone of ["verified", "pending", "critical"] as const) {
      const rule = toneDeclarations(tone);
      expect(tokenOf(rule["--chip-icon"])).toBe(tone);
      expect(tokenOf(rule["--chip-fill"])).toBe(`${tone}-soft`);
      expect(tokenOf(rule["--chip-edge"])).toBe(tone);
    }
    const neutral = toneDeclarations("neutral");
    expect(tokenOf(neutral["--chip-icon"])).toBe("ink-2");
    expect(tokenOf(neutral["--chip-fill"])).toBe("surface");
    expect(tokenOf(neutral["--chip-edge"])).toBe("rule");
  });

  it("keeps the word in --ink: the status colour belongs to the icon and border", () => {
    expect(declarations(block(chipCss, ".sch-chip")).color).toBe("var(--ink)");
    expect(declarations(block(chipCss, ".sch-chip__label")).color).toBe("var(--ink)");
  });

  it("sizes and spaces from the 4 px unit and the pill radius", () => {
    const chip = declarations(block(chipCss, ".sch-chip"));
    expect(chip["border-radius"]).toBe("var(--corner-pill)");
    expect(chip.gap).toBe("var(--space-unit)");
    expect(chip["min-height"]).toBe("calc(var(--space-unit) * 6)");
    expect(chip["padding-inline"]).toBe("calc(var(--space-unit) * 2)");
    expect(chip["font-size"]).toBe("var(--type-meta)");
    expect(chip["line-height"]).toBe("var(--leading-meta)");
  });

  it("keeps the label on one line", () => {
    expect(declarations(block(chipCss, ".sch-chip"))["white-space"]).toBe("nowrap");
  });

  it("sets no margin, so consumers' spacing utilities still apply", () => {
    expect(chipRules).not.toMatch(/(^|[\s{;])margin(-[a-z]+)?\s*:/);
  });

  it("restores a visible shape in forced-colours mode", () => {
    expect(chipCss).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(chipCss).toMatch(/border-color:\s*CanvasText/);
  });
});

describe("status-chip.css contrast (design.md §3: text ≥ 4.5:1)", () => {
  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", '[data-theme="dark"]'],
  ] as const) {
    const tokens = declarations(block(tokensCss, selector));
    const colour = (name: string) => {
      const value = tokens[`--${name}`];
      if (!value) throw new Error(`--${name} is not defined for ${theme}`);
      return value;
    };

    for (const tone of TONES_IN_USE) {
      const rule = toneDeclarations(tone);
      const fill = colour(tokenOf(rule["--chip-fill"]));
      const icon = colour(tokenOf(rule["--chip-icon"]));

      it(`${theme} · ${tone}: the word (--ink) is at least 4.5:1 on the fill`, () => {
        expect(contrast(colour("ink"), fill)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme} · ${tone}: the icon is at least 3:1 on the fill (WCAG 1.4.11)`, () => {
        expect(contrast(icon, fill)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
