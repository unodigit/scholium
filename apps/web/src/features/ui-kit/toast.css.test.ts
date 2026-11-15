import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for toast.css against docs/design.md §3 (motion), §7 and §9.
 *
 * They read the shipped stylesheet, so a hard-coded colour, a toast that can
 * swallow clicks or hide behind the record sheet, or an animation that ignores
 * reduced motion fails here instead of in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = strip(readFileSync(join(here, "toast.css"), "utf8"));
const recordLinkRules = strip(readFileSync(join(here, "record-link.css"), "utf8"));

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

describe("toast.css colour", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour or a status colour", () => {
    for (const token of ["ai", "verified", "pending", "critical"]) {
      expect(rules).not.toMatch(new RegExp(`--${token}\\b`));
      expect(rules).not.toMatch(new RegExp(`--${token}-soft\\b`));
    }
  });
});

describe("toast.css region", () => {
  const region = declarations(block(rules, ".sch-toast-region"));

  it("is a fixed strip along the bottom edge, centred", () => {
    expect(region.position).toBe("fixed");
    expect(region["inset-inline"]).toBe("0");
    expect(region.display).toBe("flex");
    expect(region["justify-content"]).toBe("center");
  });

  it("clears the phone's home indicator", () => {
    expect(region["inset-block-end"]).toContain("env(safe-area-inset-bottom");
  });

  it("ignores the pointer, so it can never cover a control", () => {
    expect(region["pointer-events"]).toBe("none");
  });

  it("sits above the record side sheet", () => {
    const sheetZ = Number(
      declarations(block(recordLinkRules, ".sch-record-sheet"))["z-index"],
    );
    expect(Number.isFinite(sheetZ)).toBe(true);
    expect(Number(region["z-index"])).toBeGreaterThan(sheetZ);
  });

  it("takes no room while empty", () => {
    expect(declarations(block(rules, ".sch-toast-region:empty")).display).toBe(
      "none",
    );
  });
});

describe("toast.css toast", () => {
  const toast = declarations(block(rules, ".sch-toast"));

  it("is the page inverse: ink fill, background text", () => {
    expect(toast["background-color"]).toBe("var(--ink)");
    expect(toast.color).toBe("var(--bg)");
  });

  it("reads as a small floating control", () => {
    expect(toast["border-radius"]).toBe("var(--corner-control)");
    expect(toast["box-shadow"]).toBe("var(--popover-shadow)");
    expect(toast["font-size"]).toBe("var(--type-meta)");
    expect(toast["line-height"]).toBe("var(--leading-meta)");
  });

  it("never outgrows the viewport, and wraps a long message", () => {
    expect(toast["max-inline-size"]).toMatch(/^min\(100%, /);
    expect(toast["overflow-wrap"]).toBe("anywhere");
  });
});

describe("toast.css motion and forced colours", () => {
  it("animates only when motion is welcome", () => {
    expect(rules).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
    expect(rules).toMatch(/@keyframes\s+sch-toast-in/);
    expect(rules).toMatch(/var\(--duration-base\)/);
    expect(rules).toMatch(/var\(--ease-decel\)/);
  });

  it("applies the animation only inside the no-preference query", () => {
    const outside = rules.replace(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\n\}/,
      "",
    );
    expect(outside).not.toMatch(/animation\s*:/);
  });

  it("keeps the toast's edge and text legible in forced-colours mode", () => {
    expect(rules).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(rules).toMatch(/border:\s*1px solid CanvasText/);
    expect(rules).toMatch(/background-color:\s*Canvas;/);
  });
});
