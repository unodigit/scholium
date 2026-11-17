import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A result's byline is styled as a feed row's is (feed.css `.fd-row-authors`):
 * ink-coloured names that are not underlined until hovered, even though each
 * one now links to a profile. Without these rules the global `a` style
 * (accent colour, always underlined) would apply to every author name.
 *
 * The stylesheet is read as shipped, comments stripped.
 */

const here = dirname(fileURLToPath(import.meta.url));

const css = readFileSync(join(here, "search-page.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) {
    throw new Error(`No rule for ${selector}`);
  }
  return match[1];
}

describe("search-page.css byline", () => {
  it("sets the author names in ink, as a feed row does", () => {
    expect(rule(".sp-result-authors")).toMatch(/color:\s*var\(--ink\)/);
  });

  it("does not colour or underline author links at rest", () => {
    const declarations = rule(".sp-result-authors a");

    expect(declarations).toMatch(/color:\s*inherit/);
    expect(declarations).toMatch(/text-decoration:\s*none/);
  });

  it("accents and underlines an author link on hover", () => {
    const declarations = rule(".sp-result-authors a:hover");

    expect(declarations).toMatch(/color:\s*var\(--accent\)/);
    expect(declarations).toMatch(/text-decoration:\s*underline/);
  });
});
