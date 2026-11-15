import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VERIFY_BADGE_SPECS, VERIFY_STATES, type VerifyTone } from "./verify";

/**
 * Contract tests for verify-badge.css against docs/design.md §3, §5.3 and §9.
 *
 * They read the shipped stylesheet and the shipped tokens, so a token or a
 * colour change that would push a badge below 4.5:1 (text) or 3:1 (icon) fails
 * here instead of in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const badgeCss = readFileSync(join(here, "verify-badge.css"), "utf8");
/** The rules only: the header comment talks about --ai and 4.5:1 on purpose. */
const badgeRules = badgeCss.replace(/\/\*[\s\S]*?\*\//g, "");
const tokensCss = readFileSync(join(here, "..", "..", "styles", "tokens.css"), "utf8");

/**
 * The declarations of the first `selector { … }` block with no nested braces.
 * The selector must start its line, so `.a` does not match inside `.b:hover .a`.
 */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
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

const toneDeclarations = (tone: VerifyTone) =>
  declarations(
    tone === "neutral"
      ? block(badgeCss, ".sch-verify")
      : block(badgeCss, `.sch-verify[data-tone="${tone}"]`),
  );

const TONES_IN_USE = [
  ...new Set(VERIFY_STATES.map((state) => VERIFY_BADGE_SPECS[state].tone)),
];

describe("verify-badge.css tokens", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(badgeRules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(badgeRules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour: AI output must not look like a human verdict", () => {
    expect(badgeRules).not.toMatch(/--ai\b/);
    expect(badgeRules).not.toMatch(/--ai-soft\b/);
  });

  it("gives every colour family in use a rule that sets icon, fill and edge", () => {
    expect(TONES_IN_USE.sort()).toEqual(["critical", "neutral", "pending", "verified"]);
    for (const tone of TONES_IN_USE) {
      const rule = toneDeclarations(tone);
      expect(rule["--verify-icon"], `${tone} icon`).toBeTruthy();
      expect(rule["--verify-fill"], `${tone} fill`).toBeTruthy();
      expect(rule["--verify-edge"], `${tone} edge`).toBeTruthy();
    }
  });

  it("maps each colour family onto its own design.md §3 tokens", () => {
    for (const tone of ["verified", "pending", "critical"] as const) {
      const rule = toneDeclarations(tone);
      expect(tokenOf(rule["--verify-icon"])).toBe(tone);
      expect(tokenOf(rule["--verify-fill"])).toBe(`${tone}-soft`);
      expect(tokenOf(rule["--verify-edge"])).toBe(tone);
    }
    const neutral = toneDeclarations("neutral");
    expect(tokenOf(neutral["--verify-icon"])).toBe("ink-2");
    expect(tokenOf(neutral["--verify-fill"])).toBe("surface");
    expect(tokenOf(neutral["--verify-edge"])).toBe("rule");
  });

  it("paints the pill from the custom properties the tone rules set", () => {
    const link = declarations(block(badgeCss, ".sch-verify__link"));
    expect(link["background-color"]).toBe("var(--verify-fill)");
    expect(link.border).toBe("1px solid var(--verify-edge)");
    expect(declarations(block(badgeCss, ".sch-verify__icon")).color).toBe(
      "var(--verify-icon)",
    );
  });

  it("keeps the words in --ink: the status colour belongs to the icon and border", () => {
    expect(declarations(block(badgeCss, ".sch-verify__link")).color).toBe("var(--ink)");
    expect(declarations(block(badgeCss, ".sch-verify__label")).color).toBe("var(--ink)");
  });

  it("sizes and spaces from the 4 px unit, the pill radius and the meta type", () => {
    const link = declarations(block(badgeCss, ".sch-verify__link"));
    expect(link["border-radius"]).toBe("var(--corner-pill)");
    expect(link.gap).toBe("var(--space-unit)");
    expect(link["min-block-size"]).toBe("calc(var(--space-unit) * 6)");
    expect(link["padding-inline"]).toBe("calc(var(--space-unit) * 2)");
    expect(link["font-size"]).toBe("var(--type-meta)");
    expect(link["line-height"]).toBe("var(--leading-meta)");
  });

  it("keeps the words on one line", () => {
    expect(declarations(block(badgeCss, ".sch-verify__link"))["white-space"]).toBe(
      "nowrap",
    );
  });

  it("undoes the global link underline at rest, and brings it back on hover", () => {
    expect(
      declarations(block(badgeCss, ".sch-verify__link"))["text-decoration-line"],
    ).toBe("none");
    expect(badgeRules).toMatch(
      /\.sch-verify__link:hover\s+\.sch-verify__label\s*\{[^}]*text-decoration-line:\s*underline/,
    );
  });

  it("sets no margin, so consumers' spacing utilities still apply", () => {
    expect(badgeRules).not.toMatch(/(^|[\s{;])margin(-[a-z]+)?\s*:/);
  });

  it("leaves the global focus ring alone", () => {
    expect(badgeRules).not.toMatch(/\boutline\b/);
  });

  it("restores a visible shape in forced-colours mode", () => {
    expect(badgeCss).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(badgeCss).toMatch(/border-color:\s*LinkText/);
  });

  it("makes the touch target at least 44 px on a coarse pointer", () => {
    expect(badgeCss).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    const coarse = /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.sch-verify__link\s*\{([^}]*)\}/.exec(
      badgeCss,
    );
    expect(coarse).not.toBeNull();
    // 11 × 4 px = 44 px.
    expect(declarations(coarse![1])["min-block-size"]).toBe(
      "calc(var(--space-unit) * 11)",
    );
  });
});

describe("verify-badge.css motion (design.md §3: respect prefers-reduced-motion)", () => {
  it("turns the spinner, and only the spinner", () => {
    const spinning = [...badgeRules.matchAll(/([^{}]+)\{[^}]*\banimation\s*:[^;}]*sch-verify-spin/g)];
    expect(spinning.map((match) => match[1].replace(/\s+/g, " ").trim())).toEqual([
      '.sch-verify[data-state="checking"] .sch-verify__icon',
    ]);
  });

  it("animates transform only, at constant speed, on a loop", () => {
    const keyframes = /@keyframes\s+sch-verify-spin\s*\{([\s\S]*?\})\s*\}/.exec(badgeRules);
    expect(keyframes).not.toBeNull();
    expect(keyframes![1]).toMatch(/transform:\s*rotate\(360deg\)/);
    expect(keyframes![1]).not.toMatch(/\b(?:opacity|width|height|top|left|margin)\s*:/);

    const rule = declarations(
      block(badgeCss, '.sch-verify[data-state="checking"] .sch-verify__icon'),
    );
    expect(rule.animation).toMatch(/\blinear\b/);
    expect(rule.animation).toMatch(/\binfinite\b/);
  });

  it("stops the spinner when the reader asks for reduced motion", () => {
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\n\})/.exec(
      badgeCss,
    );
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(
      /\.sch-verify\[data-state="checking"\]\s+\.sch-verify__icon\s*\{[^}]*animation:\s*none/,
    );
  });

  it("uses the motion tokens, with no ease-in, for its one transition", () => {
    const link = declarations(block(badgeCss, ".sch-verify__link"));
    expect(link.transition).toContain("var(--duration-fast)");
    expect(link.transition).toContain("var(--ease-decel)");
    expect(badgeRules).not.toMatch(/ease-in\b/);
  });
});

describe("verify-badge.css contrast (design.md §3: text ≥ 4.5:1)", () => {
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
      const fill = colour(tokenOf(rule["--verify-fill"]));
      const icon = colour(tokenOf(rule["--verify-icon"]));

      it(`${theme} · ${tone}: the words (--ink) are at least 4.5:1 on the fill`, () => {
        expect(contrast(colour("ink"), fill)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${theme} · ${tone}: the icon is at least 3:1 on the fill (WCAG 1.4.11)`, () => {
        expect(contrast(icon, fill)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
