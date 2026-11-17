import { createElement } from "react";

import { BrandLogo } from "../../features/ui-kit/brand-logo";

import "./web-auth.css";

/**
 * Shared shell for the web-auth pages (`/signin`, `/onboarding`, …).
 *
 * `(web-auth)` is a route group: it adds this layout without adding a URL
 * segment, so the pages below it live at `/signin` and `/onboarding`.
 *
 * The brand lockup sits above the card on every entry screen — sign in,
 * onboarding, recovery and the email link — so the first thing a researcher
 * sees is the journal's own mark on the paper background, not a bare form.
 * The shell reads the app-wide tokens, so light and dark follow automatically.
 *
 * Written with `createElement` because this route group inherits Next's
 * `jsx: "preserve"` and has no nested tsconfig for vitest to transform.
 */
export default function WebAuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return createElement(
    "main",
    { className: "wa-shell" },
    createElement(
      "div",
      { className: "wa-frame" },
      createElement(
        "header",
        { className: "wa-brand" },
        createElement(BrandLogo, { size: "lg" }),
        createElement(
          "p",
          { className: "wa-tagline" },
          "Signed, open preprints and peer review",
        ),
      ),
      children,
    ),
  );
}
