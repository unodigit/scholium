import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { BrandLogo, BrandMark } from "./index";

afterEach(cleanup);

describe("BrandMark", () => {
  it("renders the tile variant as an svg with accessible name", () => {
    render(createElement(BrandMark, { variant: "tile" }));
    const img = screen.getByRole("img", { name: "Scholium" });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(img.getAttribute("data-variant")).toBe("tile");
  });

  it("renders the glyph variant", () => {
    render(createElement(BrandMark, { variant: "glyph" }));
    const img = screen.getByRole("img", { name: "Scholium" });
    expect(img.getAttribute("data-variant")).toBe("glyph");
  });

  it("hides decorative parts", () => {
    const { container } = render(createElement(BrandMark, { variant: "tile" }));
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("applies size data attribute and height", () => {
    const { container } = render(createElement(BrandMark, { size: "lg" }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-size")).toBe("lg");
    expect(root.style.height).toBe("48px");
  });

  it("leaves the default output unchanged: no part classes on any shape", () => {
    const { container: glyph } = render(createElement(BrandMark, { variant: "glyph" }));
    const svg = glyph.querySelector("svg") as SVGSVGElement;
    expect(svg.querySelectorAll("[class]")).toHaveLength(0);

    // The tile is the delivered favicon; `animated` does nothing to it.
    const { container: tile } = render(createElement(BrandMark, { variant: "tile", animated: true }));
    const tileSvg = tile.querySelector("svg") as SVGSVGElement;
    expect(tileSvg.querySelectorAll("[class]")).toHaveLength(0);
  });

  it("animated adds only the part class names — the geometry is untouched", () => {
    const { container: plain } = render(createElement(BrandMark, { variant: "glyph" }));
    const { container: animated } = render(createElement(BrandMark, { variant: "glyph", animated: true }));

    const shapes = (root: HTMLElement) => Array.from(root.querySelector("svg")!.querySelectorAll("rect, path"));
    const geometry = (el: Element) =>
      ["fill", "x", "y", "width", "height", "rx", "d"]
        .map((name) => el.getAttribute(name))
        .join(" ");

    expect(shapes(animated).map((el) => el.getAttribute("class"))).toEqual([
      "page",
      "line",
      "line",
      "line",
      "line",
      "line",
      "strip",
      "bracket",
    ]);
    expect(shapes(plain).map((el) => el.getAttribute("class"))).toEqual(Array.from({ length: 8 }, () => null));
    expect(shapes(animated).map(geometry)).toEqual(shapes(plain).map(geometry));
  });
});

describe("BrandLogo", () => {
  it("renders the lockup with wordmark", () => {
    render(createElement(BrandLogo, {}));
    expect(screen.getByRole("img", { name: "Scholium" })).toBeTruthy();
    expect(screen.getByText("scholium")).toBeTruthy();
  });

  it("renders only the mark when markOnly", () => {
    render(createElement(BrandLogo, { markOnly: true }));
    expect(screen.getByRole("img", { name: "Scholium" })).toBeTruthy();
    expect(screen.queryByText("scholium")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Geometry regression: the glyph and the lockup against the delivered files   */
/* -------------------------------------------------------------------------- */

/**
 * Pixel measurements of `docs/brand/scholium-logo-light.jpeg` (1376 × 768);
 * `scholium-logo-dark.jpeg` measures the same to within 2px. Every proportion
 * below is derived from these, so the component is compared with the delivered
 * artwork and not with a number someone typed into a test.
 *
 *   page block        104 × 118       square corners
 *   text lines        5, 4–5px thick, 72px long (16px inset), last 38px long,
 *                     centres at 22% 36% 50% 64% 78% of the block height
 *   bracket           156 tall, arms 12px thick, stem 13px, 38px wide, centred
 *                     on the page block, arm tips 8px to the right of it
 *   strip pocket      25px from arm tip to stem, as tall as the page block
 *   wordmark          x-height 72px, ascender top level with the page block's
 *                     top, baseline 13px above its bottom, 47px (bracket
 *                     right edge to ink) from the mark
 */
const REFERENCE = {
  page: { width: 104, height: 118 },
  bracketHeight: 156,
  bracketArm: 12,
  bracketStem: 13,
  bracketWidth: 38,
  pageToBracket: 8,
  stripPocket: 25,
  line: { thickness: 4.5, length: 72, inset: 16, lastLength: 38 },
  lineCentres: [0.22, 0.36, 0.5, 0.64, 0.78],
  xHeight: 72,
  baselineAbovePageBottom: 13,
  gapToWordmark: 47,
} as const;

const here = dirname(fileURLToPath(import.meta.url));

interface Point {
  x: number;
  y: number;
}

/** The corner points of an axis-aligned path written with M, H, V, h, v and z. */
function pathPoints(d: string): Point[] {
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  for (const [, command, args] of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (command === "z" || command === "Z") continue;
    if (command === "M") [x, y] = n;
    else if (command === "H") x = n[0];
    else if (command === "V") y = n[0];
    else if (command === "h") x += n[0];
    else if (command === "v") y += n[0];
    else throw new Error(`path command ${command} is not axis-aligned`);
    points.push({ x, y });
  }
  return points;
}

const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

function near(actual: number, expected: number, tolerance: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected} ± ${tolerance}`).toBeLessThanOrEqual(
    tolerance,
  );
}

interface Rect {
  fill: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

/** The glyph's shapes, found by the token they are painted with. */
function glyph() {
  const { container } = render(createElement(BrandMark, { variant: "glyph" }));
  const svg = container.querySelector("svg") as SVGSVGElement;
  const attr = (el: Element, name: string) => Number.parseFloat(el.getAttribute(name) ?? "0");
  const rects: Rect[] = Array.from(svg.querySelectorAll("rect")).map((el) => ({
    fill: el.getAttribute("fill"),
    x: attr(el, "x"),
    y: attr(el, "y"),
    width: attr(el, "width"),
    height: attr(el, "height"),
    rx: attr(el, "rx"),
  }));
  const paint = (fill: string) => rects.filter((rect) => rect.fill === fill);
  const [minX, minY, viewWidth, viewHeight] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);

  const page = paint("var(--accent)");
  const strip = paint("var(--margin-note)");
  const brackets = Array.from(svg.querySelectorAll("path")).filter((el) => el.getAttribute("fill") === "var(--accent)");
  expect(page, "one accent page block").toHaveLength(1);
  expect(strip, "one margin-note strip").toHaveLength(1);
  expect(brackets, "one accent bracket").toHaveLength(1);

  const points = pathPoints(brackets[0].getAttribute("d") ?? "");
  const xs = unique(points.map((p) => p.x));
  const ys = unique(points.map((p) => p.y));
  const bracket = {
    left: xs[0],
    right: xs[xs.length - 1],
    top: ys[0],
    bottom: ys[ys.length - 1],
    stem: xs[xs.length - 1] - xs[xs.length - 2],
    arm: ys[1] - ys[0],
  };

  return {
    svg,
    viewBox: { minX, minY, width: viewWidth, height: viewHeight },
    page: page[0],
    lines: paint("var(--bg)"),
    strip: strip[0],
    bracket,
  };
}

describe("BrandMark glyph geometry (docs/brand/scholium-logo-light.jpeg)", () => {
  const ref = REFERENCE;

  it("is a near-square page block with square corners", () => {
    const { page } = glyph();
    near(page.width / page.height, ref.page.width / ref.page.height, 0.04, "page width:height");
    expect(page.rx, "the delivered page block has sharp corners").toBe(0);
  });

  it("holds five light text lines with rounded ends, the last about half length", () => {
    const { page, lines } = glyph();
    expect(lines).toHaveLength(5);

    for (const line of lines) {
      expect(line.rx, "rounded ends").toBeCloseTo(line.height / 2, 5);
      near(line.height / page.height, ref.line.thickness / ref.page.height, 0.012, "line thickness");
      near((line.x - page.x) / page.width, ref.line.inset / ref.page.width, 0.03, "line inset");
      expect(line.x).toBe(lines[0].x);
    }

    const [first, second, third, fourth, last] = lines;
    for (const line of [second, third, fourth]) expect(line.width).toBe(first.width);
    near(first.width / page.width, ref.line.length / ref.page.width, 0.04, "full line length");
    near(last.width / first.width, ref.line.lastLength / ref.line.length, 0.07, "last line / full line");
    expect(last.width).toBeLessThan(first.width * 0.65);

    // Evenly spaced, at the delivered heights, none leaving the page.
    lines.forEach((line, i) => {
      const centre = (line.y + line.height / 2 - page.y) / page.height;
      near(centre, ref.lineCentres[i], 0.03, `line ${i + 1} centre`);
      expect(line.y).toBeGreaterThan(page.y);
      expect(line.y + line.height).toBeLessThan(page.y + page.height);
      expect(line.x + line.width).toBeLessThan(page.x + page.width);
    });
    const pitch = lines.slice(1).map((line, i) => line.y - lines[i].y);
    for (const step of pitch) near(step, pitch[0], 0.01, "line pitch");
  });

  it("closes with a bracket about 1.35x the page, centred on it, thin-stroked", () => {
    const { page, bracket } = glyph();
    const height = bracket.bottom - bracket.top;
    near(height / page.height, ref.bracketHeight / ref.page.height, 0.05, "bracket height / page height");
    expect(height, "taller than the page block").toBeGreaterThan(page.height);

    const pageCentre = page.y + page.height / 2;
    near((bracket.top + bracket.bottom) / 2, pageCentre, page.height * 0.01, "bracket vertical centre");

    near(bracket.arm / page.width, ref.bracketArm / ref.page.width, 0.03, "bracket arm / page width");
    near(bracket.stem / page.width, ref.bracketStem / ref.page.width, 0.03, "bracket stem / page width");
    near((bracket.right - bracket.left) / page.width, ref.bracketWidth / ref.page.width, 0.04, "bracket width");
    near(
      (bracket.left - (page.x + page.width)) / page.width,
      ref.pageToBracket / ref.page.width,
      0.03,
      "page to bracket arm tips",
    );
  });

  it("puts a wide margin-note strip between page and bracket, as tall as the page", () => {
    const { page, strip, bracket } = glyph();
    near(strip.width / page.width, 0.25, 0.03, "strip width / page width");
    near(strip.width / page.width, ref.stripPocket / ref.page.width, 0.03, "strip fills the bracket pocket");
    expect(strip.rx, "a plain strip, not a pill").toBe(0);
    expect(strip.x).toBeGreaterThanOrEqual(page.x + page.width);
    expect(strip.x + strip.width).toBeLessThanOrEqual(bracket.right - bracket.stem + 1e-6);
    near(strip.y, page.y, page.height * 0.01, "strip top");
    near(strip.height, page.height, page.height * 0.01, "strip height");
  });

  it("is painted from the tokens and drawn on a tight, undistorted viewBox", () => {
    const { svg, viewBox, page, bracket } = glyph();
    const fills = new Set(Array.from(svg.querySelectorAll("rect, path")).map((el) => el.getAttribute("fill")));
    expect(fills).toEqual(new Set(["var(--accent)", "var(--bg)", "var(--margin-note)"]));

    expect(viewBox.minX).toBe(0);
    expect(viewBox.minY).toBe(0);
    expect(viewBox.height).toBe(bracket.bottom);
    expect(viewBox.width).toBe(bracket.right);
    expect(page.x).toBe(0);
    expect(Number(svg.getAttribute("width")) / Number(svg.getAttribute("height"))).toBeCloseTo(
      viewBox.width / viewBox.height,
      5,
    );
  });

  it("has this exact geometry (rendered snapshot)", () => {
    const { svg } = glyph();
    const rows = Array.from(svg.querySelectorAll("rect, path")).map((el) => {
      const get = (name: string) => el.getAttribute(name);
      return el.tagName === "path"
        ? [el.tagName, get("fill"), get("d")]
        : [el.tagName, get("fill"), get("x"), get("y"), get("width"), get("height"), get("rx")];
    });
    expect({ viewBox: svg.getAttribute("viewBox"), shapes: rows }).toMatchInlineSnapshot(`
      {
        "shapes": [
          [
            "rect",
            "var(--accent)",
            null,
            "7",
            "36",
            "40",
            null,
          ],
          [
            "rect",
            "var(--bg)",
            "5.5",
            "15",
            "25",
            "1.6",
            "0.8",
          ],
          [
            "rect",
            "var(--bg)",
            "5.5",
            "20.6",
            "25",
            "1.6",
            "0.8",
          ],
          [
            "rect",
            "var(--bg)",
            "5.5",
            "26.2",
            "25",
            "1.6",
            "0.8",
          ],
          [
            "rect",
            "var(--bg)",
            "5.5",
            "31.8",
            "25",
            "1.6",
            "0.8",
          ],
          [
            "rect",
            "var(--bg)",
            "5.5",
            "37.4",
            "13",
            "1.6",
            "0.8",
          ],
          [
            "rect",
            "var(--margin-note)",
            "39",
            "7",
            "9",
            "40",
            null,
          ],
          [
            "path",
            "var(--accent)",
            "M39 0h13v54H39v-4h9V4h-9z",
          ],
        ],
        "viewBox": "0 0 52 54",
      }
    `);
  });
});

describe("BrandMark tile is the delivered favicon", () => {
  const delivered = readFileSync(join(here, "../../../../../docs/brand/scholium-favicon.svg"), "utf8");
  const deliveredPaths = [...delivered.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);

  it("draws the delivered paths and tile rect exactly, with three text lines", () => {
    const { container } = render(createElement(BrandMark, { variant: "tile" }));
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 32 32");

    const rect = svg.querySelector("rect") as SVGRectElement;
    expect(rect.getAttribute("width")).toBe("32");
    expect(rect.getAttribute("height")).toBe("32");
    expect(rect.getAttribute("rx")).toBe("6");

    const paths = Array.from(svg.querySelectorAll("path")).map((el) => el.getAttribute("d"));
    expect(paths).toEqual(deliveredPaths);

    // The page block's path is one outline plus one cut-out per text line.
    expect((paths[0] ?? "").match(/[Mm]/g)).toHaveLength(1 + 3);
  });
});

describe("BrandLogo lockup proportions (stylesheet)", () => {
  const css = readFileSync(join(here, "brand.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const ref = REFERENCE;

  /** Declarations of the first rule whose selector is exactly `selector`. */
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.[\]"=()*]/g, "\\$&");
    const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    expect(match, `${selector} rule`).not.toBeNull();
    return match?.[1] ?? "";
  };
  const custom = (selector: string, name: string): number => {
    const value = new RegExp(`${name}:\\s*([0-9.]+)\\s*;`).exec(rule(selector))?.[1];
    expect(value, `${name} in ${selector}`).toBeDefined();
    return Number(value);
  };

  /** Fractions of the lockup height, which is the bracket's height. */
  const markHeight = ref.bracketHeight;

  it("sets the wordmark about 0.3 mark-heights from the mark, not 0.75", () => {
    const gap = custom(".sch-brand-logo", "--brand-logo-gap");
    near(gap, 0.3, 0.05, "gap / mark height");
    expect(rule(".sch-brand-logo")).toMatch(/gap:\s*calc\(var\(--brand-mark-height\)\s*\*\s*var\(--brand-logo-gap\)\)/);
  });

  it("does not put the mark's own clear-space margins between mark and wordmark", () => {
    expect(rule(".sch-brand-logo__mark")).toMatch(/margin:\s*0\s*;/);
  });

  it("sizes the wordmark to the reference x-height", () => {
    const xHeight = custom(".sch-brand-logo", "--brand-logo-x-height");
    near(xHeight, ref.xHeight / markHeight, 0.03, "x-height / mark height");
    const wordmark = rule(".sch-brand-logo__wordmark");
    expect(wordmark).toMatch(/font-size:\s*var\(--brand-mark-height\)\s*;/);
    expect(wordmark).toMatch(/font-size-adjust:\s*var\(--brand-logo-x-height\)\s*;/);
    expect(wordmark).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(wordmark).toMatch(/font-weight:\s*600/);
    expect(wordmark).toMatch(/color:\s*var\(--ink\)/);
  });

  it("sits the baseline just above the page block's bottom edge, as delivered", () => {
    const { page, viewBox } = glyph();
    const pageBottom = (viewBox.height - (page.y + page.height)) / viewBox.height;
    const baseline = custom(".sch-brand-logo", "--brand-logo-baseline");
    const expected = pageBottom + ref.baselineAbovePageBottom / markHeight;
    near(baseline, expected, 0.03, "baseline above the lockup's bottom edge");
    expect(baseline, "above the page block's bottom edge").toBeGreaterThanOrEqual(pageBottom);
  });
});
