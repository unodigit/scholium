/**
 * Inline stroke icons for the global navigation.
 *
 * 24×24 viewBox, `currentColor`, 1.5 px round strokes: they inherit
 * `--ink`/`--ink-2`/`--accent` like text and stay crisp from 16 to 24 px.
 * Five glyphs are cheaper inlined than an icon package, and they stay
 * theme-aware (light/dark, forced themes) for free.
 *
 * Decorative by default (`aria-hidden`); labels live on the buttons and links.
 */

import type { SVGProps } from "react";

/** Props every nav icon accepts; `size` sets width and height. */
export interface NavIconProps extends Omit<SVGProps<SVGSVGElement>, "size"> {
  /** Square icon size in px; defaults to 20. */
  size?: number | string;
}

function svgProps({ size = 20, ...rest }: NavIconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: "false",
    ...rest,
  };
}

/** Magnifier — the search affordance in the header and the Search tab. */
export function SearchIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4.5 4.5" />
    </svg>
  );
}

/** Bell — notifications in the header and the Inbox tab. */
export function BellIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** Plus — Submit. */
export function PlusIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/** House — the Home tab. */
export function HomeIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Person — the avatar fallback and the Me tab. */
export function PersonIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

/** Small chevron — the Categories menu indicator. */
export function ChevronDownIcon(props: NavIconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
