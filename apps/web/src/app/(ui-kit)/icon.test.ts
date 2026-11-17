// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Next.js serves a file at `app/icon.svg` as the document's icon (and emits the
 * `<link rel="icon">` that stops browsers asking for `/favicon.ico`). Guard the
 * file the convention depends on, and that it is a real, scalable SVG.
 */
describe("the app icon", () => {
  it("is the SVG that Next serves at app/icon.svg", () => {
    const path = fileURLToPath(new URL("../icon.svg", import.meta.url));
    const svg = readFileSync(path, "utf8");

    expect(svg.trimStart()).toMatch(/^<svg[\s>]/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 32 32"');
  });
});
