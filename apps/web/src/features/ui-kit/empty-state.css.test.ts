import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for empty-state.css against docs/design.md §3 and §9.
 *
 * They read the shipped stylesheet, so a hard-coded colour, an accidental
 * second accent or a sub-44 px touch target fails here rather than in front of
 * a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "empty-state.css"), "utf8");
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

describe("empty-state.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("is a quiet panel on a surface, with a dashed rule and no colour-only signal", () => {
    const root = declarations(block(rules, ".sch-empty"));
    expect(root["background-color"]).toBe("var(--surface)");
    expect(root.border).toBe("1px dashed var(--rule)");
    expect(root["border-radius"]).toBe("var(--corner-card)");
  });

  it("sizes from the 4 px unit", () => {
    const root = declarations(block(rules, ".sch-empty"));
    expect(root.padding).toBe("calc(var(--space-unit) * 6)");
    expect(root.gap).toBe("calc(var(--space-unit) * 3)");
  });

  it("keeps the sentence in body ink and within the reading measure", () => {
    const sentence = declarations(block(rules, ".sch-empty__sentence"));
    expect(sentence.color).toBe("var(--ink)");
    expect(sentence["max-width"]).toBe("var(--measure-reading)");
    expect(sentence.margin).toBe("0");
  });

  it("makes the action the only accented thing in the panel", () => {
    const action = declarations(block(rules, ".sch-empty__action"));
    expect(action.color).toBe("var(--accent)");
    expect(action["font-size"]).toBe("var(--type-ui)");
    expect(action["text-decoration-line"]).toBe("underline");
  });

  it("gives a touch action a 44 px target (design.md §9)", () => {
    expect(rules).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    const coarse = /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.sch-empty__action\s*\{([^}]*)\}/.exec(
      rules,
    );
    expect(coarse).not.toBeNull();
    expect(declarations(coarse?.[1] ?? "")["min-height"]).toBe(
      "calc(var(--space-unit) * 11)",
    );
  });

  it("sets no margin on the panel, so consumers' spacing utilities still apply", () => {
    expect(declarations(block(rules, ".sch-empty"))).not.toHaveProperty(
      "margin",
    );
    expect(rules).not.toMatch(/\.sch-empty\s*\{[^}]*margin\s*:/);
  });

  it("restores the dashed shape and the link colour in forced-colours mode", () => {
    expect(rules).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(rules).toMatch(/border-color:\s*CanvasText/);
    expect(rules).toMatch(/color:\s*LinkText/);
  });
});
