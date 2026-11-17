import { type ComponentPropsWithoutRef } from "react";

import "./brand.css";

export type BrandVariant = "tile" | "glyph";
export type BrandSize = "sm" | "md" | "lg";

export interface BrandMarkProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  variant?: BrandVariant;
  size?: BrandSize;
  decorative?: boolean;
  markOnly?: boolean;
}

const SIZE_PX: Record<BrandSize, number> = { sm: 20, md: 28, lg: 48 };

/**
 * The glyph, drawn to the delivered lockup (`docs/brand/scholium-logo-light.jpeg`,
 * measured in pixels; `-dark.jpeg` is the same drawing). One unit is 1/40 of the
 * page block's height, so the numbers below read as proportions of the page:
 *
 * - page block 36 × 40 (0.9 : 1, the reference's 104 × 118), square corners;
 * - five text lines 1.6 thick with round ends, 25 long and inset 5.5 from both
 *   sides, the last 13 long (about half); centres at 22 / 36 / 50 / 64 / 78 %
 *   of the page height, 5.6 apart;
 * - a closing bracket 54 tall (1.35 x the page), centred on it, strokes 4 thick
 *   (0.11 x the page width), 13 wide, its arm tips 3 to the right of the page;
 * - the margin-note strip fills the bracket's pocket: 9 wide (0.25 x the page
 *   width), as tall as the page, from the arm tips to the stem.
 *
 * The viewBox is the drawing's tight bounding box, so the SVG's height is the
 * bracket's height and `BrandLogo` can place the wordmark from it.
 */
const GLYPH = {
  width: 52,
  height: 54,
  page: { width: 36, height: 40, y: 7 },
  line: { x: 5.5, thickness: 1.6, length: 25, lastLength: 13, tops: [15, 20.6, 26.2, 31.8, 37.4] },
  strip: { x: 39, width: 9 },
  bracket: "M39 0h13v54H39v-4h9V4h-9z",
} as const;

function isBrandVariant(value: unknown): value is BrandVariant {
  return value === "tile" || value === "glyph";
}

function isBrandSize(value: unknown): value is BrandSize {
  return value === "sm" || value === "md" || value === "lg";
}

export function BrandMark({
  variant = "tile",
  size = "md",
  decorative = false,
  markOnly: _markOnly,
  className,
  style,
  ...rest
}: BrandMarkProps) {
  const resolvedVariant: BrandVariant = isBrandVariant(variant) ? variant : "tile";
  const resolvedSize: BrandSize = isBrandSize(size) ? size : "md";
  const px = SIZE_PX[resolvedSize];

  const svgProps = {
    viewBox: resolvedVariant === "tile" ? "0 0 32 32" : `0 0 ${GLYPH.width} ${GLYPH.height}`,
    width: resolvedVariant === "tile" ? 32 : GLYPH.width,
    height: resolvedVariant === "tile" ? 32 : GLYPH.height,
    xmlns: "http://www.w3.org/2000/svg",
    "data-variant": resolvedVariant,
    "aria-hidden": decorative ? ("true" as const) : undefined,
    role: decorative ? ("presentation" as const) : ("img" as const),
    "aria-label": decorative ? undefined : "Scholium",
    focusable: false,
  };

  return (
    <span
      {...rest}
      className={className ? `sch-brand-mark ${className}` : "sch-brand-mark"}
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      style={{ height: `${px}px`, ...style }}
    >
      {resolvedVariant === "tile" ? (
        <svg {...svgProps}>
          <rect width="32" height="32" rx="6" fill="var(--accent)" aria-hidden="true" />
          <path
            fill="var(--bg)"
            fillRule="evenodd"
            d="M8 9h10v14H8V9zm2 3v2h6v-2h-6zm0 4v2h6v-2h-6zm0 4v2h4v-2h-4z"
            aria-hidden="true"
          />
          <path
            fill="var(--bg)"
            d="M20 7h4v18h-4v-2h2V9h-2V7z"
            aria-hidden="true"
          />
        </svg>
      ) : (
        <svg {...svgProps}>
          <rect
            width={GLYPH.page.width}
            height={GLYPH.page.height}
            y={GLYPH.page.y}
            fill="var(--accent)"
            aria-hidden="true"
          />
          {GLYPH.line.tops.map((top, index) => (
            <rect
              key={top}
              x={GLYPH.line.x}
              y={top}
              width={index === GLYPH.line.tops.length - 1 ? GLYPH.line.lastLength : GLYPH.line.length}
              height={GLYPH.line.thickness}
              rx={GLYPH.line.thickness / 2}
              fill="var(--bg)"
              aria-hidden="true"
            />
          ))}
          <rect
            x={GLYPH.strip.x}
            y={GLYPH.page.y}
            width={GLYPH.strip.width}
            height={GLYPH.page.height}
            fill="var(--margin-note)"
            aria-hidden="true"
          />
          <path fill="var(--accent)" d={GLYPH.bracket} aria-hidden="true" />
        </svg>
      )}
    </span>
  );
}
