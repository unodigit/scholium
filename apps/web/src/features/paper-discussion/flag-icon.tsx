/**
 * A flag, for the Report action. The shared icon set (`ui-kit/icons`) has no
 * flag, and that set belongs to another feature, so this one is drawn here on
 * the same 16 px grid with the same stroke so it sits beside `Icon` unnoticed.
 *
 * Decorative: the button beside it carries the words.
 */

import type { SVGProps } from "react";

export function FlagIcon(props: Omit<SVGProps<SVGSVGElement>, "children">) {
  return (
    <svg
      width={16}
      height={16}
      {...props}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <path d="M4 14V2.5" />
      <path d="M4 3h8l-1.75 3L12 9H4" />
    </svg>
  );
}
