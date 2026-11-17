import Link from "next/link";
import { createElement } from "react";

import { BrandMark } from "../features/ui-kit/brand-mark";

import "./(web-auth)/web-auth.css";

/**
 * Root 404 — shown for any URL the app does not know.
 *
 * It borrows the entry-screen shell so a wrong link still looks like Scholium
 * rather than a bare server page: the glyph, one plain sentence, and the two
 * ways we can actually help — Home and Search.
 *
 * `src/app` inherits Next's `jsx: "preserve"`, so the markup is built with
 * `createElement` and stays renderable in vitest.
 */
export default function NotFound() {
  return createElement(
    "main",
    { className: "wa-shell" },
    createElement(
      "div",
      { className: "wa-frame" },
      createElement(
        "div",
        { className: "wa-brand" },
        createElement(BrandMark, { variant: "glyph", size: "lg" }),
      ),
      createElement(
        "section",
        {
          className: "wa-card wa-fallback",
          "aria-labelledby": "not-found-heading",
        },
        createElement(
          "h1",
          { id: "not-found-heading", className: "wa-title" },
          "We couldn't find that page.",
        ),
        createElement(
          "p",
          { className: "wa-lede" },
          "The link may be broken, or the page may have moved. Search is the quickest way back to a paper.",
        ),
        createElement(
          "div",
          { className: "wa-actions" },
          createElement(Link, { className: "wa-button", href: "/" }, "Home"),
          createElement(
            Link,
            { className: "wa-button wa-button--quiet", href: "/search" },
            "Search",
          ),
        ),
      ),
    ),
  );
}
