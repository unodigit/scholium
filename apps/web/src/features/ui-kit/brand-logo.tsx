import { type ComponentPropsWithoutRef } from "react";

import { BrandMark } from "./brand-mark";
import "./brand.css";

export type BrandLogoSize = "sm" | "md" | "lg";

export interface BrandLogoProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  size?: BrandLogoSize;
  markOnly?: boolean;
}

const SIZE_PX: Record<BrandLogoSize, number> = { sm: 20, md: 28, lg: 48 };

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
      <span className="sch-brand-logo__wordmark" aria-hidden="true">
        scholium
      </span>
    </span>
  );
}
