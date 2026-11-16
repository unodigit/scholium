// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The layout asks Next for `notFound()`; outside Next there is no request to
// answer, so stand in for the control-flow error it throws.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import { notFound } from "next/navigation";

import UiKitLayout from "./layout";

const notFoundMock = vi.mocked(notFound);
const children = createElement("p", null, "a demo");

afterEach(() => {
  vi.unstubAllEnvs();
  notFoundMock.mockClear();
});

describe("the UI-kit gallery", () => {
  it("renders every component gallery in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    const html = renderToStaticMarkup(UiKitLayout({ children }));

    expect(html).toContain("Status chip");
    expect(html).toContain("Verify badge");
    expect(html).toContain("a demo");
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("answers 404 in a production build instead of shipping the demos", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => UiKitLayout({ children })).toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
