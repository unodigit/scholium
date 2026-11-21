import { type ComponentPropsWithoutRef } from "react";

import { BrandMark } from "./brand-mark";
import { WORDMARK } from "./wordmark";
import "./brand.css";

export type BrandLogoSize = "sm" | "md" | "lg";

export interface BrandLogoProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  size?: BrandLogoSize;
  markOnly?: boolean;
}

const SIZE_PX: Record<BrandLogoSize, number> = { sm: 20, md: 28, lg: 48 };

/**
 * The outlined wordmark's own box: the delivered drawing (286.99 × 54 on the
 * mark's grid) cropped at the pen origin, 0.26 of the mark height to the right
 * of the bracket. The 220.95 × 54 box runs from there to the drawing's right
 * edge and keeps the wordmark at the lockup's full height, so its ascenders
 * sit level with the page block's top and its baseline 0.205 of the height
 * above the bottom — as `docs/brand/scholium-lockup-light.svg` draws it
 * (docs/design.md §2).
 */
const WORDMARK_HEIGHT = WORDMARK.viewBox[3];
const WORDMARK_WIDTH = Number((WORDMARK.viewBox[2] - WORDMARK.penOriginX).toFixed(2));
const WORDMARK_VIEW_BOX = `${WORDMARK.penOriginX} 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`;

function isBrandSize(value: unknown): value is BrandLogoSize {
  return value === "sm" || value === "md" || value === "lg";
}

export function BrandLogo({
  size = "md",
  markOnly = false,
  className,
  style,
  ...rest
}: BrandLogoProps) {
  const resolvedSize: BrandLogoSize = isBrandSize(size) ? size : "md";
  const px = SIZE_PX[resolvedSize];

  if (markOnly) {
    return (
      <BrandMark
        {...rest}
        variant="glyph"
        size={resolvedSize}
        className={className}
        style={style}
      />
    );
  }

  return (
    <span
      {...rest}
      className={className ? `sch-brand-logo ${className}` : "sch-brand-logo"}
      data-size={resolvedSize}
      role="img"
      aria-label="Scholium"
      style={{ height: `${px}px`, ...style }}
    >
      <BrandMark
        variant="glyph"
        size={resolvedSize}
        decorative
        className="sch-brand-logo__mark"
      />
      {/*
        The wordmark is outline artwork, not text: no font loads and nothing
        can fall back to another face. It is inked from the lockup's colour
        (`color: var(--ink)` in brand.css) through `currentColor`. The
        `<title>` keeps the element's text content "scholium" — the lockup's
        accessible name stays on the parent's `aria-label`.
      */}
      <span className="sch-brand-logo__wordmark" aria-hidden="true">
        <svg
          viewBox={WORDMARK_VIEW_BOX}
          width={WORDMARK_WIDTH}
          height={WORDMARK_HEIGHT}
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          focusable="false"
        >
          <title>scholium</title>
          <path d={WORDMARK.path} fill="currentColor" />
        </svg>
      </span>
    </span>
  );
}
