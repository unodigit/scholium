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
    viewBox: resolvedVariant === "tile" ? "0 0 32 32" : "0 0 28 32",
    width: resolvedVariant === "tile" ? 32 : 28,
    height: 32,
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
          <rect width="18" height="32" rx="4" fill="var(--accent)" aria-hidden="true" />
          <rect x="3" y="6" width="12" height="3" rx="1.5" fill="var(--bg)" aria-hidden="true" />
          <rect x="3" y="12" width="12" height="3" rx="1.5" fill="var(--bg)" aria-hidden="true" />
          <rect x="3" y="18" width="12" height="3" rx="1.5" fill="var(--bg)" aria-hidden="true" />
          <rect x="3" y="24" width="8" height="3" rx="1.5" fill="var(--bg)" aria-hidden="true" />
          <rect x="20" y="0" width="2" height="32" fill="var(--margin-note)" aria-hidden="true" />
          <path
            fill="var(--accent)"
            d="M23 7h4v18h-4v-2h2V9h-2V7z"
            aria-hidden="true"
          />
        </svg>
      )}
    </span>
  );
}
