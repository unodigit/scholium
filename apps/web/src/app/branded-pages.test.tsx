// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Render `next/link` as a plain anchor: these are server-rendered screens, and
 * the test only needs the destination the reader would get.
 */
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => h("a", { href, ...rest }, children);
  return { default: Link };
});

import WebAuthLayout from "./(web-auth)/layout";
import ErrorPage from "./error";
import NotFound from "./not-found";

/*
 * `src/app` inherits Next's `jsx: "preserve"` from the root tsconfig, which
 * vitest cannot transform; these screens and their test therefore use
 * `createElement` (the same approach as the ui-kit's `.ts` components).
 */

afterEach(cleanup);

function follows(node: Element, other: Element): boolean {
  return Boolean(
    node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

const signInCard = createElement("section", {
  className: "wa-card",
  "aria-label": "Sign in form",
});

/* ---------------------------------------------------------------------------
   Entry screens — /signin, /onboarding, /recover
   ------------------------------------------------------------------------- */

describe("the web-auth layout", () => {
  it("shows the large BrandLogo lockup above the card", () => {
    const { container } = render(
      createElement(WebAuthLayout, null, signInCard),
    );

    const main = container.querySelector("main.wa-shell");
    expect(main).not.toBeNull();

    const logo = screen.getByRole("img", { name: "Scholium" });
    expect(logo.getAttribute("data-size")).toBe("lg");
    expect(logo.textContent).toContain("scholium");

    const card = screen.getByRole("region", { name: "Sign in form" });
    expect(follows(logo, card)).toBe(true);
  });

  it("carries the one-line tagline under the lockup", () => {
    render(createElement(WebAuthLayout, null, signInCard));

    const tagline = screen.getByText("Signed, open preprints and peer review");
    const logo = screen.getByRole("img", { name: "Scholium" });
    expect(follows(logo, tagline)).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
   Root not-found
   ------------------------------------------------------------------------- */

describe("the root not-found page", () => {
  it("shows the glyph, a plain heading and ways back", () => {
    const { container } = render(createElement(NotFound));

    const mark = screen.getByRole("img", { name: "Scholium" });
    expect(mark.getAttribute("data-variant")).toBe("glyph");

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "We couldn't find that page.",
    });
    expect(follows(mark, heading)).toBe(true);

    const home = screen.getByRole("link", { name: "Home" });
    const search = screen.getByRole("link", { name: "Search" });
    expect(home.getAttribute("href")).toBe("/");
    expect(search.getAttribute("href")).toBe("/search");

    expect(container.querySelector("main.wa-shell")).not.toBeNull();
    expect(
      screen.queryByText("Signed, open preprints and peer review"),
    ).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
   Root error boundary
   ------------------------------------------------------------------------- */

describe("the root error page", () => {
  it("shows the glyph, a calm heading and recovery actions", () => {
    const reset = vi.fn();
    render(
      createElement(ErrorPage, { error: new Error("render failed"), reset }),
    );

    const mark = screen.getByRole("img", { name: "Scholium" });
    expect(mark.getAttribute("data-variant")).toBe("glyph");

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Something went wrong on our side.",
    });
    expect(follows(mark, heading)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);

    expect(
      screen.getByRole("link", { name: "Home" }).getAttribute("href"),
    ).toBe("/");
  });

  it("shows the server digest in monospace for support", () => {
    const error = Object.assign(new Error("render failed"), {
      digest: "1830429318",
    });
    render(createElement(ErrorPage, { error, reset: vi.fn() }));

    expect(screen.getByText(/Support reference:/)).toBeTruthy();
    const digest = screen.getByText("1830429318");
    expect(digest.tagName.toLowerCase()).toBe("code");
  });

  it("omits the support reference when there is no digest", () => {
    render(
      createElement(ErrorPage, {
        error: new Error("render failed"),
        reset: vi.fn(),
      }),
    );

    expect(screen.queryByText(/Support reference:/)).toBeNull();
  });
});
