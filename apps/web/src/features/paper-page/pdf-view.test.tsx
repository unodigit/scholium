// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakePdf } from "./pdf-fixtures";
import type { LoadPdfjs } from "./pdf-render";
import { PdfView } from "./pdf-view";

/**
 * The PDF view draws the version's PDF with PDF.js. jsdom has no canvas and the
 * real PDF.js needs a browser, so these tests give the viewer a fake PDF.js
 * (`pdf-fixtures.ts`) and check what the viewer asks of it and what the reader
 * is shown: the pages in their places, drawn as they come near, and one plain
 * sentence, with a way out, when it cannot.
 */

const URL_OF_PDF = "http://localhost:8000/v1/content/bafkrei-pdf";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Let every promise already in flight settle, and the renders they cause. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** An `IntersectionObserver` the test drives by hand. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly observed: Element[] = [];
  readonly disconnect = vi.fn();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  /** Tell the page's observer its page is (or is not) near the viewport. */
  reach(element: Element, isIntersecting = true): void {
    act(() => {
      this.callback(
        [{ target: element, isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

function stubObserver(): void {
  FakeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
}

/**
 * The page's observer, once React has attached it. The pages appear as the
 * document resolves, and their effect may land a tick after the query that
 * finds them, so wait for it rather than assuming it is already there.
 */
async function observerOf(page: number): Promise<FakeObserver> {
  const element = pageElement(page);
  return waitFor(() => {
    const observer = FakeObserver.instances.find((candidate) =>
      candidate.observed.includes(element),
    );
    if (observer === undefined) {
      throw new Error(`no observer on page ${page}`);
    }
    return observer;
  });
}

function pageElement(page: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(`li[data-page="${page}"]`);
  if (element === null) {
    throw new Error(`no page ${page}`);
  }
  return element;
}

describe("PdfView: loading", () => {
  it("says it is loading, and already offers the file in a new tab", () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={() => new Promise(() => {})} />);

    expect(screen.getByRole("status").textContent).toBe("Loading the PDF…");
    const link = screen.getByRole("link", { name: "Open in a new tab" });
    expect(link.getAttribute("href")).toBe(URL_OF_PDF);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("is a region of its own, named for what it shows", () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={() => new Promise(() => {})} />);

    expect(screen.getByRole("region", { name: "PDF of this version" })).toBeTruthy();
  });

  it("asks PDF.js for the file at the url, with eval off for an untrusted upload", async () => {
    const pdf = fakePdf();
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    await screen.findAllByRole("img");

    expect(pdf.getDocument).toHaveBeenCalledTimes(1);
    expect(pdf.getDocument).toHaveBeenCalledWith({ url: URL_OF_PDF, isEvalSupported: false });
  });

  it("does not load PDF.js until it is rendered", () => {
    const loadPdf = vi.fn<LoadPdfjs>(() => new Promise(() => {}));

    expect(loadPdf).not.toHaveBeenCalled();
    render(<PdfView url={URL_OF_PDF} loadPdf={loadPdf} />);
    expect(loadPdf).toHaveBeenCalledTimes(1);
  });
});

describe("PdfView: the pages", () => {
  it("gives every page a canvas, announced as 'Page n of N'", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 3 }).loadPdf} />);

    const canvases = await screen.findAllByRole("img");

    expect(canvases.map((canvas) => canvas.getAttribute("aria-label"))).toEqual([
      "Page 1 of 3",
      "Page 2 of 3",
      "Page 3 of 3",
    ]);
  });

  it("lists the pages as a list, in order", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 3 }).loadPdf} />);
    await screen.findAllByRole("img");

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-page"))).toEqual(["1", "2", "3"]);
  });

  it("says how many pages there are, and where the text is", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 12 }).loadPdf} />);

    expect(await screen.findByText(/12 pages/)).toBeTruthy();
    expect(screen.getByText(/the HTML view has the text/)).toBeTruthy();
  });

  it("says '1 page' for one page", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 1 }).loadPdf} />);

    expect(await screen.findByText(/^1 page ·/)).toBeTruthy();
  });

  it("draws each page onto its own canvas, at the size the plan gives", async () => {
    const pdf = fakePdf({ pages: 2, width: 600, height: 800 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2));

    const canvases = screen.getAllByRole("img") as HTMLCanvasElement[];
    const drawn = pdf.render.mock.calls.map(([call]) => call.canvas);
    expect(drawn).toEqual(canvases);
    // jsdom lays nothing out, so the container is as wide as the page itself
    // at one device pixel per pixel.
    expect(canvases[0].width).toBe(600);
    expect(canvases[0].height).toBe(800);
    expect(pdf.render.mock.calls[0][0].viewport).toEqual({ width: 600, height: 800 });
  });

  it("holds each page's place in the first page's shape until it is drawn", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 2 }).loadPdf} />);
    await screen.findAllByRole("img");

    // 612 / 792, to the precision a style attribute keeps.
    expect(pageElement(1).getAttribute("style")).toMatch(/aspect-ratio:\s*0\.77/);
    expect(pageElement(2).getAttribute("style")).toMatch(/aspect-ratio:\s*0\.77/);
  });
});

describe("PdfView: drawing pages as they come near", () => {
  it("draws nothing until a page comes near the viewport", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 3 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    expect(pdf.render).not.toHaveBeenCalled();
    expect(pdf.getPage).toHaveBeenCalledTimes(1); // the first page's shape, only
  });

  it("looks a screenful ahead, so a page is ready before the reader gets to it", async () => {
    stubObserver();
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 2 }).loadPdf} />);
    await screen.findAllByRole("img");

    expect((await observerOf(1)).options?.rootMargin).toBe("100% 0px");
  });

  it("draws a page when it comes near, and only that page", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 3 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    (await observerOf(2)).reach(pageElement(2));

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1));
    expect(pdf.render.mock.calls[0][0].canvas).toBe(
      pageElement(2).querySelector("canvas"),
    );
  });

  it("does not draw a page that is reported as not near", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 2 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    (await observerOf(1)).reach(pageElement(1), false);

    expect(pdf.render).not.toHaveBeenCalled();
  });

  it("draws a page once, however many times the reader scrolls within reach of it", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 2 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    const observer = await observerOf(1);
    observer.reach(pageElement(1));
    observer.reach(pageElement(1));
    observer.reach(pageElement(1));
    await settle();

    expect(pdf.render).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).not.toHaveBeenCalled();
  });

  it("lets go of a page's pixels once it is far away, but keeps its place", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 2, width: 600, height: 800 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");
    const canvas = pageElement(1).querySelector("canvas") as HTMLCanvasElement;
    const observer = await observerOf(1);

    observer.reach(pageElement(1));
    await waitFor(() => expect(canvas.width).toBe(600));
    observer.reach(pageElement(1), false);

    // A drawn page is megabytes: a canvas of no size holds none of them.
    await waitFor(() => expect(canvas.width).toBe(0));
    expect(canvas.height).toBe(0);
    // Still there, still its own shape, so nothing below it moves.
    expect(pageElement(1)).toBeTruthy();
    expect(pageElement(1).getAttribute("style")).toMatch(/aspect-ratio:\s*0\.75/);
  });

  it("stops a page that is still being drawn when it goes far away", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 1 });
    pdf.render.mockImplementation(() => ({
      promise: new Promise(() => {}),
      cancel: pdf.cancel,
    }));
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");
    const observer = await observerOf(1);

    observer.reach(pageElement(1));
    await waitFor(() => expect(pdf.render).toHaveBeenCalled());
    observer.reach(pageElement(1), false);

    await waitFor(() => expect(pdf.cancel).toHaveBeenCalledTimes(1));
  });

  it("draws a page again when the reader comes back to it", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 2, width: 600, height: 800 });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");
    const canvas = pageElement(1).querySelector("canvas") as HTMLCanvasElement;
    const observer = await observerOf(1);

    observer.reach(pageElement(1));
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1));
    observer.reach(pageElement(1), false);
    await waitFor(() => expect(canvas.width).toBe(0));
    observer.reach(pageElement(1));

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2));
    expect(canvas.width).toBe(600);
    expect(pdf.render.mock.calls[1][0].canvas).toBe(canvas);
  });

  it("tries a page that failed to draw again when the reader comes back to it", async () => {
    stubObserver();
    const pdf = fakePdf({ pages: 1 });
    let calls = 0;
    pdf.render.mockImplementation(() => {
      calls += 1;
      return {
        promise: calls === 1 ? Promise.reject(new Error("bad glyph")) : Promise.resolve(),
        cancel: pdf.cancel,
      };
    });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");
    const observer = await observerOf(1);

    observer.reach(pageElement(1));
    expect(await screen.findByText("This page could not be drawn.")).toBeTruthy();
    observer.reach(pageElement(1), false);
    observer.reach(pageElement(1));

    await waitFor(() => expect(screen.queryByText("This page could not be drawn.")).toBeNull());
    expect(pdf.render).toHaveBeenCalledTimes(2);
  });
});

describe("PdfView: when it cannot show the PDF", () => {
  it("says so when PDF.js cannot be loaded, and keeps the file one click away", async () => {
    render(
      <PdfView
        url={URL_OF_PDF}
        loadPdf={fakePdf({ importFails: new TypeError("Promise.withResolvers is not a function") }).loadPdf}
      />,
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "The PDF could not be shown here.",
    );
    expect(
      screen.getByRole("link", { name: "Open in a new tab" }).getAttribute("href"),
    ).toBe(URL_OF_PDF);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("says when the server no longer has the file", async () => {
    const pdf = fakePdf({
      loadFails: Object.assign(new Error("Missing PDF"), {
        name: "ResponseException",
        status: 404,
        missing: true,
      }),
    });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    expect((await screen.findByRole("status")).textContent).toBe(
      "This server no longer has the PDF.",
    );
  });

  it("says when the file is not a PDF", async () => {
    const pdf = fakePdf({
      loadFails: Object.assign(new Error("Invalid PDF structure."), {
        name: "InvalidPDFException",
      }),
    });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    expect((await screen.findByRole("status")).textContent).toBe(
      "This file is not a PDF the viewer can read.",
    );
  });

  it("treats a PDF with no pages as one it cannot read", async () => {
    render(<PdfView url={URL_OF_PDF} loadPdf={fakePdf({ pages: 0 }).loadPdf} />);

    expect((await screen.findByRole("status")).textContent).toBe(
      "This file is not a PDF the viewer can read.",
    );
  });

  it("does not show PDF.js's own message", async () => {
    const pdf = fakePdf({ loadFails: new Error("Unexpected token in XRef stream at 0x1f4a") });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    await screen.findByRole("status");

    expect(document.body.textContent).not.toContain("XRef");
  });

  it("tries again when asked, and shows the pages if it works this time", async () => {
    const failing = fakePdf({
      loadFails: Object.assign(new Error("x"), { name: "ResponseException", status: 503 }),
    });
    const working = fakePdf({ pages: 2 });
    let attempts = 0;
    const loadPdf: LoadPdfjs = () => {
      attempts += 1;
      return (attempts === 1 ? failing : working).loadPdf();
    };
    render(<PdfView url={URL_OF_PDF} loadPdf={loadPdf} />);
    expect((await screen.findByRole("status")).textContent).toBe(
      "The server could not send the PDF.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(attempts).toBe(2);
  });

  it("says which page could not be drawn, and still draws the others", async () => {
    const pdf = fakePdf({ pages: 2 });
    let calls = 0;
    pdf.render.mockImplementation(() => {
      calls += 1;
      return {
        promise: calls === 1 ? Promise.reject(new Error("bad glyph")) : Promise.resolve(),
        cancel: pdf.cancel,
      };
    });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2));

    const notes = await screen.findAllByText("This page could not be drawn.");
    expect(notes).toHaveLength(1);
    expect(pageElement(1).textContent).toContain("This page could not be drawn.");
    expect(pageElement(2).textContent).not.toContain("could not be drawn");
  });

  it("does not call a cancelled draw a failure", async () => {
    const pdf = fakePdf({
      pages: 1,
      renderFails: Object.assign(new Error("cancelled"), {
        name: "RenderingCancelledException",
      }),
    });
    render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);

    await waitFor(() => expect(pdf.render).toHaveBeenCalled());
    // The draw's rejection is handled a few ticks after it was started.
    await settle();

    expect(screen.queryByText("This page could not be drawn.")).toBeNull();
  });
});

describe("PdfView: leaving", () => {
  it("releases the file when it goes away", async () => {
    const pdf = fakePdf();
    const view = render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    view.unmount();

    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops a draw that is still going when it goes away", async () => {
    const pdf = fakePdf({ pages: 1 });
    pdf.render.mockImplementation(() => ({
      promise: new Promise(() => {}),
      cancel: pdf.cancel,
    }));
    const view = render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await waitFor(() => expect(pdf.render).toHaveBeenCalled());

    view.unmount();

    expect(pdf.cancel).toHaveBeenCalledTimes(1);
  });

  it("never asks PDF.js for a file the reader left before PDF.js had loaded", async () => {
    const pdf = fakePdf();
    let arrive: (pdfjs: Awaited<ReturnType<LoadPdfjs>>) => void = () => {};
    const slow: LoadPdfjs = () =>
      new Promise((resolve) => {
        arrive = resolve;
      });
    const view = render(<PdfView url={URL_OF_PDF} loadPdf={slow} />);

    view.unmount();
    arrive(await pdf.loadPdf());
    await settle();

    expect(pdf.getDocument).not.toHaveBeenCalled();
  });

  it("loads the new file when the address changes, and releases the old one", async () => {
    const pdf = fakePdf();
    const view = render(<PdfView url={URL_OF_PDF} loadPdf={pdf.loadPdf} />);
    await screen.findAllByRole("img");

    view.rerender(<PdfView url={`${URL_OF_PDF}-v3`} loadPdf={pdf.loadPdf} />);

    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalledTimes(2));
    expect(pdf.getDocument).toHaveBeenLastCalledWith({
      url: `${URL_OF_PDF}-v3`,
      isEvalSupported: false,
    });
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });
});
