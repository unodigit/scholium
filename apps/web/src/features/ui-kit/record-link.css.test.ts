import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for record-link.css against docs/design.md §3, §9 and §10.
 *
 * They read the shipped stylesheet, so a hard-coded colour, a sheet that can
 * outgrow the viewport or a touch target below 44 px fails here instead of in
 * front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "record-link.css"), "utf8");
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

describe("record-link.css trigger", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("looks like a link but is reset to the button's box", () => {
    const link = declarations(block(rules, ".sch-record-link"));
    expect(link.color).toBe("var(--accent)");
    expect(link["text-decoration-line"]).toBe("underline");
    expect(link.border).toBe("0");
    expect(link.background).toBe("none");
    expect(link.display).toBe("inline-flex");
  });

  it("gives a touch target 44 px (design.md §9)", () => {
    expect(rules).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    const coarse =
      /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.sch-record-link\s*\{([^}]*)\}/.exec(
        rules,
      );
    expect(coarse).not.toBeNull();
    expect(declarations(coarse?.[1] ?? "")["min-height"]).toBe(
      "calc(var(--space-unit) * 11)",
    );
  });

  it("sets no margin, so consumers' spacing utilities still apply", () => {
    expect(rules).not.toMatch(/\.sch-record-link\s*\{[^}]*margin\s*:/);
  });
});

describe("record-link.css side sheet", () => {
  it("is a fixed scrim over the page, reading the scrim token", () => {
    const sheet = declarations(block(rules, ".sch-record-sheet"));
    expect(sheet.position).toBe("fixed");
    expect(sheet.inset).toBe("0");
    expect(sheet["background-color"]).toBe("var(--scrim)");
    expect(sheet["justify-content"]).toBe("flex-end");
  });

  it("is a full-height panel as wide as the margin panel, never wider than the viewport", () => {
    const panel = declarations(block(rules, ".sch-record-sheet__panel"));
    expect(panel["inline-size"]).toBe(
      "min(100%, calc(var(--margin-panel) * 1.6))",
    );
    expect(panel["block-size"]).toBe("100%");
    expect(panel["background-color"]).toBe("var(--surface)");
    expect(panel["border-inline-start"]).toBe("1px solid var(--rule)");
    expect(panel["box-shadow"]).toBe("var(--popover-shadow)");
  });

  it("keeps the JSON in mono, wrapped rather than clipped", () => {
    const json = declarations(block(rules, ".sch-record-sheet__json"));
    expect(json["font-family"]).toBe("var(--family-mono)");
    expect(json["font-size"]).toBe("var(--type-mono)");
    expect(json["white-space"]).toBe("pre-wrap");
    expect(json["overflow-wrap"]).toBe("anywhere");
    expect(json["background-color"]).toBe("var(--bg)");
    expect(json.color).toBe("var(--ink)");
  });

  it("gives Close and Try again a 44 px target", () => {
    expect(rules).toMatch(
      /\.sch-record-sheet__close,\s*\.sch-record-sheet__retry\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\) \* 11\)/,
    );
  });

  it("lets the body scroll while the header stays put", () => {
    const body = declarations(block(rules, ".sch-record-sheet__body"));
    expect(body.overflow).toBe("auto");
    expect(body.flex).toBe("1");
  });

  it("animates only when motion is welcome", () => {
    expect(rules).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
    expect(rules).toMatch(/@keyframes\s+sch-record-sheet-in/);
    expect(rules).toMatch(/var\(--duration-base\)/);
    expect(rules).toMatch(/var\(--ease-decel\)/);
  });

  it("keeps the sheet's edges in forced-colours mode", () => {
    expect(rules).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(rules).toMatch(/border-color:\s*CanvasText/);
  });
});
