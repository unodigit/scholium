import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { BrandLogo, BrandMark } from "./index";

afterEach(cleanup);

describe("BrandMark", () => {
  it("renders the tile variant as an svg with accessible name", () => {
    render(createElement(BrandMark, { variant: "tile" }));
    const img = screen.getByRole("img", { name: "Scholium" });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(img.getAttribute("data-variant")).toBe("tile");
  });

  it("renders the glyph variant", () => {
    render(createElement(BrandMark, { variant: "glyph" }));
    const img = screen.getByRole("img", { name: "Scholium" });
    expect(img.getAttribute("data-variant")).toBe("glyph");
  });

  it("hides decorative parts", () => {
    const { container } = render(createElement(BrandMark, { variant: "tile" }));
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("applies size data attribute and height", () => {
    const { container } = render(createElement(BrandMark, { size: "lg" }));
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-size")).toBe("lg");
    expect(root.style.height).toBe("48px");
  });
});

describe("BrandLogo", () => {
  it("renders the lockup with wordmark", () => {
    render(createElement(BrandLogo, {}));
    expect(screen.getByRole("img", { name: "Scholium" })).toBeTruthy();
    expect(screen.getByText("scholium")).toBeTruthy();
  });

  it("renders only the mark when markOnly", () => {
    render(createElement(BrandLogo, { markOnly: true }));
    expect(screen.getByRole("img", { name: "Scholium" })).toBeTruthy();
    expect(screen.queryByText("scholium")).toBeNull();
  });
});
