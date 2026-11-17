"use client";

import Link from "next/link";
import { createElement } from "react";

import { BrandMark } from "../features/ui-kit/brand-mark";

import "./(web-auth)/web-auth.css";

/**
 * Root error boundary — the last resort when a page throws while rendering.
 *
 * `reset()` re-renders the segment, so "Try again" is the first action; Home
 * is the quiet way out. When the server supplies a digest, it is shown in
 * monospace under a plain label so a reader can quote it to support without
 * reading a stack trace.
 *
 * `src/app` inherits Next's `jsx: "preserve"`, so the markup is built with
 * `createElement` and stays renderable in vitest.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
        { className: "wa-card wa-fallback", "aria-labelledby": "error-heading" },
        createElement(
          "h1",
          { id: "error-heading", className: "wa-title" },
          "Something went wrong on our side.",
        ),
        createElement(
          "p",
          { className: "wa-lede" },
          "Nothing you did caused it. Try again; if it keeps happening, send the reference below to support.",
        ),
        createElement(
          "div",
          { className: "wa-actions" },
          createElement(
            "button",
            { className: "wa-button", type: "button", onClick: reset },
            "Try again",
          ),
          createElement(Link, { className: "wa-button wa-button--quiet", href: "/" }, "Home"),
        ),
        error.digest
          ? createElement(
              "p",
              { className: "wa-digest" },
              "Support reference: ",
              createElement("code", null, error.digest),
            )
          : null,
      ),
    ),
  );
}
