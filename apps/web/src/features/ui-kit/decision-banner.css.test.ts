import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DECISION_BANNER_SPECS, DECISION_KINDS, type DecisionTone } from "./decision";

/**
 * Contract tests for decision-banner.css against docs/design.md §3, §5.2
 * and §9.
 *
 * They read the shipped stylesheet and the shipped tokens, so a token or a
 * colour change that would push the banner's text below 4.5:1 or its icon
 * below 3:1 fails here instead of in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bannerCss = readFileSync(join(here, "decision-banner.css"), "utf8");
/** The rules only: the header comment talks about colour ratios on purpose. */
const bannerRules = bannerCss.replace(/\/\*[\s\S]*?\*\//g, "");
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

const toneDeclarations = (tone: DecisionTone) =>
  declarations(
    tone === "neutral"
      ? block(bannerCss, ".sch-decision")
      : block(bannerCss, `.sch-decision[data-tone="${tone}"]`),
  );

const TONES_IN_USE = [
  ...new Set(DECISION_KINDS.map((kind) => DECISION_BANNER_SPECS[kind].tone)),
];

describe("decision-banner.css tokens", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(bannerRules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(bannerRules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour: AI output must not look like a decision", () => {
    expect(bannerRules).not.toMatch(/--ai\b/);
    expect(bannerRules).not.toMatch(/--ai-soft\b/);
  });

  it("gives every colour family in use a rule that sets icon, fill and edge", () => {
    expect(TONES_IN_USE.sort()).toEqual(["critical", "neutral", "pending"]);
    for (const tone of TONES_IN_USE) {
      const rule = toneDeclarations(tone);
      expect(rule["--banner-icon"], `${tone} icon`).toBeTruthy();
      expect(rule["--banner-fill"], `${tone} fill`).toBeTruthy();
      expect(rule["--banner-edge"], `${tone} edge`).toBeTruthy();
    }
  });

  it("maps each colour family onto its own design.md §3 tokens", () => {
    for (const tone of ["pending", "critical"] as const) {
      const rule = toneDeclarations(tone);
      expect(tokenOf(rule["--banner-icon"])).toBe(tone);
      expect(tokenOf(rule["--banner-fill"])).toBe(`${tone}-soft`);
      expect(tokenOf(rule["--banner-edge"])).toBe(tone);
    }
    const neutral = toneDeclarations("neutral");
    expect(tokenOf(neutral["--banner-icon"])).toBe("ink-2");
    expect(tokenOf(neutral["--banner-fill"])).toBe("surface");
    expect(tokenOf(neutral["--banner-edge"])).toBe("rule");
  });

  it("keeps the word in --ink and the sentence in --ink-2: the status colour belongs to the icon and border", () => {
    expect(declarations(block(bannerCss, ".sch-decision")).color).toBe("var(--ink)");
    expect(declarations(block(bannerCss, ".sch-decision__word")).color).toBe(
      "var(--ink)",
    );
    expect(declarations(block(bannerCss, ".sch-decision__detail")).color).toBe(
      "var(--ink-2)",
    );
  });

  it("links in the accent colour, on anchors and on the record link alike", () => {
    expect(declarations(block(bannerCss, ".sch-decision__links a")).color).toBe(
      "var(--accent)",
    );
  });

  it("spans its column at full width with the card radius (design.md §5.2, §7)", () => {
    const banner = declarations(block(bannerCss, ".sch-decision"));
    expect(banner["inline-size"]).toBe("100%");
    expect(banner["border-radius"]).toBe("var(--corner-card)");
    expect(banner["font-size"]).toBe("var(--type-ui)");
    expect(banner["line-height"]).toBe("var(--leading-ui)");
  });

  it("sets no margin on the banner, so consumers' spacing utilities still apply", () => {
    expect(block(bannerCss, ".sch-decision")).not.toMatch(/margin/);
  });

  it("gives links 44 px targets on touch (design.md §9)", () => {
    const coarse = bannerCss.match(
      /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(coarse).toMatch(/min-height:\s*calc\(var\(--space-unit\) \* 11\)/);
  });

  it("restores a visible shape in forced-colours mode", () => {
    expect(bannerCss).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(bannerCss).toMatch(/border-color:\s*CanvasText/);
  });
});

describe("decision-banner.css contrast (design.md §3: text ≥ 4.5:1)", () => {
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
      const fill = colour(tokenOf(rule["--banner-fill"]));
      const icon = colour(tokenOf(rule["--banner-icon"]));

      it(`${theme} · ${tone}: the word (--ink) is at least 4.5:1 on the fill`, () => {
        expect(contrast(colour("ink"), fill)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme} · ${tone}: the sentence (--ink-2) is at least 4.5:1 on the fill`, () => {
        expect(contrast(colour("ink-2"), fill)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme} · ${tone}: the icon is at least 3:1 on the fill (WCAG 1.4.11)`, () => {
        expect(contrast(icon, fill)).toBeGreaterThanOrEqual(3);
      });

      it(`${theme} · ${tone}: the links (--accent) are at least 4.5:1 on the fill`, () => {
        expect(contrast(colour("accent"), fill)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
