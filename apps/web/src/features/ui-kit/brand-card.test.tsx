// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as plainUrlGet, dynamic as plainUrlDynamic } from "../../app/(paper-page)/p/[id]/opengraph-image/route";
import paperCardRoute, {
  alt as paperAlt,
  contentType as paperContentType,
  dynamic as paperDynamic,
  size as paperSize,
} from "../../app/(paper-page)/p/[id]/opengraph-image";
import siteCardRoute, {
  alt as siteAlt,
  contentType as siteContentType,
  size as siteSize,
} from "../../app/opengraph-image";
import twitterCardRoute, {
  alt as twitterAlt,
  contentType as twitterContentType,
  size as twitterSize,
} from "../../app/twitter-image";
import { tokenStore } from "../../lib/api";
import {
  AUTHOR_LINE_CLAMP,
  BRAND_CARD_ALT,
  BRAND_CARD_FONTS,
  BRAND_CARD_PALETTE,
  BRAND_CARD_SIZE,
  BRAND_CARD_TAGLINE,
  BRAND_CARD_WORDMARK,
  BrandCard,
  CARD_PADDING,
  CORNER_MARK_HEIGHT,
  MAX_AUTHORS,
  SITE_CARD,
  SITE_CARD_CACHE_CONTROL,
  SITE_MARK_HEIGHT,
  TITLE_LINE_CLAMP,
  bylineText,
  brandCardFor,
  drawableCard,
  drawableText,
  lockupLayout,
  renderBrandCard,
  statusWord,
  titleLayout,
  type BrandCardProps,
  type PaperCardProps,
  type PaperCardSource,
} from "./brand-card";
import { BrandMark } from "./brand-mark";
import { PAPER_STATUSES, STATUS_CHIP_SPECS } from "./status";
import { WORDMARK } from "./wordmark";

const here = dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(join(here, "..", "..", "styles", "tokens.css"), "utf8");

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type AnyElement = ReactElement<Record<string, unknown>>;

/**
 * A node's children as a flat list, without `Children.toArray`: that clones
 * every element (to add keys), and these tests compare elements by identity.
 */
function flatChildren(children: ReactNode): ReactNode[] {
  if (Array.isArray(children)) {
    return children.flatMap(flatChildren);
  }
  return children === null || children === undefined || typeof children === "boolean" ? [] : [children];
}

/** Every element in the tree, parents before children. */
function elementsOf(node: ReactNode): AnyElement[] {
  if (!isValidElement(node)) {
    return [];
  }
  const element = node as AnyElement;
  return [
    element,
    ...flatChildren(element.props.children as ReactNode).flatMap(elementsOf),
  ];
}

/** The element's text, children concatenated. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!isValidElement(node)) {
    return "";
  }
  return flatChildren((node as AnyElement).props.children as ReactNode)
    .map(textOf)
    .join("");
}

const styleOf = (element: AnyElement) => (element.props.style ?? {}) as Record<string, unknown>;

/** The first `div` whose own text is exactly `text`. */
function textBox(tree: ReactNode, text: string): AnyElement {
  const found = elementsOf(tree).find(
    (element) =>
      element.type === "div" &&
      flatChildren(element.props.children as ReactNode).every((child) => typeof child === "string") &&
      textOf(element) === text,
  );
  if (found === undefined) {
    throw new Error(`no text box reading ${JSON.stringify(text)}`);
  }
  return found;
}

const svgsOf = (tree: ReactNode) => elementsOf(tree).filter((element) => element.type === "svg");

/** The paths inside the tree that draw the outlined wordmark: `d` is `WORDMARK.path`. */
const wordmarkPathsOf = (tree: ReactNode) =>
  elementsOf(tree).filter((element) => element.type === "path" && element.props.d === WORDMARK.path);

/** The svg elements that hold a wordmark path. */
const wordmarkSvgsOf = (tree: ReactNode) =>
  svgsOf(tree).filter((svg) => wordmarkPathsOf(svg).length > 0);

/** The lockup's own box: the div whose children are the glyph svg and the wordmark svg. */
function lockupOf(tree: ReactNode): AnyElement {
  const found = elementsOf(tree).find(
    (element) =>
      element.type === "div" &&
      flatChildren(element.props.children as ReactNode).filter(
        (child) => isValidElement(child) && child.type === "svg",
      ).length === 2,
  );
  if (found === undefined) {
    throw new Error("no lockup in the tree");
  }
  return found;
}

/** Every colour written anywhere in the tree: style values and SVG paint attributes. */
function coloursIn(tree: ReactNode): string[] {
  const found: string[] = [];
  const scan = (value: unknown) => {
    if (typeof value === "string") {
      found.push(...(value.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(|var\(/g) ?? []));
    }
  };
  for (const element of elementsOf(tree)) {
    Object.values(styleOf(element)).forEach(scan);
    scan(element.props.fill);
    scan(element.props.stroke);
  }
  return found;
}

const PALETTE_VALUES = new Set(Object.values(BRAND_CARD_PALETTE).map((value) => value.toUpperCase()));

const PAPER: PaperCardProps = {
  kind: "paper",
  title: "Scalable verification of signed preprints with append-only logs",
  authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
  moreAuthors: 2,
  schId: "sch:k3f9-q2xz-7mwd",
  status: "under_review",
};

const paperTree = (overrides: Partial<PaperCardProps> = {}) => BrandCard({ ...PAPER, ...overrides }) as AnyElement;

/** `{width, height}` of a PNG, read from its IHDR chunk, after checking the signature. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const bytesOf = async (response: Response) => Buffer.from(await response.arrayBuffer());

/* -------------------------------------------------------------------------- */
/* The palette                                                                 */
/* -------------------------------------------------------------------------- */

describe("BRAND_CARD_PALETTE", () => {
  const TOKENS: Readonly<Record<keyof typeof BRAND_CARD_PALETTE, string>> = {
    paper: "bg",
    surface: "surface",
    ink: "ink",
    ink2: "ink-2",
    rule: "rule",
    accent: "accent",
    verified: "verified",
    pending: "pending",
    critical: "critical",
    marginNote: "margin-note",
    verifiedSoft: "verified-soft",
    pendingSoft: "pending-soft",
    criticalSoft: "critical-soft",
  };

  it("is the light-theme value of each token in tokens.css", () => {
    for (const [key, token] of Object.entries(TOKENS)) {
      // The first declaration of a token is the light `:root` one; dark overrides come later.
      const declared = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`).exec(tokensCss)?.[1];
      expect(declared, `--${token} in tokens.css`).toBeDefined();
      expect(BRAND_CARD_PALETTE[key as keyof typeof BRAND_CARD_PALETTE].toLowerCase(), key).toBe(
        declared?.toLowerCase(),
      );
    }
  });

  it("has the paper background the brand spec names", () => {
    expect(BRAND_CARD_PALETTE.paper).toBe("#FBFAF7");
  });

  it("leaves out the AI colour: nothing on a card is AI output", () => {
    const ai = /--ai:\s*(#[0-9a-fA-F]{6})/.exec(tokensCss)?.[1]?.toUpperCase();
    expect(ai).toBeDefined();
    expect(PALETTE_VALUES.has(ai ?? "")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The site card                                                               */
/* -------------------------------------------------------------------------- */

describe("the site card", () => {
  const tree = BrandCard(SITE_CARD);

  it("is 1200 × 630 on the paper background", () => {
    expect(BRAND_CARD_SIZE).toEqual({ width: 1200, height: 630 });
    expect(styleOf(tree as AnyElement)).toMatchObject({
      width: 1200,
      height: 630,
      backgroundColor: "#FBFAF7",
    });
  });

  it("centres the lockup and tagline", () => {
    expect(styleOf(tree as AnyElement)).toMatchObject({
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    });
  });

  it("shows the glyph mark and the outlined wordmark, as two svgs", () => {
    const svgs = svgsOf(tree);
    expect(svgs).toHaveLength(2);
    const [glyph, wordmark] = svgs;
    expect(glyph.props.viewBox).toBe("0 0 52 54");
    expect(glyph.props.height).toBe(SITE_MARK_HEIGHT);
    expect(wordmarkSvgsOf(tree)).toEqual([wordmark]);
    expect(wordmark.props.height).toBe(SITE_MARK_HEIGHT);
  });

  it("draws the wordmark in ink and types nothing in the serif face", () => {
    const [path] = wordmarkPathsOf(tree);
    expect(path.props.fill).toBe(BRAND_CARD_PALETTE.ink);
    expect(elementsOf(tree).filter((element) => styleOf(element).fontFamily === BRAND_CARD_FONTS.serif)).toEqual([]);
  });

  it("carries the tagline under the lockup", () => {
    expect(BRAND_CARD_TAGLINE).toBe("Signed, open preprints and peer review");
    const tagline = textBox(tree, BRAND_CARD_TAGLINE);
    expect(styleOf(tagline)).toMatchObject({
      fontFamily: BRAND_CARD_FONTS.sans,
      color: BRAND_CARD_PALETTE.ink2,
    });
    const all = elementsOf(tree);
    expect(all.indexOf(tagline)).toBeGreaterThan(all.indexOf(wordmarkSvgsOf(tree)[0]));
  });

  it("names a paper nowhere, and has no text but the tagline", () => {
    expect(textOf(tree)).toBe(BRAND_CARD_TAGLINE);
  });

  it("describes itself in its alt text, which still names the wordmark's word", () => {
    expect(BRAND_CARD_WORDMARK).toBe("scholium");
    expect(BRAND_CARD_ALT).toBe(`scholium: ${BRAND_CARD_TAGLINE}`);
    expect(BRAND_CARD_ALT).toContain(BRAND_CARD_TAGLINE);
  });
});

/* -------------------------------------------------------------------------- */
/* The outlined wordmark                                                       */
/* -------------------------------------------------------------------------- */

describe("the outlined wordmark", () => {
  const CARDS: [string, BrandCardProps, number][] = [
    ["site", SITE_CARD, SITE_MARK_HEIGHT],
    ["paper", PAPER, CORNER_MARK_HEIGHT],
  ];

  it("is the lockup drawing's own geometry: 220.95 × 54 from the pen origin, a gap of 14.04 after the glyph", () => {
    expect(WORDMARK.viewBox[3]).toBe(54);
    expect(WORDMARK.viewBox[2] - WORDMARK.penOriginX).toBeCloseTo(220.95, 5);
    // The gap is the pen origin less the glyph's 52 grid units: 0.26 of the lockup's 54.
    expect((WORDMARK.penOriginX - 52) / 54).toBeCloseTo(0.26, 5);
  });

  describe.each(CARDS)("on the %s card", (_name, props, markHeight) => {
    const tree = BrandCard(props);
    const lockup = lockupOf(tree);
    const [glyph, wordmark] = flatChildren(lockup.props.children as ReactNode) as AnyElement[];

    it("is one path whose d is WORDMARK.path, in the resolved ink colour", () => {
      const paths = elementsOf(wordmark).slice(1);
      expect(paths).toHaveLength(1);
      expect(paths[0].type).toBe("path");
      expect(paths[0].props.d).toBe(WORDMARK.path);
      expect(paths[0].props.fill).toBe(BRAND_CARD_PALETTE.ink);
      expect(wordmarkPathsOf(tree)).toHaveLength(1);
    });

    it("comes after the glyph, as the lockup's last child", () => {
      expect(glyph.props.viewBox).toBe("0 0 52 54");
      expect(wordmark.type).toBe("svg");
      expect(flatChildren(lockup.props.children as ReactNode)).toHaveLength(2);
    });

    it("is at the glyph's scale: one grid unit is markHeight / 54, so it is 220.95 / 54 × markHeight wide", () => {
      expect(glyph.props.height).toBe(markHeight);
      expect(wordmark.props.height).toBe(markHeight);
      expect(wordmark.props.width as number).toBeCloseTo((220.95 / 54) * markHeight, 6);
      // The view box starts at the pen origin, so the path lands where the lockup drawing puts it.
      expect(wordmark.props.viewBox).toBe("66.04 0 220.95 54");
      // Box and view box have the same aspect: nothing is stretched.
      expect((wordmark.props.width as number) / (wordmark.props.height as number)).toBeCloseTo(220.95 / 54, 6);
    });

    it("is placed 0.26 × markHeight after the glyph, with the top edges aligned", () => {
      expect(styleOf(lockup)).toMatchObject({ display: "flex", alignItems: "flex-start" });
      expect(styleOf(lockup).flexDirection).toBeUndefined();
      expect(styleOf(lockup).gap as number).toBeCloseTo(0.26 * markHeight, 6);
      expect(styleOf(lockup).gap).toBe(lockupLayout(markHeight).gap);
    });

    it("is not typed: no text and no font anywhere in the lockup", () => {
      expect(textOf(lockup)).toBe("");
      expect(elementsOf(lockup).filter((element) => styleOf(element).fontFamily !== undefined)).toEqual([]);
      expect(textOf(tree)).not.toContain(BRAND_CARD_WORDMARK);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The paper card                                                              */
/* -------------------------------------------------------------------------- */

describe("the paper card", () => {
  it("is 1200 × 630 on the paper background, padded on the 4 px grid", () => {
    expect(styleOf(paperTree())).toMatchObject({
      width: 1200,
      height: 630,
      backgroundColor: "#FBFAF7",
      padding: CARD_PADDING,
    });
    expect(CARD_PADDING % 4).toBe(0);
  });

  describe("title", () => {
    it("is set in the serif face, semibold, in ink", () => {
      const title = textBox(paperTree(), PAPER.title);
      expect(styleOf(title)).toMatchObject({
        fontFamily: BRAND_CARD_FONTS.serif,
        fontWeight: 600,
        color: BRAND_CARD_PALETTE.ink,
      });
    });

    it("is clamped to three lines", () => {
      expect(TITLE_LINE_CLAMP).toBe(3);
      const title = textBox(paperTree({ title: "x ".repeat(400) }), "x ".repeat(400));
      expect(styleOf(title).lineClamp).toBe(3);
    });

    it("is a block, because Satori only clamps lines in a block", () => {
      // Found by rendering: as `display: flex` the clamp is ignored and a long
      // title takes five lines and pushes the byline onto the footer.
      expect(styleOf(textBox(paperTree(), PAPER.title)).display).toBe("block");
    });

    it("steps down in size as the title gets longer, and never grows", () => {
      const lengths = [1, 30, 60, 61, 100, 101, 130, 131, 300];
      const sizes = lengths.map((length) => titleLayout("x".repeat(length)).fontSize);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
      expect(new Set(sizes).size).toBeGreaterThan(2);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(40);
    });

    it("uses the layout's size, line height and clamp", () => {
      const layout = titleLayout(PAPER.title);
      expect(styleOf(textBox(paperTree(), PAPER.title))).toMatchObject({
        fontSize: layout.fontSize,
        lineHeight: layout.lineHeight,
        lineClamp: layout.lineClamp,
      });
    });

    it("leaves room for three title lines and a two-line byline above the footer at every size", () => {
      // The card's content box is 630 − 2 × 64 = 502 px tall. The rows that
      // are not the title or byline take at most 202 px: the status chip 58,
      // the gaps above the title (40) and byline (28), and the footer, which
      // is 74 now that the lockup is just the glyph's 44 px tall (28 padding,
      // 2 rule, 44) and was measured at 76 when the wordmark was a text line.
      const room = BRAND_CARD_SIZE.height - 2 * CARD_PADDING - 202;
      const bylineHeight = 30 * 1.35 * AUTHOR_LINE_CLAMP;
      for (const length of [1, 60, 61, 100, 101, 130, 131, 300]) {
        const { fontSize, lineHeight, lineClamp } = titleLayout("x".repeat(length));
        expect(fontSize * lineHeight * lineClamp + bylineHeight, `${length} chars`).toBeLessThanOrEqual(room);
      }
    });
  });

  describe("authors", () => {
    it("names the first three, in order, and counts the rest", () => {
      const names = ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Katherine Johnson", "Margaret Hamilton"];
      const card = brandCardFor({
        title: PAPER.title,
        shortId: PAPER.schId,
        status: "preprint",
        authors: names.map((name) => ({ name })),
      }) as PaperCardProps;
      expect(MAX_AUTHORS).toBe(3);
      expect(card.authors).toEqual(names.slice(0, 3));
      expect(card.moreAuthors).toBe(2);
      expect(textOf(BrandCard(card))).toContain("Ada Lovelace, Alan Turing, Grace Hopper and 2 more");
      expect(textOf(BrandCard(card))).not.toContain("Katherine");
    });

    it("never prints more than three names, even if given more", () => {
      const tree = paperTree({ authors: ["A", "B", "C", "D", "E"], moreAuthors: 0 });
      expect(textOf(tree)).toContain("A, B, C");
      expect(textOf(tree)).not.toMatch(/\bD\b/);
    });

    it("is secondary text in the sans face, wrapping to two lines at most", () => {
      const byline = textBox(paperTree(), "Ada Lovelace, Alan Turing, Grace Hopper and 2 more");
      expect(styleOf(byline)).toMatchObject({
        fontFamily: BRAND_CARD_FONTS.sans,
        color: BRAND_CARD_PALETTE.ink2,
        lineClamp: AUTHOR_LINE_CLAMP,
        display: "block",
      });
    });

    it("is left out when there is nobody to name", () => {
      const tree = paperTree({ authors: [], moreAuthors: 0 });
      expect(elementsOf(tree).filter((element) => styleOf(element).lineClamp === AUTHOR_LINE_CLAMP)).toHaveLength(0);
    });

    it.each([
      [[], 0, ""],
      [[], 1, "1 author"],
      [[], 4, "4 authors"],
      [["Ada Lovelace"], 0, "Ada Lovelace"],
      [["Ada Lovelace", "Alan Turing"], 0, "Ada Lovelace, Alan Turing"],
      [["Ada Lovelace", "Alan Turing", "Grace Hopper"], 1, "Ada Lovelace, Alan Turing, Grace Hopper and 1 more"],
      [["A", "B", "C", "D"], 0, "A, B, C"],
      [["Ada Lovelace"], -3, "Ada Lovelace"],
      [["Ada Lovelace"], 1.9, "Ada Lovelace and 1 more"],
    ] as const)("writes the byline for %j + %i more as %j", (authors, more, expected) => {
      expect(bylineText(authors, more)).toBe(expected);
    });
  });

  describe("sch: id", () => {
    it("is in the monospace face", () => {
      const id = textBox(paperTree(), "sch:k3f9-q2xz-7mwd");
      expect(styleOf(id)).toMatchObject({
        fontFamily: BRAND_CARD_FONTS.mono,
        color: BRAND_CARD_PALETTE.ink,
      });
    });
  });

  describe("status", () => {
    it.each(PAPER_STATUSES)("shows the word for %s with an icon of its own, colour on icon and edge only", (status) => {
      const tree = paperTree({ status });
      const { label, tone } = STATUS_CHIP_SPECS[status];
      const word = textBox(tree, label);
      // The word stays in ink for contrast; the tone colours the icon and the chip's edge.
      expect(styleOf(word).color).toBe(BRAND_CARD_PALETTE.ink);
      const chip = elementsOf(tree).find((element) => element.props.style && String(styleOf(element).border ?? "").includes("2px solid") && elementsOf(element).includes(word));
      expect(chip, "chip").toBeDefined();
      const icon = svgsOf(chip)[0];
      expect(icon.props.viewBox).toBe("0 0 16 16");
      expect(icon.props.stroke).toBe(
        { neutral: BRAND_CARD_PALETTE.ink2, verified: BRAND_CARD_PALETTE.verified, pending: BRAND_CARD_PALETTE.pending, critical: BRAND_CARD_PALETTE.critical }[tone],
      );
    });

    it("gives every status a different icon silhouette, as the chips do", () => {
      const silhouettes = PAPER_STATUSES.map((status) =>
        JSON.stringify(elementsOf(svgsOf(paperTree({ status }))[0]).slice(1).map((shape) => [shape.type, shape.props.d ?? [shape.props.cx, shape.props.r]])),
      );
      expect(new Set(silhouettes).size).toBe(PAPER_STATUSES.length);
    });

    it("says an unknown status in neutral colours, in its own words", () => {
      expect(statusWord("in_embargo")).toEqual({ label: "In embargo", tone: "neutral", icon: "circle" });
      expect(statusWord("UNDER-REVIEW?")).toMatchObject({ tone: "neutral" });
    });

    it("says 'Listed' if an unknown status cannot be drawn", () => {
      expect(statusWord("статус")).toEqual({ label: "Listed", tone: "neutral", icon: "circle" });
      expect(statusWord("")).toMatchObject({ label: "Listed" });
    });
  });

  describe("lockup", () => {
    it("is small, and sits last in the footer row: the bottom-right corner", () => {
      const tree = paperTree();
      const footer = elementsOf(tree).find((element) => String(styleOf(element).borderTop ?? "").includes(BRAND_CARD_PALETTE.rule));
      expect(footer, "footer").toBeDefined();
      expect(styleOf(footer as AnyElement)).toMatchObject({
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      });
      expect(styleOf(footer as AnyElement).flexDirection, "a row").toBeUndefined();
      const [idBox, lockup] = flatChildren((footer as AnyElement).props.children as ReactNode) as AnyElement[];
      expect(textOf(idBox)).toBe(PAPER.schId);
      expect(svgsOf(lockup)[0].props.height).toBe(CORNER_MARK_HEIGHT);
      expect(wordmarkSvgsOf(lockup)).toHaveLength(1);
      expect(textOf(lockup)).toBe("");
      expect(CORNER_MARK_HEIGHT).toBeLessThan(SITE_MARK_HEIGHT / 2);
    });

    it("draws the wordmark as the outlined path in ink: no text node 'scholium', and no serif face in the footer", () => {
      const tree = paperTree();
      const [path] = wordmarkPathsOf(tree);
      expect(path.props.fill).toBe(BRAND_CARD_PALETTE.ink);
      expect(
        elementsOf(tree).filter((element) => element.type === "div" && textOf(element) === BRAND_CARD_WORDMARK),
      ).toEqual([]);
      // Source Serif 4 is the title's face and nothing else's.
      const serif = elementsOf(tree).filter((element) => styleOf(element).fontFamily === BRAND_CARD_FONTS.serif);
      expect(serif.map(textOf)).toEqual([PAPER.title]);
    });

    it("keeps the mark, wordmark and gap in proportion at every size", () => {
      for (const height of [CORNER_MARK_HEIGHT, SITE_MARK_HEIGHT]) {
        const layout = lockupLayout(height);
        expect(layout.markWidth / layout.markHeight).toBeCloseTo(52 / 54, 1);
        expect(layout.wordmarkWidth / height).toBeCloseTo(220.95 / 54, 6);
        expect(layout.gap / height).toBeCloseTo(0.26, 6);
        // The lockup is one drawing: 287 × 54 grid units, aspect 5.31.
        expect((layout.markWidth + layout.gap + layout.wordmarkWidth) / height).toBeCloseTo(287 / 54, 1);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The brand glyph                                                             */
/* -------------------------------------------------------------------------- */

describe("the glyph mark", () => {
  const GEOMETRY_KEYS = ["x", "y", "width", "height", "rx", "d"];

  const fromCard = () =>
    elementsOf(svgsOf(BrandCard(SITE_CARD))[0])
      .slice(1)
      .map((shape) => [shape.type, Object.fromEntries(GEOMETRY_KEYS.flatMap((key) => (shape.props[key] === undefined ? [] : [[key, String(shape.props[key])]])))]);

  const fromBrandMark = () => {
    const markup = renderToStaticMarkup(createElement(BrandMark, { variant: "glyph" }));
    return [...markup.matchAll(/<(rect|path)\b([^>]*?)\/?>/g)].map(([, type, attributes]) => [
      type,
      Object.fromEntries(
        GEOMETRY_KEYS.flatMap((key) => {
          const value = new RegExp(`(?:^|\\s)${key}="([^"]*)"`).exec(attributes)?.[1];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
    ]);
  };

  it("has the geometry of BrandMark's glyph variant, shape for shape", () => {
    expect(fromCard()).toHaveLength(8);
    expect(fromCard()).toEqual(fromBrandMark());
  });

  it("is painted in accent, paper and margin-note only", () => {
    const paints = elementsOf(svgsOf(BrandCard(SITE_CARD))[0])
      .slice(1)
      .map((shape) => shape.props.fill);
    expect(new Set(paints)).toEqual(
      new Set([BRAND_CARD_PALETTE.accent, BRAND_CARD_PALETTE.paper, BRAND_CARD_PALETTE.marginNote]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The fonts' README                                                           */
/* -------------------------------------------------------------------------- */

describe("og-fonts/README.md", () => {
  const readme = readFileSync(join(here, "og-fonts", "README.md"), "utf8");
  const serifRow = readme.split("\n").find((line) => line.startsWith("|") && line.includes("`source-serif-4-semibold.woff`"));

  it("lists the paper title as the use of source-serif-4-semibold.woff", () => {
    expect(serifRow).toBeDefined();
    expect(serifRow).toContain("paper title");
  });

  it("no longer lists the wordmark as a use of it: the wordmark is a path", () => {
    expect(serifRow?.toLowerCase()).not.toContain("wordmark");
  });
});

/* -------------------------------------------------------------------------- */
/* Palette and Satori rules, across every card                                 */
/* -------------------------------------------------------------------------- */

const EVERY_CARD: [string, BrandCardProps][] = [
  ["site", SITE_CARD],
  ...PAPER_STATUSES.map((status): [string, BrandCardProps] => [`paper (${status})`, { ...PAPER, status }]),
  ["paper (unknown status)", { ...PAPER, status: "in_embargo" }],
  ["paper (no authors)", { ...PAPER, authors: [], moreAuthors: 0 }],
  ["paper (long title)", { ...PAPER, title: "word ".repeat(100).trim() }],
];

describe.each(EVERY_CARD)("the %s card", (_name, props) => {
  const tree = BrandCard(props);

  it("uses the brand palette only", () => {
    const colours = coloursIn(tree);
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      expect(colour.startsWith("#"), `${colour} is not a hex literal from the palette`).toBe(true);
      expect(PALETTE_VALUES.has(colour.toUpperCase()), `${colour} is in the palette`).toBe(true);
    }
  });

  it("follows Satori's rules: multi-child divs are flex, text is one string, no classes or images", () => {
    for (const element of elementsOf(tree)) {
      const children = flatChildren(element.props.children as ReactNode);
      if (element.type === "div" && children.length > 1) {
        expect(styleOf(element).display, "a div with several children").toBe("flex");
      }
      if (element.type === "div" && children.some((child) => typeof child === "string")) {
        expect(children, "text sits alone in its box").toHaveLength(1);
      }
      expect(element.props.className, "className").toBeUndefined();
      expect(element.type, "tag").not.toBe("img");
      expect(["div", "svg", "rect", "path", "circle"]).toContain(element.type);
    }
  });

  it("is a 1200 × 630 paper-coloured box", () => {
    expect(styleOf(tree as AnyElement)).toMatchObject({ width: 1200, height: 630, backgroundColor: "#FBFAF7" });
  });

  it("draws the wordmark once, as the outlined path, and never as a text node 'scholium'", () => {
    expect(wordmarkPathsOf(tree)).toHaveLength(1);
    expect(wordmarkSvgsOf(tree)).toHaveLength(1);
    expect(textOf(tree).toLowerCase()).not.toContain(BRAND_CARD_WORDMARK);
    expect(
      elementsOf(tree).filter((element) => flatChildren(element.props.children as ReactNode).includes(BRAND_CARD_WORDMARK)),
    ).toEqual([]);
  });

  it("names every font family it asks for", () => {
    const families = new Set<string>(Object.values(BRAND_CARD_FONTS));
    for (const element of elementsOf(tree)) {
      const family = styleOf(element).fontFamily;
      if (family !== undefined) {
        expect(families.has(String(family)), `${String(family)} is a bundled family`).toBe(true);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Text the bundled fonts can draw                                             */
/* -------------------------------------------------------------------------- */

describe("drawableText", () => {
  it.each([
    ["Plain ASCII, with punctuation: (1) 'two' & more.", "Plain ASCII, with punctuation: (1) 'two' & more."],
    ["Typographic ‘quotes’, “double”, an en–dash, an em—dash… and a bullet •", "Typographic ‘quotes’, “double”, an en–dash, an em—dash… and a bullet •"],
    ["Latin-1: Müller, Brontë, Ångström, Ærø, façade, ß, ñ, ½, ×, €, ™", "Latin-1: Müller, Brontë, Ångström, Ærø, façade, ß, ñ, ½, ×, €, ™"],
    ["  collapses \t\n  whitespace  ", "collapses whitespace"],
    ["no break and thin", "no break and thin"],
  ])("keeps %j", (input, expected) => {
    expect(drawableText(input)).toBe(expected);
  });

  it.each([
    ["Dvořák", "Dvorák"], // ř folds; á is Latin-1 and stays
    ["Łukasz Kowalski", "Lukasz Kowalski"],
    ["Łódź", "Lódz"], // Ł and ź fold; ó stays
    ["Đorđe", "Dorde"],
    ["Erdős", "Erdos"],
    ["İstanbul Şişli", "Istanbul Sisli"],
    ["Dvor\u030Cák", "Dvorák"], // decomposed input (r + combining caron) folds the same way
    ["ﬁnite ﬂow", "finite flow"],
    ["well‐known", "well-known"],
  ])("folds %j to %j", (input, expected) => {
    expect(drawableText(input)).toBe(expected);
  });

  it("drops invisible control and format characters", () => {
    expect(drawableText("zero​width‍ joiner­soft hyphen‮and bidi\u0007bell")).toBe(
      "zerowidth joinersoft hyphenand bidibell",
    );
  });

  it.each([
    ["Greek", "Measuring α in plasmas"],
    ["Cyrillic", "Теория относительности"],
    ["CJK", "量子计算"],
    ["Arabic", "مرحبا"],
    ["emoji", "Reading rooms 😀"],
    ["an arrow the fonts lack", "A → B"],
    ["a math symbol the fonts lack", "x ≤ y"],
    ["a lone surrogate", "broken \ud83d text"],
    ["only invisible characters", "​‍ "],
    ["nothing", ""],
  ])("gives up on %s", (_label, input) => {
    expect(drawableText(input)).toBeNull();
  });

  it("caps by code points, not UTF-16 units, so a cut never splits a pair", () => {
    expect(drawableText("é".repeat(500), 10)).toBe("é".repeat(10));
    // 😀 is outside the fonts, so any of it makes the text undrawable, but the cut itself must not throw.
    expect(drawableText("a".repeat(9) + "😀😀😀", 10)).toBeNull();
    expect(drawableText("a".repeat(10) + "😀😀😀", 10)).toBe("a".repeat(10));
  });
});

/* -------------------------------------------------------------------------- */
/* Building a card from a paper                                                */
/* -------------------------------------------------------------------------- */

describe("brandCardFor", () => {
  const source: PaperCardSource = {
    title: "Scalable verification of signed preprints",
    shortId: "sch:k3f9-q2xz-7mwd",
    status: "reviewed",
    authors: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }],
  };

  it("builds the paper card from a loaded paper", () => {
    expect(brandCardFor(source)).toEqual({
      kind: "paper",
      title: "Scalable verification of signed preprints",
      authors: ["Ada Lovelace", "Alan Turing"],
      moreAuthors: 0,
      schId: "sch:k3f9-q2xz-7mwd",
      status: "reviewed",
    });
  });

  it.each([null, undefined])("falls back to the site card for %s: a paper that is missing, unlisted or unreadable", (nothing) => {
    expect(brandCardFor(nothing)).toBe(SITE_CARD);
  });

  it("skips authors with no public name, counting them as 'more'", () => {
    const card = brandCardFor({
      ...source,
      authors: [{ name: null }, { name: "Ada Lovelace" }, { name: null }, { name: "Alan Turing" }, { name: "Grace Hopper" }, { name: "Katherine Johnson" }],
    }) as PaperCardProps;
    expect(card.authors).toEqual(["Ada Lovelace", "Alan Turing", "Grace Hopper"]);
    expect(card.moreAuthors).toBe(3);
  });

  it("says 'N authors' when none has a public name", () => {
    const card = brandCardFor({ ...source, authors: [{ name: null }, { name: null }] }) as PaperCardProps;
    expect(card.authors).toEqual([]);
    expect(bylineText(card.authors, card.moreAuthors)).toBe("2 authors");
  });

  it("folds names and leaves out names it cannot draw, counting them", () => {
    const card = brandCardFor({
      ...source,
      authors: [{ name: "Antonín Dvořák" }, { name: "李雷" }, { name: "Łukasz Kowalski" }],
    }) as PaperCardProps;
    expect(card.authors).toEqual(["Antonín Dvorák", "Lukasz Kowalski"]);
    expect(card.moreAuthors).toBe(1);
  });

  it.each([
    ["a title the fonts cannot draw", { title: "Measuring α in plasmas" }],
    ["an emoji title", { title: "Reading rooms 😀" }],
    ["an empty title", { title: "   " }],
    ["a missing id", { shortId: "" }],
    ["a record cid instead of a sch: id", { shortId: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }],
    ["a malformed sch: id", { shortId: "sch:k3f9-q2xz" }],
    ["an id with something after it", { shortId: "sch:k3f9-q2xz-7mwd\nsecret" }],
  ])("falls back to the site card for %s", (_label, change) => {
    expect(brandCardFor({ ...source, ...change })).toBe(SITE_CARD);
  });

  it("accepts an id in capitals and with stray spaces, and prints it trimmed", () => {
    expect((brandCardFor({ ...source, shortId: "  sch:K3F9-Q2XZ-7MWD " }) as PaperCardProps).schId).toBe("sch:K3F9-Q2XZ-7MWD");
  });

  it("does not let a hostile title or name make layout expensive", () => {
    const card = brandCardFor({ ...source, title: "w".repeat(100_000), authors: [{ name: "n".repeat(100_000) }] }) as PaperCardProps;
    expect([...card.title]).toHaveLength(300);
    expect([...card.authors[0]]).toHaveLength(100);
  });

  it("puts no part of an undrawable paper on the site card", () => {
    const card = brandCardFor({ ...source, title: "Secret: Тайна", authors: [{ name: "Ada Lovelace" }] });
    expect(JSON.stringify(card)).toBe(JSON.stringify(SITE_CARD));
  });
});

describe("drawableCard", () => {
  it("leaves the site card alone", () => {
    expect(drawableCard(SITE_CARD)).toBe(SITE_CARD);
  });

  it("is idempotent", () => {
    const once = drawableCard({ ...PAPER, title: "Dvořák  note", authors: ["Łukasz", "李雷", "Ada"], moreAuthors: 1 });
    expect(drawableCard(once)).toEqual(once);
  });

  it("re-checks a hand-built card, so nothing undrawable reaches the renderer", () => {
    expect(drawableCard({ ...PAPER, title: "α" })).toBe(SITE_CARD);
    expect(drawableCard({ ...PAPER, schId: "not an id" })).toBe(SITE_CARD);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe("renderBrandCard", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** The URL a `fetch` call asked for, whatever form its first argument took. */
  const requestedUrl = (input: unknown): string =>
    input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);

  /** Fetches that would have left the process: anything but an inline `data:` URL. */
  const networkFetches = () =>
    fetchSpy.mock.calls.map(([input]) => requestedUrl(input)).filter((url) => !url.startsWith("data:"));

  beforeEach(() => {
    // `next/og` would fetch a font or emoji from a third party for any glyph
    // the bundled fonts lack. Nothing here may reach the network. Its layout
    // engine loads the WebAssembly bundled inside it from a `data:` URL; that
    // never leaves the process, so it goes to the real fetch.
    const realFetch = globalThis.fetch;
    fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      requestedUrl(input).startsWith("data:")
        ? realFetch(input, init)
        : Promise.reject(new Error("no network in card tests")),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the site card as a 1200 × 630 image/png", async () => {
    const response = await renderBrandCard(SITE_CARD);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(pngSize(await bytesOf(response))).toEqual({ width: 1200, height: 630 });
    expect(networkFetches()).toEqual([]);
  }, 30_000);

  it("serves a paper card as a 1200 × 630 image/png that differs from the site card", async () => {
    const paper = await bytesOf(await renderBrandCard(PAPER));
    const site = await bytesOf(await renderBrandCard(SITE_CARD));
    expect(pngSize(paper)).toEqual({ width: 1200, height: 630 });
    expect(paper.equals(site)).toBe(false);
    expect(networkFetches()).toEqual([]);
  }, 30_000);

  it("lets the caller replace next/og's one-year immutable cache header", async () => {
    const response = await renderBrandCard(SITE_CARD, { headers: { "cache-control": "public, max-age=60" } });
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("content-type")).toBe("image/png");
    await response.arrayBuffer();
  }, 30_000);

  it("draws every status, a three-line title and the folded names without asking a third party for anything", async () => {
    const cards: BrandCardProps[] = [
      ...PAPER_STATUSES.map((status): BrandCardProps => ({ ...PAPER, status })),
      { ...PAPER, status: "in_embargo" },
      { ...PAPER, title: "Dvořák’s “Łódz” études — a Münster note ©®™ ↑↓ • …", authors: ["Antonín Dvořák", "李雷", "Łukasz"] },
      { ...PAPER, title: "word ".repeat(120).trim(), authors: [], moreAuthors: 7 },
    ];
    for (const card of cards) {
      const bytes = await bytesOf(await renderBrandCard(card));
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    }
    expect(networkFetches()).toEqual([]);
  }, 60_000);

  it("renders the site card, byte for byte, for any paper it cannot draw", async () => {
    const site = await bytesOf(await renderBrandCard(SITE_CARD));
    for (const title of ["Measuring α in plasmas", "Reading rooms 😀", "Теория", "量子"]) {
      const bytes = await bytesOf(await renderBrandCard({ ...PAPER, title }));
      expect(bytes.equals(site), title).toBe(true);
    }
    expect(networkFetches()).toEqual([]);
  }, 60_000);

  it("reads its fonts from disk once and remembers them", async () => {
    const { loadBrandCardFonts } = await import("./brand-card");
    const fonts = await loadBrandCardFonts();
    expect(fonts.map((font) => [font.name, font.weight])).toEqual([
      [BRAND_CARD_FONTS.serif, 600],
      [BRAND_CARD_FONTS.sans, 400],
      [BRAND_CARD_FONTS.sans, 500],
      [BRAND_CARD_FONTS.mono, 500],
    ]);
    for (const font of fonts) {
      expect(font.data.byteLength).toBeGreaterThan(10_000);
      // WOFF, the format Satori reads (it cannot read WOFF2).
      expect(Buffer.from(font.data as ArrayBuffer).subarray(0, 4).toString("latin1")).toBe("wOFF");
    }
    expect(await loadBrandCardFonts()).toBe(fonts);
  });
});

/* -------------------------------------------------------------------------- */
/* The routes                                                                  */
/* -------------------------------------------------------------------------- */

describe("/opengraph-image and /twitter-image", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("export Next's image metadata: 1200 × 630, image/png, with alt text", () => {
    for (const [alt, size, contentType] of [
      [siteAlt, siteSize, siteContentType],
      [twitterAlt, twitterSize, twitterContentType],
    ] as const) {
      expect(size).toEqual({ width: 1200, height: 630 });
      expect(contentType).toBe("image/png");
      expect(alt).toBe(BRAND_CARD_ALT);
    }
  });

  it("serve the site card with HTTP 200 and content-type image/png", async () => {
    const site = await siteCardRoute();
    const twitter = await twitterCardRoute();
    for (const response of [site, twitter]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      // Not next/og's one-year `immutable`: see SITE_CARD_CACHE_CONTROL.
      expect(response.headers.get("cache-control")).toBe(SITE_CARD_CACHE_CONTROL);
    }
    const siteBytes = await bytesOf(site);
    expect(pngSize(siteBytes)).toEqual({ width: 1200, height: 630 });
    expect((await bytesOf(twitter)).equals(siteBytes)).toBe(true);
    expect(siteBytes.equals(await bytesOf(await renderBrandCard(SITE_CARD)))).toBe(true);
  }, 30_000);
});

describe("/p/[id]/opengraph-image", () => {
  const LISTED = "sch:k3f9-q2xz-7mwd";
  const UNLISTED = "sch:unli-sted-0004";
  const NAMES: Record<string, string> = {
    "did:key:a": "Ada Lovelace",
    "did:key:b": "Alan Turing",
    "did:key:c": "Grace Hopper",
    "did:key:d": "Katherine Johnson",
    "did:key:e": "Margaret Hamilton",
  };

  /** Requests the stub saw, as `[path, headers]`. */
  let requests: { path: string; headers: Headers; init: RequestInit | undefined }[];
  let fetchStub: ReturnType<typeof vi.fn>;

  function json(body: unknown, status = 200, type = "application/json") {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
  }

  const paperBody = (overrides: Record<string, unknown> = {}) => ({
    shortId: LISTED,
    paperCid: "bafyPAPER",
    versionCid: "bafyVERSION",
    n: 2,
    title: "Scalable verification of signed preprints with append-only logs",
    abstract: "",
    status: "under_review",
    authors: Object.keys(NAMES).map((did, index) => ({ did, position: index + 1, creditRoles: [] })),
    categories: [],
    licence: "CC-BY-4.0",
    notices: [],
    ...overrides,
  });

  /**
   * A node whose public catalog lists `LISTED` and nothing else. Its answer to
   * a request carrying a bearer token is *different*: it would also hand over
   * the unlisted paper, which is what a leak would look like.
   */
  function node(handler?: (path: string, headers: Headers) => Response | undefined) {
    fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      const headers = new Headers(init?.headers);
      requests.push({ path, headers, init });
      const custom = handler?.(path, headers);
      if (custom !== undefined) {
        return custom;
      }
      if (path === `/v1/papers/${LISTED}`) {
        return json(paperBody());
      }
      if (path === `/v1/papers/${UNLISTED}`) {
        return headers.has("authorization")
          ? json(paperBody({ shortId: UNLISTED, title: "UNLISTED SECRET TITLE" }))
          : json({ title: "Not Found", status: 404 }, 404, "application/problem+json");
      }
      const profile = /^\/v1\/profiles\/(did:key:.+)$/.exec(path);
      if (profile !== null && NAMES[profile[1]] !== undefined) {
        return json({ did: profile[1], name: NAMES[profile[1]] });
      }
      return json({ title: "Not Found", status: 404 }, 404, "application/problem+json");
    });
    vi.stubGlobal("fetch", fetchStub);
  }

  const call = (id: string) => paperCardRoute({ params: Promise.resolve({ id }) });

  /** What the site card and the listed paper's card look like, rendered directly. */
  let siteBytes: Buffer;
  let listedBytes: Buffer;

  beforeEach(async () => {
    requests = [];
    tokenStore.clear();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
    siteBytes ??= await bytesOf(await renderBrandCard(SITE_CARD));
    listedBytes ??= await bytesOf(
      await renderBrandCard({
        kind: "paper",
        title: "Scalable verification of signed preprints with append-only logs",
        authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
        moreAuthors: 2,
        schId: LISTED,
        status: "under_review",
      }),
    );
  }, 60_000);

  afterEach(() => {
    tokenStore.clear();
    vi.unstubAllGlobals();
  });

  it("exports Next's image metadata, and is never prerendered", () => {
    expect(paperSize).toEqual({ width: 1200, height: 630 });
    expect(paperContentType).toBe("image/png");
    expect(paperAlt).toMatch(/paper/i);
    expect(paperDynamic).toBe("force-dynamic");
  });

  it("serves a listed paper's card with HTTP 200 and content-type image/png", async () => {
    node();
    const response = await call(LISTED);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = await bytesOf(response);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    // Same bytes as a direct render of: the title, the first three named
    // authors + "and 2 more", the sch: id and the status — so the route read
    // exactly those, and nothing else, onto the card.
    expect(bytes.equals(listedBytes)).toBe(true);
    expect(bytes.equals(siteBytes)).toBe(false);
  }, 60_000);

  it("accepts the id as the URL spells it: with or without sch:, encoded or not", async () => {
    node();
    for (const id of [LISTED, "k3f9-q2xz-7mwd", "sch%3Ak3f9-q2xz-7mwd"]) {
      expect((await bytesOf(await call(id))).equals(listedBytes), id).toBe(true);
    }
  }, 60_000);

  it("reads only the three authors it names", async () => {
    node();
    await bytesOf(await call(LISTED));
    const profiles = requests.filter((request) => request.path.startsWith("/v1/profiles/")).map((request) => request.path);
    expect(profiles.sort()).toEqual(["/v1/profiles/did:key:a", "/v1/profiles/did:key:b", "/v1/profiles/did:key:c"]);
    expect(requests.filter((request) => request.path.startsWith("/v1/papers/"))).toHaveLength(1);
  }, 60_000);

  it("orders the byline by signed position, not by the order the API listed them", async () => {
    node((path) =>
      path === `/v1/papers/${LISTED}`
        ? json(
            paperBody({
              authors: [
                { did: "did:key:c", position: 3 },
                { did: "did:key:a", position: 1 },
                { did: "did:key:b", position: 2 },
              ],
            }),
          )
        : undefined,
    );
    const bytes = await bytesOf(await call(LISTED));
    const expected = await bytesOf(
      await renderBrandCard({
        kind: "paper",
        title: "Scalable verification of signed preprints with append-only logs",
        authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper"],
        moreAuthors: 0,
        schId: LISTED,
        status: "under_review",
      }),
    );
    expect(bytes.equals(expected)).toBe(true);
  }, 60_000);

  it("still draws the card when an author's profile cannot be read, counting them as 'more'", async () => {
    node((path) => (path === "/v1/profiles/did:key:b" ? new Response("boom", { status: 500 }) : undefined));
    const bytes = await bytesOf(await call(LISTED));
    const expected = await bytesOf(
      await renderBrandCard({
        kind: "paper",
        title: "Scalable verification of signed preprints with append-only logs",
        authors: ["Ada Lovelace", "Grace Hopper"],
        moreAuthors: 3,
        schId: LISTED,
        status: "under_review",
      }),
    );
    expect(bytes.equals(expected)).toBe(true);
  }, 60_000);

  it("caches a paper's card for minutes, not next/og's immutable year", async () => {
    node();
    const response = await call(LISTED);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    await response.arrayBuffer();
  }, 60_000);

  describe("falls back to the site card, byte for byte, never naming a paper", () => {
    it("when the paper is not publicly listed (the catalog answers 404)", async () => {
      node();
      const response = await call(UNLISTED);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect((await bytesOf(response)).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("for the author or a moderator too: the request carries no credentials, even with a token in memory", async () => {
      tokenStore.set({ accessToken: "an-authors-access-token" });
      node();
      const response = await call(UNLISTED);
      expect((await bytesOf(response)).equals(siteBytes)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.headers.has("authorization"), request.path).toBe(false);
        expect(request.headers.has("cookie"), request.path).toBe(false);
        expect(request.init?.credentials, request.path).toBe("omit");
      }
      // The stub really would have leaked the title to a request with a token…
      const leaked = await (await fetch(`http://localhost:8000/v1/papers/${UNLISTED}`, { headers: { authorization: "Bearer x" } })).json();
      expect(leaked.title).toBe("UNLISTED SECRET TITLE");
      // …and a listed paper's card does not change when somebody is signed in.
      expect((await bytesOf(await call(LISTED))).equals(listedBytes)).toBe(true);
    }, 60_000);

    it("when the node is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("when the node is too slow: every read carries a timeout signal, and its expiry falls back", async () => {
      node();
      await bytesOf(await call(LISTED));
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.init?.signal, request.path).toBeInstanceOf(AbortSignal);
      }
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("when the node answers 500", async () => {
      node(() => new Response("down", { status: 500 }));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("when the body is not a paper", async () => {
      node((path) => (path.startsWith("/v1/papers/") ? json({ hello: "world" }) : undefined));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
      node((path) => (path.startsWith("/v1/papers/") ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) : undefined));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("when the title needs glyphs the fonts lack, without asking anyone for a font", async () => {
      node((path) => (path === `/v1/papers/${LISTED}` ? json(paperBody({ title: "Measuring α in dense plasmas" })) : undefined));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
      // Only the node was ever called: no fonts.googleapis.com, no cdn.jsdelivr.net.
      for (const [input] of fetchStub.mock.calls) {
        expect(new URL(String(input)).host).toBe("localhost:8000");
      }
    }, 60_000);

    it("when the API names the paper with an id that is not a sch: id", async () => {
      node((path) => (path === `/v1/papers/${LISTED}` ? json(paperBody({ shortId: "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" })) : undefined));
      expect((await bytesOf(await call(LISTED))).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("when the address is not a paper address, without calling the node", async () => {
      node();
      for (const id of ["", "not a paper!!", "../../etc/passwd", "sch:zzzz"]) {
        expect((await bytesOf(await call(id))).equals(siteBytes), JSON.stringify(id)).toBe(true);
      }
      expect(fetchStub).not.toHaveBeenCalled();
    }, 60_000);

    it("caches the fallback for one minute, so a listing or a recovered node replaces it soon", async () => {
      node();
      const response = await call(UNLISTED);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
      await response.arrayBuffer();
    }, 60_000);
  });

  it("always reads the newest listed version, never one the URL names (it may be unlisted)", async () => {
    // `/p/{id}/v2` inherits this card; a version in the address must not reach the read.
    node();
    await bytesOf(await call(`${LISTED}/v2`));
    const reads = requests.filter((request) => request.path.startsWith("/v1/papers/")).map((request) => request.path);
    expect(reads).toEqual([`/v1/papers/${LISTED}`]);
  }, 60_000);

  describe("at its plain URL, which the sibling [version] page would otherwise swallow", () => {
    it("serves the same card as image/png", async () => {
      node();
      const response = await plainUrlGet(new Request("http://localhost/p/k3f9-q2xz-7mwd/opengraph-image"), {
        params: Promise.resolve({ id: "k3f9-q2xz-7mwd" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect((await bytesOf(response)).equals(listedBytes)).toBe(true);
    }, 60_000);

    it("falls back to the site card for an unlisted paper too", async () => {
      node();
      const response = await plainUrlGet(new Request("http://localhost/p/x/opengraph-image"), {
        params: Promise.resolve({ id: UNLISTED }),
      });
      expect((await bytesOf(response)).equals(siteBytes)).toBe(true);
    }, 60_000);

    it("is never prerendered either", () => {
      expect(plainUrlDynamic).toBe("force-dynamic");
    });
  });
});
