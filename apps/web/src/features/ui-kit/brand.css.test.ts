import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("brand.css", () => {
  it("contains no hard-coded colour", () => {
    const css = readFileSync(join(here, "brand.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("component sources contain no hex literal", () => {
    for (const file of ["brand-mark.tsx", "brand-logo.tsx"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});
