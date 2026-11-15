import { describe, expect, it } from "vitest";

import {
  MAX_CANVAS_PIXELS,
  MAX_PIXEL_RATIO,
  describePdfError,
  isRenderCancelled,
  planPageRender,
} from "./pdf-render";

/** An error the way PDF.js builds one: an object with a name and fields. */
function pdfjsError(name: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`internal ${name} detail`), { name, ...fields });
}

describe("planPageRender", () => {
  const letter = { pageWidth: 612, pageHeight: 792 };

  it("fits the page to the container's width", () => {
    const plan = planPageRender({ ...letter, containerWidth: 720, pixelRatio: 1 });

    expect(plan.width).toBe(720);
    expect(plan.height).toBe(Math.floor(792 * (720 / 612)));
    expect(plan.scale).toBeCloseTo(720 / 612);
  });

  it("draws at the screen's pixel ratio, so a dense screen is sharp", () => {
    const plan = planPageRender({ ...letter, containerWidth: 720, pixelRatio: 2 });

    expect(plan.width).toBe(1440);
    expect(plan.scale).toBeCloseTo((720 / 612) * 2);
  });

  it("does not draw for more than the highest ratio", () => {
    const plan = planPageRender({ ...letter, containerWidth: 720, pixelRatio: 4 });

    expect(plan.width).toBe(720 * MAX_PIXEL_RATIO);
  });

  it("never draws below one pixel per pixel, whatever the screen says", () => {
    for (const pixelRatio of [0, -1, 0.5, Number.NaN]) {
      const plan = planPageRender({ ...letter, containerWidth: 720, pixelRatio });
      expect(plan.width).toBe(720);
    }
  });

  it("draws a huge page smaller rather than asking for a canvas the browser would refuse", () => {
    // A poster: 5 m × 7 m in points, in a 720 px column at ratio 2.
    const plan = planPageRender({
      pageWidth: 14_000,
      pageHeight: 20_000,
      containerWidth: 720,
      pixelRatio: 2,
    });

    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    // Still the page's shape.
    expect(plan.width / plan.height).toBeCloseTo(14_000 / 20_000, 2);
    expect(plan.width).toBeGreaterThan(0);
  });

  it("leaves a page that fits under the cap alone", () => {
    const plan = planPageRender({ ...letter, containerWidth: 720, pixelRatio: 2 });

    expect(plan.width * plan.height).toBeLessThan(MAX_CANVAS_PIXELS);
  });

  it("falls back to the page's own width for a container that is not laid out yet", () => {
    const plan = planPageRender({ ...letter, containerWidth: 0, pixelRatio: 1 });

    expect(plan.width).toBe(612);
    expect(plan.height).toBe(792);
  });

  it("always gives a drawable canvas, even for a page that reports no size", () => {
    const plan = planPageRender({
      pageWidth: 0,
      pageHeight: Number.NaN,
      containerWidth: 720,
      pixelRatio: 1,
    });

    expect(plan.width).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThan(0);
    expect(Number.isFinite(plan.scale)).toBe(true);
  });
});

describe("describePdfError", () => {
  it("says the server no longer has a PDF it answers 404 for", () => {
    expect(describePdfError(pdfjsError("ResponseException", { status: 404 }))).toBe(
      "This server no longer has the PDF.",
    );
  });

  it("says the same for a PDF PDF.js reports as missing, and for 410", () => {
    expect(describePdfError(pdfjsError("ResponseException", { missing: true }))).toBe(
      "This server no longer has the PDF.",
    );
    expect(describePdfError(pdfjsError("ResponseException", { status: 410 }))).toBe(
      "This server no longer has the PDF.",
    );
  });

  it("says the server could not send it for any other bad answer, or none", () => {
    for (const status of [403, 500, 503, 0]) {
      expect(describePdfError(pdfjsError("ResponseException", { status }))).toBe(
        "The server could not send the PDF.",
      );
    }
  });

  it("says a file that is not a PDF is not one", () => {
    expect(describePdfError(pdfjsError("InvalidPDFException"))).toBe(
      "This file is not a PDF the viewer can read.",
    );
  });

  it("says a password-protected PDF cannot be shown", () => {
    expect(describePdfError(pdfjsError("PasswordException", { code: 1 }))).toBe(
      "This PDF is password-protected, so it cannot be shown here.",
    );
  });

  it("does not repeat a developer's message: anything else is one plain sentence", () => {
    for (const error of [
      pdfjsError("UnknownErrorException"),
      new TypeError("Promise.withResolvers is not a function"),
      "a string",
      null,
      undefined,
    ]) {
      expect(describePdfError(error)).toBe("The PDF could not be shown here.");
    }
  });

  it("reads a rebuilt error, which is a plain object with a name, as it reads a real one", () => {
    expect(describePdfError({ name: "InvalidPDFException" })).toBe(
      "This file is not a PDF the viewer can read.",
    );
  });
});

describe("isRenderCancelled", () => {
  it("is true for PDF.js's cancelled-render exception", () => {
    expect(isRenderCancelled(pdfjsError("RenderingCancelledException"))).toBe(true);
    expect(isRenderCancelled({ name: "RenderingCancelledException" })).toBe(true);
  });

  it("is false for a failure", () => {
    expect(isRenderCancelled(new Error("boom"))).toBe(false);
    expect(isRenderCancelled(pdfjsError("InvalidPDFException"))).toBe(false);
    expect(isRenderCancelled(null)).toBe(false);
  });
});
