import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for docs/design.md §3.
 *
 * These guard the foundation every other screen depends on: the exact palette
 * in both themes, the Tailwind bridge, the three families, the 4 px scale and
 * reduced-motion support. They read the shipped CSS rather than a copy of it,
 * so drift between the design document and the app fails the suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");

const tokensCss = read("tokens.css");
const themeCss = read("theme.css");
const baseCss = read("base.css");
const fontsCss = read("fonts.css");
const indexCss = read("index.css");
const configTs = readFileSync(join(here, "..", "..", "tailwind.config.ts"), "utf8");

/** The 11 tokens named by the feature and docs/design.md §3. */
const CORE_TOKENS = {
  bg: "#fbfaf7",
  surface: "#ffffff",
  ink: "#1b1d22",
  "ink-2": "#5a5f6b",
  rule: "#e4e1d9",
  accent: "#2f4ba0",
  verified: "#1f7a54",
  pending: "#9a6b00",
  critical: "#b3312b",
  ai: "#6b4ba8",
  "margin-note": "#fff6d6",
} as const;

const DARK_TOKENS = {
  bg: "#14151a",
  surface: "#1c1e25",
  ink: "#ecebe6",
  "ink-2": "#a3a7b2",
  rule: "#2c2f38",
  accent: "#8fa6f0",
  verified: "#5cc79a",
  pending: "#e0b14a",
  critical: "#f08a84",
  ai: "#b9a2f2",
  "margin-note": "#3a3320",
} as const;

/** Extract the custom-property declarations of the first block matching a selector. */
function declarationsIn(source: string, selector: string): Record<string, string> {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`No declaration block found for ${selector}`);

  const open = source.indexOf("{", match.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) throw new Error(`Unclosed block for ${selector}`);

  const declarations: Record<string, string> = {};
  for (const declaration of source
    .slice(open + 1, close)
    .matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    declarations[declaration[1]] = declaration[2].replace(/\s+/g, " ").trim().toLowerCase();
  }
  return declarations;
}

describe("design.md colour tokens", () => {
  it("defines every required token with the documented light value", () => {
    const light = declarationsIn(tokensCss, ":root");
    expect(light).toMatchObject(CORE_TOKENS);
  });

  it("remaps every token for a forced dark theme", () => {
    const dark = declarationsIn(tokensCss, '[data-theme="dark"]');
    expect(dark).toMatchObject(DARK_TOKENS);
  });

  it("remaps every token when the OS prefers dark, unless light is forced", () => {
    expect(tokensCss).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    const automatic = declarationsIn(tokensCss, ':root:not([data-theme="light"])');
    expect(automatic).toMatchObject(DARK_TOKENS);
  });

  it("declares a color-scheme for each theme so native controls follow it", () => {
    expect(tokensCss).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/s);
    expect(tokensCss).toMatch(/\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/s);
  });

  it("keeps the AI colour separate from every human status colour", () => {
    const ai = CORE_TOKENS.ai;
    for (const [name, value] of Object.entries(CORE_TOKENS)) {
      if (name === "ai") continue;
      expect(value, `${name} must not reuse the reserved AI colour`).not.toBe(ai);
    }
  });
});

describe("text contrast (design.md §3: text ≥ 4.5:1)", () => {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };

  const contrast = (foreground: string, background: string) => {
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
      (a, b) => b - a,
    );
    return (lighter + 0.05) / (darker + 0.05);
  };

  const TEXT_PAIRS = [
    ["ink", "bg"],
    ["ink", "surface"],
    ["ink-2", "bg"],
    ["ink-2", "surface"],
    ["ink", "accent-soft"],
    ["ink", "verified-soft"],
    ["ink", "pending-soft"],
    ["ink", "critical-soft"],
    ["ink", "ai-soft"],
    ["accent-ink", "accent"],
    ["margin-note-ink", "margin-note"],
  ] as const;

  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", '[data-theme="dark"]'],
  ] as const) {
    it(`${theme}: every documented text pairing is at least 4.5:1`, () => {
      const tokens = declarationsIn(tokensCss, selector);
      for (const [foreground, background] of TEXT_PAIRS) {
        expect(
          contrast(tokens[foreground], tokens[background]),
          `${foreground} on ${background} (${theme})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("Tailwind theme bridge", () => {
  it.each(Object.keys(CORE_TOKENS))("maps --%s to a colour utility", (token) => {
    expect(themeCss).toContain(`--color-${token}: var(--${token});`);
  });

  it("exposes control and card radii from the design scale", () => {
    expect(themeCss).toContain("--radius-control: var(--corner-control);");
    expect(themeCss).toContain("--radius-card: var(--corner-card);");
    expect(tokensCss).toContain("--corner-control: 6px;");
    expect(tokensCss).toContain("--corner-card: 10px;");
  });

  it("mirrors the same tokens in tailwind.config.ts", () => {
    for (const token of Object.keys(CORE_TOKENS)) {
      const key = token.includes("-") ? `"${token}"` : token;
      expect(configTs).toContain(`${key}: "var(--${token})"`);
    }
  });
});

describe("typography", () => {
  it("loads Source Serif 4, Inter and JetBrains Mono as vendored variable fonts", () => {
    expect(fontsCss).toContain('font-family: "Source Serif 4";');
    expect(fontsCss).toContain('font-family: "Inter";');
    expect(fontsCss).toContain('font-family: "JetBrains Mono";');

    const families = declarationsIn(tokensCss, ":root");
    expect(families["family-serif"]).toContain("source serif 4");
    expect(families["family-sans"]).toContain("inter");
    expect(families["family-mono"]).toContain("jetbrains mono");

    for (const file of [
      "source-serif-4-latin.woff2",
      "source-serif-4-italic-latin.woff2",
      "inter-latin.woff2",
      "jetbrains-mono-latin.woff2",
    ]) {
      const bytes = readFileSync(join(here, "..", "..", "public", "fonts", file));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
  });

  it("defines the four documented type roles", () => {
    expect(tokensCss).toContain("--type-title: 1.875rem;");
    expect(tokensCss).toContain("--leading-title: 2.375rem;");
    expect(tokensCss).toContain("--type-reading: 1.125rem;");
    expect(tokensCss).toContain("--leading-reading: 1.875rem;");
    expect(tokensCss).toContain("--type-ui: 0.9375rem;");
    expect(tokensCss).toContain("--leading-ui: 1.375rem;");
    expect(tokensCss).toContain("--type-meta: 0.8125rem;");
    expect(tokensCss).toContain("--leading-meta: 1.125rem;");
  });

  it("caps reading lines at 72 characters", () => {
    expect(tokensCss).toContain("--measure-reading: 72ch;");
    expect(baseCss).toMatch(/\.reading\s*\{[^}]*max-width:\s*var\(--measure-reading\)/s);
  });
});

describe("spacing scale", () => {
  it("bases every spacing utility on the 4 px grid", () => {
    expect(tokensCss).toContain("--space-unit: 0.25rem;");
    expect(themeCss).toContain("--spacing: var(--space-unit);");
  });

  it("mirrors the 4, 8, 12, 16, 24, 32, 48, 64 px scale in the Tailwind config", () => {
    const scale: Record<string, string> = {
      "1": "0.25rem",
      "2": "0.5rem",
      "3": "0.75rem",
      "4": "1rem",
      "6": "1.5rem",
      "8": "2rem",
      "12": "3rem",
      "16": "4rem",
    };
    for (const [step, value] of Object.entries(scale)) {
      expect(configTs).toContain(`${step}: "${value}"`);
    }
  });
});

describe("motion and accessibility", () => {
  it("uses 150–200 ms ease-out motion tokens", () => {
    expect(tokensCss).toContain("--duration-fast: 150ms;");
    expect(tokensCss).toContain("--duration-base: 200ms;");
    expect(tokensCss).toContain("--ease-decel: cubic-bezier(0.23, 1, 0.32, 1);");
    expect(themeCss).toContain("--ease-out: var(--ease-decel);");
  });

  it("honours prefers-reduced-motion by collapsing motion", () => {
    expect(baseCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(baseCss).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(baseCss).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(baseCss).toMatch(/--duration-fast:\s*0\.01ms;/);
  });

  it("honours prefers-reduced-transparency and prefers-contrast", () => {
    expect(baseCss).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
    expect(baseCss).toMatch(/@media\s*\(prefers-contrast:\s*more\)/);
  });

  it("draws keyboard focus rings at 2 px in the accent colour", () => {
    expect(baseCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  });
});

describe("stylesheet entry point", () => {
  it("imports every layer from index.css", () => {
    for (const file of ["fonts.css", "tokens.css", "theme.css", "base.css"]) {
      expect(indexCss).toContain(`@import "./${file}";`);
    }
    expect(indexCss).toMatch(/@import "tailwindcss";/);
  });
});
