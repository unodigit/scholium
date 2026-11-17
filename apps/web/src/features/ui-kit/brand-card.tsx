/**
 * BrandCard — the 1200 × 630 social share card (docs/design.md §2).
 *
 * Two cards, one component:
 *
 * - **site** — the glyph mark and the lowercase `scholium` wordmark centred on
 *   the paper background, with the one-line tagline under them. Served at
 *   `/opengraph-image` and `/twitter-image`, and the fallback for everything
 *   below.
 * - **paper** — what a link to `/p/{id}` unfurls to: the status word, the
 *   title in the serif face (at most three lines), the first three authors, the
 *   `sch:` id in monospace, and a small lockup in the bottom-right corner.
 *   Served at `/p/{id}/opengraph-image`.
 *
 * ```ts
 * // app/opengraph-image.tsx
 * export default () => renderBrandCard(SITE_CARD);
 *
 * // app/(paper-page)/p/[id]/opengraph-image.tsx
 * export default async () => renderBrandCard(brandCardFor(paperOrNull));
 * ```
 *
 * **Why the colours are hex literals here.** The card is rasterised by Satori
 * (`next/og`), which knows neither CSS custom properties nor the `.css` files
 * the rest of the kit reads, so `var(--accent)` has nothing to resolve against.
 * {@link BRAND_CARD_PALETTE} holds the light-theme values of the tokens in
 * `src/styles/tokens.css` — `brand-card.test.tsx` fails if the two drift apart,
 * and if any colour in the card is not in the palette.
 *
 * **Why the text goes through {@link drawableText}.** `next/og` fetches a font
 * from Google Fonts (and emoji from jsDelivr) for any character the bundled
 * fonts cannot draw, with the text itself in the request URL. A share card for
 * a public paper must not depend on, or tell, a third party, so text is checked
 * against the glyphs of the four self-hosted fonts first. A title that needs
 * anything else makes the paper card fall back to the site card; an author name
 * that does is left out of the byline. Nothing here ever draws a missing-glyph
 * box.
 *
 * **Never leaks.** {@link brandCardFor} only builds a paper card from a paper
 * the caller has already read from the *public* catalog (the route reads it
 * anonymously). Given `null` — a paper that is missing, not listed, or could
 * not be read — it returns the site card, which carries nothing about any
 * paper.
 *
 * Server-only (it reads font files and calls `next/og`); nothing in the browser
 * bundle imports it, and it is deliberately not re-exported from `index.ts`.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ImageResponse } from "next/og";
import type { CSSProperties, ReactElement } from "react";

import { ICON_GRID, ICON_SHAPES, type IconName } from "./icons";
import { STATUS_CHIP_SPECS, isPaperStatus, type StatusTone } from "./status";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** The size Open Graph and Twitter large-summary cards are drawn at. */
export const BRAND_CARD_SIZE = { width: 1200, height: 630 } as const;

export const BRAND_CARD_CONTENT_TYPE = "image/png" as const;

/** The brand's one-line tagline (same words as the sign-in screens and the root description). */
export const BRAND_CARD_TAGLINE = "Signed, open preprints and peer review";

/** The wordmark: always lowercase (docs/design.md §2). */
export const BRAND_CARD_WORDMARK = "scholium";

/** Alt text for the site card (`export const alt`). */
export const BRAND_CARD_ALT = `${BRAND_CARD_WORDMARK}: ${BRAND_CARD_TAGLINE}`;

/**
 * How long the site card may be cached. `next/og` answers `immutable` for a
 * year, which is only safe if the image URL changes whenever the card does; a
 * day is safe either way, and a crawler asks for the card rarely.
 */
export const SITE_CARD_CACHE_CONTROL = "public, max-age=86400";

/** Alt text for the paper card: Next takes `alt` as a static export, so it cannot name the paper. */
export const PAPER_CARD_ALT = "A paper on scholium: its title, authors and sch: id";

/**
 * The light-theme tokens the card uses (docs/design.md §3, `tokens.css`).
 * `--ai` is deliberately absent: AI output never shares a surface with human
 * status, and nothing on a share card is AI output.
 */
export const BRAND_CARD_PALETTE = {
  /** `--bg`: warm paper. */
  paper: "#FBFAF7",
  /** `--surface` */
  surface: "#FFFFFF",
  /** `--ink` */
  ink: "#1B1D22",
  /** `--ink-2` */
  ink2: "#5A5F6B",
  /** `--rule` */
  rule: "#E4E1D9",
  /** `--accent`: scholar's ink blue. */
  accent: "#2F4BA0",
  /** `--verified` */
  verified: "#1F7A54",
  /** `--pending` */
  pending: "#9A6B00",
  /** `--critical` */
  critical: "#B3312B",
  /** `--margin-note` */
  marginNote: "#FFF6D6",
  /** `--verified-soft` */
  verifiedSoft: "#E6F1EB",
  /** `--pending-soft` */
  pendingSoft: "#F9F0DA",
  /** `--critical-soft` */
  criticalSoft: "#F7E7E5",
} as const;

const C = BRAND_CARD_PALETTE;

/** Family names as registered with Satori; the faces are `og-fonts/*.woff`. */
export const BRAND_CARD_FONTS = {
  serif: "Source Serif 4",
  sans: "Inter",
  mono: "JetBrains Mono",
} as const;

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/** Space between the card's edge and its content (4 px grid, docs/design.md §3). */
export const CARD_PADDING = 64;

/** The paper title never takes more than this many lines; the last one ends in an ellipsis. */
export const TITLE_LINE_CLAMP = 3;

/** How many authors the byline names. */
export const MAX_AUTHORS = 3;

/** A long byline wraps to at most this many lines. */
export const AUTHOR_LINE_CLAMP = 2;

/** Title and name length caps (code points) so a hostile record cannot make layout expensive. */
const MAX_TITLE_LENGTH = 300;
const MAX_NAME_LENGTH = 100;

export interface TitleLayout {
  /** Pixels. */
  readonly fontSize: number;
  /** Unitless multiplier. */
  readonly lineHeight: number;
  readonly lineClamp: number;
}

/**
 * Title size by length: a short title is set large; a long one steps down so
 * that three lines hold as much of it as possible before the ellipsis. Source
 * Serif 4 semibold averages about half an em per character, and the text column
 * is 1072 px wide.
 */
const TITLE_STEPS: readonly { readonly upTo: number; readonly fontSize: number }[] = [
  { upTo: 60, fontSize: 60 },
  { upTo: 100, fontSize: 56 },
  { upTo: 130, fontSize: 48 },
  { upTo: Number.POSITIVE_INFINITY, fontSize: 44 },
];

export function titleLayout(title: string): TitleLayout {
  const length = [...title].length;
  const step = TITLE_STEPS.find((candidate) => length <= candidate.upTo) ?? TITLE_STEPS[TITLE_STEPS.length - 1];
  return { fontSize: step.fontSize, lineHeight: 1.18, lineClamp: TITLE_LINE_CLAMP };
}

export interface LockupLayout {
  readonly markWidth: number;
  readonly markHeight: number;
  readonly wordmarkSize: number;
  readonly gap: number;
  /** Space under the wordmark that lifts its ink to the mark's optical centre. */
  readonly wordmarkLift: number;
}

/** The glyph's own box (`BrandMark`'s `glyph` variant): 52 × 54. */
const GLYPH_BOX = { width: 52, height: 54 } as const;

/**
 * Lockup proportions, from the mark's height: the wordmark's size and the gap
 * between mark and wordmark scale with it, like `BrandLogo` does. The wordmark
 * is set larger than the in-app logo's 0.72 so that, as in the delivered
 * `scholium-logo-light.jpeg`, its ascenders reach up toward the top of the
 * page block. Clear space is half the mark height (docs/design.md §2), which
 * the card keeps by padding.
 */
export function lockupLayout(markHeight: number): LockupLayout {
  const wordmarkSize = Math.round(markHeight * 0.95);
  return {
    markWidth: Math.round((markHeight * GLYPH_BOX.width) / GLYPH_BOX.height),
    markHeight,
    wordmarkSize,
    gap: Math.round(markHeight / 5),
    // "scholium" has no descenders, so its ink sits low in a centred line box.
    wordmarkLift: Math.round(wordmarkSize * 0.12),
  };
}

/** Mark heights: large for the site card, small for the paper card's corner. */
export const SITE_MARK_HEIGHT = 128;
export const CORNER_MARK_HEIGHT = 44;

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export interface SiteCardProps {
  readonly kind: "site";
}

export interface PaperCardProps {
  readonly kind: "paper";
  readonly title: string;
  /** Names to print, in byline order. Only the first {@link MAX_AUTHORS} are used. */
  readonly authors: readonly string[];
  /** Authors who exist but are not named in the byline: "and 2 more". */
  readonly moreAuthors?: number;
  /** `sch:xxxx-xxxx-xxxx`. */
  readonly schId: string;
  /** A status id from the API (`preprint`, `under_review`, …). */
  readonly status: string;
}

export type BrandCardProps = SiteCardProps | PaperCardProps;

/** The card for the site itself, and the fallback for any paper that cannot be shown. */
export const SITE_CARD: SiteCardProps = { kind: "site" };

/** What a loaded paper must offer to be put on a card. Structural, so any loader's shape fits. */
export interface PaperCardSource {
  readonly title: string;
  readonly shortId: string;
  readonly status: string;
  /** In byline order; `name` is `null` when the profile is missing or erased. */
  readonly authors: readonly { readonly name: string | null }[];
}

/* -------------------------------------------------------------------------- */
/* Text the bundled fonts can draw                                             */
/* -------------------------------------------------------------------------- */

/**
 * Code points every one of the four bundled faces has a glyph for: Basic
 * Latin, Latin-1, a few Latin letters and modifiers, curly quotes, dashes, the
 * ellipsis and bullet, primes, the euro and trade-mark signs and the minus.
 * Combining marks are left out on purpose: Satori does no mark positioning, so
 * they are folded into their base letter instead.
 */
const DRAWABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ac],
  [0x00ae, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bc, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2212, 0x2212],
];

function isDrawable(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return DRAWABLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** Letters the font lacks that Unicode does not decompose, and the hyphens it lacks. */
const FOLDS: Readonly<Record<string, string>> = {
  Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", Ŧ: "T", ŧ: "t", Ŋ: "N", ŋ: "n",
  "‐": "-", "‑": "-", "‒": "-", "―": "-",
};

/**
 * The text as the bundled fonts can draw it, or `null` if they cannot.
 *
 * Whitespace collapses to single spaces and invisible control and format
 * characters (zero-width joiners, bidi marks, soft hyphens) are dropped. A
 * character the fonts lack is folded to its plain letter when it has one —
 * `Dvořák` → `Dvorak`, `Łukasz` → `Lukasz` — and otherwise makes the whole
 * text undrawable (`null`): Greek, Cyrillic, CJK and emoji are not guessed at.
 * An empty result is `null` too.
 */
export function drawableText(text: string, maxLength = MAX_TITLE_LENGTH): string | null {
  const capped = [...text].slice(0, maxLength).join("");
  const cleaned = capped
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();

  let drawn = "";
  for (const character of cleaned) {
    if (isDrawable(character)) {
      drawn += character;
      continue;
    }
    const folded = FOLDS[character] ?? character.normalize("NFKD").replace(/\p{M}/gu, "");
    for (const part of folded) {
      if (!isDrawable(part)) {
        return null;
      }
    }
    drawn += folded;
  }
  const result = drawn.replace(/ {2,}/gu, " ").trim();
  return result === "" ? null : result;
}

/* -------------------------------------------------------------------------- */
/* Building a card from a paper                                                */
/* -------------------------------------------------------------------------- */

/** `sch:k3f9-q2xz-7mwd`, the canonical short id (docs/design.md §2). */
const SCH_ID = /^sch:[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

/** The word, tone and icon a status shows. Unknown statuses are neutral and keep their own word. */
export interface StatusWord {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: IconName;
}

export function statusWord(status: string): StatusWord {
  if (isPaperStatus(status)) {
    const { label, tone, icon } = STATUS_CHIP_SPECS[status];
    return { label, tone, icon };
  }
  // A status this build does not know (a newer node): say it plainly, in
  // neutral colours. "Listed" is the honest word if it cannot be drawn.
  const spoken = drawableText(status.replace(/[_-]+/gu, " "), 40);
  const label = spoken === null ? "Listed" : `${spoken.charAt(0).toUpperCase()}${spoken.slice(1).toLowerCase()}`;
  return { label, tone: "neutral", icon: "circle" };
}

/**
 * Clean a paper card's text, or give up on it.
 *
 * Returns the site card when the title cannot be drawn, is empty, or the id is
 * not a `sch:` id; drops author names that cannot be drawn (counting them in
 * `moreAuthors`); keeps the first {@link MAX_AUTHORS} names. Idempotent, and
 * the one door every card goes through on its way to {@link renderBrandCard}.
 */
export function drawableCard(card: BrandCardProps): BrandCardProps {
  if (card.kind === "site") {
    return card;
  }
  const title = drawableText(card.title, MAX_TITLE_LENGTH);
  const schId = card.schId.trim();
  if (title === null || !SCH_ID.test(schId)) {
    return SITE_CARD;
  }
  const named = card.authors
    .map((author) => drawableText(author, MAX_NAME_LENGTH))
    .filter((name): name is string => name !== null);
  const shown = named.slice(0, MAX_AUTHORS);
  const more = Math.max(0, Math.trunc(card.moreAuthors ?? 0)) + (card.authors.length - shown.length);
  return {
    kind: "paper",
    title,
    authors: shown,
    moreAuthors: more,
    schId,
    status: card.status,
  };
}

/**
 * The card for a paper the caller read from the public catalog, or the site
 * card for `null`/`undefined` — a paper that could not be loaded or is not
 * publicly listed. The first {@link MAX_AUTHORS} *named* authors go on the
 * byline; everyone else is "and N more".
 */
export function brandCardFor(paper: PaperCardSource | null | undefined): BrandCardProps {
  if (paper === null || paper === undefined) {
    return SITE_CARD;
  }
  const names: string[] = [];
  for (const author of paper.authors) {
    if (author.name !== null && names.length < MAX_AUTHORS) {
      names.push(author.name);
    }
  }
  return drawableCard({
    kind: "paper",
    title: paper.title,
    authors: names,
    moreAuthors: paper.authors.length - names.length,
    schId: paper.shortId,
    status: paper.status,
  });
}

/** The byline's text: `Ada Lovelace, Alan Turing and 2 more`; `""` when there is nothing to say. */
export function bylineText(authors: readonly string[], moreAuthors = 0): string {
  const names = authors.slice(0, MAX_AUTHORS);
  const more = Math.max(0, Math.trunc(moreAuthors));
  if (names.length === 0) {
    return more === 0 ? "" : `${more} ${more === 1 ? "author" : "authors"}`;
  }
  return more === 0 ? names.join(", ") : `${names.join(", ")} and ${more} more`;
}

/* -------------------------------------------------------------------------- */
/* The card                                                                    */
/* -------------------------------------------------------------------------- */

// Satori accepts `lineClamp`, which React's CSSProperties does not list yet.
type CardStyle = CSSProperties & { lineClamp?: number };

const TONE_COLOURS: Readonly<Record<StatusTone, { icon: string; fill: string; edge: string }>> = {
  neutral: { icon: C.ink2, fill: C.surface, edge: C.rule },
  verified: { icon: C.verified, fill: C.verifiedSoft, edge: C.verified },
  pending: { icon: C.pending, fill: C.pendingSoft, edge: C.pending },
  critical: { icon: C.critical, fill: C.criticalSoft, edge: C.critical },
};

/**
 * The glyph: a square-cornered accent page with five light text lines, a
 * margin-note strip, and the closing bracket, 1.35 x the page's height. The
 * geometry is `BrandMark`'s `glyph` variant (drawn from the delivered
 * `scholium-logo-light.jpeg`; see brand-mark.tsx), with the tokens resolved
 * (the test compares the two).
 */
function glyphMark(markHeight: number): ReactElement {
  const { markWidth } = lockupLayout(markHeight);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={markWidth}
      height={markHeight}
      viewBox={`0 0 ${GLYPH_BOX.width} ${GLYPH_BOX.height}`}
    >
      <rect y="7" width="36" height="40" fill={C.accent} />
      <rect x="5.5" y="15" width="25" height="1.6" rx="0.8" fill={C.paper} />
      <rect x="5.5" y="20.6" width="25" height="1.6" rx="0.8" fill={C.paper} />
      <rect x="5.5" y="26.2" width="25" height="1.6" rx="0.8" fill={C.paper} />
      <rect x="5.5" y="31.8" width="25" height="1.6" rx="0.8" fill={C.paper} />
      <rect x="5.5" y="37.4" width="13" height="1.6" rx="0.8" fill={C.paper} />
      <rect x="39" y="7" width="9" height="40" fill={C.marginNote} />
      <path fill={C.accent} d="M39 0h13v54H39v-4h9V4h-9z" />
    </svg>
  );
}

/** The lockup: glyph, then the lowercase serif wordmark in ink. */
function lockup(markHeight: number): ReactElement {
  const layout = lockupLayout(markHeight);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: layout.gap }}>
      {glyphMark(markHeight)}
      <div
        style={{
          display: "flex",
          fontFamily: BRAND_CARD_FONTS.serif,
          fontWeight: 600,
          fontSize: layout.wordmarkSize,
          lineHeight: 1,
          letterSpacing: "-0.01em",
          paddingBottom: layout.wordmarkLift,
          color: C.ink,
        }}
      >
        {BRAND_CARD_WORDMARK}
      </div>
    </div>
  );
}

/** A status icon from the kit's 16 × 16 set, drawn in the tone's colour. */
function statusIcon(icon: IconName, colour: string, size: number): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      fill="none"
      stroke={colour}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_SHAPES[icon].map((shape, index) =>
        shape.tag === "circle" ? (
          <circle key={index} cx={shape.attrs.cx} cy={shape.attrs.cy} r={shape.attrs.r} />
        ) : (
          <path key={index} d={String(shape.attrs.d)} />
        ),
      )}
    </svg>
  );
}

/**
 * The status as the paper page's chip shows it: an icon of its own shape and a
 * word in ink on a soft tint, with the status colour on the icon and edge only
 * (the word never relies on colour, docs/design.md §3 and §9).
 */
function statusChip(status: string): ReactElement {
  const { label, tone, icon } = statusWord(status);
  const colours = TONE_COLOURS[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 24px 10px 18px",
        borderRadius: 999,
        border: `2px solid ${colours.edge}`,
        backgroundColor: colours.fill,
      }}
    >
      {statusIcon(icon, colours.icon, 30)}
      <div
        style={{
          display: "flex",
          fontFamily: BRAND_CARD_FONTS.sans,
          fontWeight: 500,
          fontSize: 28,
          lineHeight: 1.2,
          color: C.ink,
        }}
      >
        {label}
      </div>
    </div>
  );
}

const ROOT_STYLE: CardStyle = {
  display: "flex",
  flexDirection: "column",
  width: BRAND_CARD_SIZE.width,
  height: BRAND_CARD_SIZE.height,
  backgroundColor: C.paper,
  color: C.ink,
  fontFamily: BRAND_CARD_FONTS.sans,
};

function siteCard(): ReactElement {
  return (
    <div style={{ ...ROOT_STYLE, alignItems: "center", justifyContent: "center" }}>
      {lockup(SITE_MARK_HEIGHT)}
      <div
        style={{
          display: "flex",
          marginTop: 48,
          fontFamily: BRAND_CARD_FONTS.sans,
          fontWeight: 400,
          fontSize: 38,
          lineHeight: 1.3,
          letterSpacing: "0.01em",
          color: C.ink2,
        }}
      >
        {BRAND_CARD_TAGLINE}
      </div>
    </div>
  );
}

function paperCard(props: PaperCardProps): ReactElement {
  const title = titleLayout(props.title);
  const byline = bylineText(props.authors, props.moreAuthors);
  return (
    <div style={{ ...ROOT_STYLE, padding: CARD_PADDING }}>
      <div style={{ display: "flex", alignItems: "flex-start" }}>{statusChip(props.status)}</div>

      <div
        style={
          {
            display: "block",
            marginTop: 40,
            fontFamily: BRAND_CARD_FONTS.serif,
            fontWeight: 600,
            fontSize: title.fontSize,
            lineHeight: title.lineHeight,
            letterSpacing: "-0.015em",
            lineClamp: title.lineClamp,
            color: C.ink,
          } satisfies CardStyle
        }
      >
        {props.title}
      </div>

      {byline === "" ? null : (
        <div
          style={
            {
              display: "block",
              marginTop: 28,
              fontFamily: BRAND_CARD_FONTS.sans,
              fontWeight: 500,
              fontSize: 30,
              lineHeight: 1.35,
              lineClamp: AUTHOR_LINE_CLAMP,
              color: C.ink2,
            } satisfies CardStyle
          }
        >
          {byline}
        </div>
      )}

      <div style={{ display: "flex", flexGrow: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 28,
          borderTop: `2px solid ${C.rule}`,
        }}
      >
        <div
          style={{
            display: "flex",
            fontFamily: BRAND_CARD_FONTS.mono,
            fontWeight: 500,
            fontSize: 30,
            lineHeight: 1.2,
            color: C.ink,
          }}
        >
          {props.schId}
        </div>
        {lockup(CORNER_MARK_HEIGHT)}
      </div>
    </div>
  );
}

/**
 * The card as a Satori element tree. Pure layout from props: it assumes text
 * already went through {@link drawableCard} ({@link renderBrandCard} does that).
 *
 * Satori's rules shape the markup: every `div` that holds more than one child
 * is `display: flex`, text is always a single string child, and nothing uses a
 * CSS variable, class or image URL.
 */
export function BrandCard(props: BrandCardProps): ReactElement {
  return props.kind === "paper" ? paperCard(props) : siteCard();
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

type SatoriFont = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"] extends
  | readonly (infer F)[]
  | undefined
  ? F
  : never;

/**
 * The faces the card uses. Static instances of the variable fonts in
 * `public/fonts` (Satori reads TTF, OTF and WOFF — not WOFF2 — and does not
 * interpolate variable axes); see `og-fonts/README.md`.
 */
const FONT_FILES = [
  { name: BRAND_CARD_FONTS.serif, file: "source-serif-4-semibold.woff", weight: 600 },
  { name: BRAND_CARD_FONTS.sans, file: "inter-regular.woff", weight: 400 },
  { name: BRAND_CARD_FONTS.sans, file: "inter-medium.woff", weight: 500 },
  { name: BRAND_CARD_FONTS.mono, file: "jetbrains-mono-medium.woff", weight: 500 },
] as const;

/** Where `og-fonts/` can be: from the app's working directory (what `next dev`/`start` use), else beside this file. */
function fontDirectories(): string[] {
  const directories = [join(process.cwd(), "src", "features", "ui-kit", "og-fonts")];
  try {
    directories.push(join(dirname(fileURLToPath(import.meta.url)), "og-fonts"));
  } catch {
    // `import.meta.url` is not a file URL in this bundle; the first candidate stands.
  }
  return directories;
}

async function readFontFile(file: string): Promise<Buffer> {
  let failure: unknown;
  for (const directory of fontDirectories()) {
    try {
      return await readFile(join(directory, file));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

let fontsOnce: Promise<SatoriFont[]> | undefined;

/** The card's fonts, read once per server process. A failed read is not remembered. */
export function loadBrandCardFonts(): Promise<SatoriFont[]> {
  fontsOnce ??= Promise.all(
    FONT_FILES.map(async ({ name, file, weight }): Promise<SatoriFont> => {
      const data = await readFontFile(file);
      return {
        name,
        weight,
        style: "normal",
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      };
    }),
  ).catch((error: unknown) => {
    fontsOnce = undefined;
    throw error;
  });
  return fontsOnce;
}

/**
 * Render a card to a PNG `Response` (`image/png`, 1200 × 630).
 *
 * `next/og` marks its output `immutable` for a year by default, which is right
 * for a card that only changes on deploy and wrong for a paper's, whose title,
 * status and listing can change; pass `headers` to say otherwise.
 */
export async function renderBrandCard(
  card: BrandCardProps,
  init: { readonly headers?: HeadersInit } = {},
): Promise<ImageResponse> {
  const fonts = await loadBrandCardFonts();
  return new ImageResponse(BrandCard(drawableCard(card)), {
    ...BRAND_CARD_SIZE,
    fonts,
    headers: init.headers,
  });
}
