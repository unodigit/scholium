/**
 * Small line icons for the UI kit, drawn on a 16 × 16 grid with a 1.5 px round
 * stroke in `currentColor`, so an icon takes the colour of whatever sets
 * `color` on it and follows light, dark and forced-colour themes.
 *
 * Icons are decorative. They sit beside a word and are hidden from assistive
 * technology: the word carries the meaning, the shape reinforces it, and the
 * colour reinforces both. Never use one of these alone to say something.
 *
 * Plain `.ts` (no JSX) like the rest of the kit's components, so the markup
 * can be rendered in vitest, which cannot transform JSX in this app.
 */

import { createElement, type ReactElement, type SVGProps } from "react";

/** One stroked shape inside an icon. */
export interface IconShape {
  readonly tag: "path" | "circle";
  readonly attrs: Readonly<Record<string, string | number>>;
}

/**
 * Status icons. Their silhouettes differ on purpose (three statuses share one
 * colour, and colour is never the only signal):
 *
 * - `circle` ○ hollow ring: nothing has happened yet
 * - `eye` 👁 outline: someone is looking
 * - `check` ✓ tick: reviewers agree
 * - `alert` ⚠ triangle: something is in dispute
 * - `pencil` ✎ pencil: edited after publication
 * - `ban` ⊘ ring with a bar: withdrawn
 * - `update` ⤒ arrow up to a bar: something newer sits above this one
 * - `tombstone` ⌢ arch slab: the content is gone, the marker stays
 */
export const ICON_SHAPES = {
  circle: [{ tag: "circle", attrs: { cx: 8, cy: 8, r: 5.25 } }],
  eye: [
    {
      tag: "path",
      attrs: {
        d: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z",
      },
    },
    { tag: "circle", attrs: { cx: 8, cy: 8, r: 1.75 } },
  ],
  check: [{ tag: "path", attrs: { d: "M3 8.5l3.25 3.25L13 4.75" } }],
  alert: [
    { tag: "path", attrs: { d: "M8 2.25 14.5 13.25H1.5L8 2.25Z" } },
    { tag: "path", attrs: { d: "M8 6.5v3" } },
    // A zero-length stroke with a round cap draws the dot of the "!".
    { tag: "path", attrs: { d: "M8 11.5h.01" } },
  ],
  pencil: [
    { tag: "path", attrs: { d: "M11 2.5 13.5 5 5.25 13.25l-3 .5.5-3L11 2.5Z" } },
    { tag: "path", attrs: { d: "m9.25 4.25 2.5 2.5" } },
  ],
  ban: [
    { tag: "circle", attrs: { cx: 8, cy: 8, r: 5.25 } },
    { tag: "path", attrs: { d: "M4.29 4.29l7.42 7.42" } },
  ],
  update: [
    { tag: "path", attrs: { d: "M3.25 3h9.5" } },
    { tag: "path", attrs: { d: "M8 12.75V5" } },
    { tag: "path", attrs: { d: "M4.5 8.5 8 5l3.5 3.5" } },
  ],
  tombstone: [
    { tag: "path", attrs: { d: "M4.5 13.25v-5a3.5 3.5 0 0 1 7 0v5z" } },
    { tag: "path", attrs: { d: "M6.5 9.75h3" } },
  ],
  // An action icon rather than a status one: two sheets, the front one whole.
  copy: [
    {
      tag: "path",
      attrs: {
        d: "M6.75 5.25h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M5.25 10.25h-2.5a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 1 1.5 1.5v1.5",
      },
    },
  ],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICON_SHAPES;

export const ICON_NAMES = Object.keys(ICON_SHAPES) as IconName[];

/** Side length of the 16 × 16 icon grid. */
export const ICON_GRID = 16;

export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, "children" | "name"> {
  name: IconName;
}

/** A decorative icon: `aria-hidden`, not focusable, sized by CSS or `width`. */
export function Icon({ name, ...rest }: IconProps): ReactElement {
  return createElement(
    "svg",
    {
      width: ICON_GRID,
      height: ICON_GRID,
      ...rest,
      viewBox: `0 0 ${ICON_GRID} ${ICON_GRID}`,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: false,
    },
    ICON_SHAPES[name].map((shape, index) =>
      createElement(shape.tag, { key: index, ...shape.attrs }),
    ),
  );
}
