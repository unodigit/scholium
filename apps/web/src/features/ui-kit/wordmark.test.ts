// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORDMARK } from "./wordmark";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const read = (path: string) => readFileSync(here(path));
const json = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../docs/brand/${name}`, import.meta.url)), "utf8"));

describe("the outlined wordmark", () => {
  const source = json("scholium-wordmark.json");

  it("copies the viewBox verbatim", () => {
    expect(WORDMARK.viewBox).toEqual(source.view_box);
  });

  it("copies the pen origin", () => {
    expect(WORDMARK.penOriginX).toBe(source.pen_origin_x);
  });

  it("copies the path verbatim", () => {
    expect(WORDMARK.path).toBe(source.path);
  });

  it("names the generator in its header comment", () => {
    const sourceText = readFileSync(here("./wordmark.ts"), "utf8");
    expect(sourceText).toContain("docs/brand/build_lockup.py");
  });
});

describe("the brand lockup PNGs", () => {
  const pairs: [string, string][] = [
    ["scholium-logo-light.png", "scholium-lockup-light.png"],
    ["scholium-logo-dark.png", "scholium-lockup-dark.png"],
    ["scholium-lockup-email.png", "scholium-lockup-email.png"],
  ];

  for (const [served, delivered] of pairs) {
    it(`${served} is byte-identical to docs/brand/${delivered}`, () => {
      const a = read(`../../../public/brand/${served}`);
      const b = readFileSync(fileURLToPath(new URL(`../../../../../docs/brand/${delivered}`, import.meta.url)));
      expect(a.equals(b)).toBe(true);
    });
  }
});
