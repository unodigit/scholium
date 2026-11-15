// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The text-level contract tests in tokens.test.ts read the CSS sources. These
 * tests run the same PostCSS + Tailwind pipeline Next.js runs, so they catch
 * what only shows up once the stylesheet is compiled:
 *
 *  - a Tailwind package-version mismatch that makes the whole pipeline throw
 *    (`@tailwindcss/postcss` pulling a newer `@tailwindcss/oxide` than the
 *    `tailwindcss` it was released with) — fixed by the root `overrides`;
 *  - utilities that stop following the theme of the element they sit on.
 *
 * The utilities are requested through an explicit probe file rather than by
 * relying on index.css's directory scan: Tailwind's scanner honours
 * .gitignore, and agent worktrees live under an ignored `.claw-forge/`, so a
 * glob-based test would pass on a developer machine and fail in a worktree.
 */
const UTILITIES_UNDER_TEST =
  "bg-bg bg-surface text-ink text-ink-2 border-rule text-accent text-verified " +
  "text-pending text-critical text-ai bg-margin-note p-1 p-2 p-3 p-4 p-6 p-8 " +
  "p-12 p-16 rounded-control rounded-card font-serif font-sans font-mono";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, "index.css");

let css = "";
let workDir = "";

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "scholium-css-"));
  const probe = join(workDir, "utilities.html");
  const entry = join(workDir, "entry.css");
  const toIndex = relative(workDir, indexPath).split("\\").join("/");

  writeFileSync(probe, `<div class="${UTILITIES_UNDER_TEST}"></div>`);
  writeFileSync(
    entry,
    `@import "${toIndex.startsWith(".") ? toIndex : `./${toIndex}`}";\n@source "./utilities.html";\n`,
  );

  const result = await postcss([tailwind()]).process(readFileSync(entry, "utf8"), { from: entry });
  css = result.css;
}, 60_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Body of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n|\\s)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No compiled rule for ${selector}`);
  return match[1] ?? "";
}

describe("compiled stylesheet", () => {
  it("compiles through Tailwind v4 and emits every utility under test", () => {
    for (const name of UTILITIES_UNDER_TEST.split(" ")) {
      expect(() => rule(`.${name}`), `.${name} was not generated`).not.toThrow();
    }
  });

  it("serves Source Serif 4, Inter and JetBrains Mono through font utilities", () => {
    for (const family of ["Source Serif 4", "Inter", "JetBrains Mono"]) {
      expect(css).toContain(`font-family: "${family}"`);
    }
    expect(rule(".font-serif")).toContain("font-family: var(--family-serif)");
    expect(rule(".font-sans")).toContain("font-family: var(--family-sans)");
    expect(rule(".font-mono")).toContain("font-family: var(--family-mono)");
  });

  it("emits a utility for every colour token", () => {
    const colours: Array<[string, string, string]> = [
      [".bg-bg", "background-color", "bg"],
      [".bg-surface", "background-color", "surface"],
      [".text-ink", "color", "ink"],
      [".text-ink-2", "color", "ink-2"],
      [".border-rule", "border-color", "rule"],
      [".text-accent", "color", "accent"],
      [".text-verified", "color", "verified"],
      [".text-pending", "color", "pending"],
      [".text-critical", "color", "critical"],
      [".text-ai", "color", "ai"],
      [".bg-margin-note", "background-color", "margin-note"],
    ];
    for (const [selector, property, token] of colours) {
      expect(rule(selector)).toContain(`${property}: var(--${token})`);
    }
  });

  it("reads tokens directly so a nested data-theme subtree re-themes utilities", () => {
    // A plain @theme makes utilities read `--color-ink`, a :root variable that
    // holds var(--ink) and is resolved there — so utilities inside a nested
    // [data-theme="dark"] would keep the root theme. `@theme inline` makes them
    // read the token itself. (Tailwind still emits the --color-* variables on
    // :root; what matters is that no utility consumes them.)
    expect(css).not.toMatch(/:\s*var\(--color-(?:bg|surface|ink|ink-2|rule|accent|verified|pending|critical|ai|margin-note)\)/);
    expect(rule(".text-ink")).toContain("color: var(--ink)");
    expect(rule(".bg-surface")).toContain("background-color: var(--surface)");
  });

  it("generates the 4 px spacing scale from one unit", () => {
    expect(readFileSync(join(here, "tokens.css"), "utf8")).toContain("--space-unit: 0.25rem;");
    for (const step of [1, 2, 3, 4, 6, 8, 12, 16]) {
      expect(rule(`.p-${step}`)).toContain(`padding: calc(var(--space-unit) * ${step})`);
    }
  });

  it("rounds controls at 6 px and cards at 10 px through tokens", () => {
    expect(rule(".rounded-control")).toContain("border-radius: var(--corner-control)");
    expect(rule(".rounded-card")).toContain("border-radius: var(--corner-card)");
  });

  it("keeps the light, automatic-dark and forced-dark palettes in the output", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(css).toMatch(/\[data-theme="dark"\]\s*\{/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
