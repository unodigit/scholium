// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakePdf } from "./pdf-fixtures";
import type { LoadPdfjs } from "./pdf-render";
import {
  PDF_HASH,
  ReadingViewLink,
  ReadingViewProvider,
  ReadingViews,
  viewFromHash,
} from "./reading-view";

/**
 * Which rendition the reading column shows, and the header actions that choose
 * it. The PDF action is a link first (a file, in a new tab) and only a plain
 * click on a wide screen turns it into "show the PDF here"; these tests cover
 * both lives of that link, the address that names a view, and the promise that
 * the HTML is never thrown away.
 */

const PDF_URL = "http://localhost:8000/v1/content/bafkrei-pdf";

interface HarnessProps {
  readonly pdfAvailable?: boolean;
  readonly loadPdf?: LoadPdfjs;
}

/** The three pieces as the page puts them: two actions, and the column's body. */
function Harness({ pdfAvailable = true, loadPdf }: HarnessProps) {
  return (
    <ReadingViewProvider pdfAvailable={pdfAvailable}>
      <ReadingViewLink view="pdf" className="action" href={PDF_URL}>
        PDF
      </ReadingViewLink>
      <ReadingViewLink view="html" className="action" href="#reading">
        HTML
      </ReadingViewLink>
      <ReadingViews pdfUrl={pdfAvailable ? PDF_URL : null} loadPdf={loadPdf}>
        <p>The paper's text</p>
        <textarea aria-label="Draft annotation" />
      </ReadingViews>
    </ReadingViewProvider>
  );
}

const pdfLink = () => screen.getByRole("link", { name: /^PDF/ });
const htmlLink = () => screen.getByRole("link", { name: /^HTML/ });
const textBody = () => screen.getByText("The paper's text").parentElement as HTMLElement;
const pdfRegion = () => screen.queryByRole("region", { name: "PDF of this version", hidden: true });

/** Let the effects and promises already started settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A `matchMedia` for one query whose answer the test can change. */
function stubScreen(matches: boolean): { set(next: boolean): void } {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    set(next) {
      act(() => {
        query.matches = next;
        listeners.forEach((listener) => listener());
      });
    },
  };
}

/**
 * Click a link and report whether the page took the click over (prevented the
 * browser's own handling). jsdom cannot navigate to a file, so after the
 * page's handler has had its say a document-level listener stops it trying.
 */
function click(
  element: Element,
  init: MouseEventInit = {},
): { takenOver: boolean } {
  let takenOver = false;
  const observe = (event: Event) => {
    takenOver = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", observe);
  fireEvent.click(element, init);
  document.removeEventListener("click", observe);
  return { takenOver };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/p/6sel-2dio-orm6");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("viewFromHash", () => {
  it("names the PDF by #pdf and the HTML by #reading", () => {
    expect(viewFromHash("#pdf")).toBe("pdf");
    expect(viewFromHash("#reading")).toBe("html");
  });

  it("ignores case and the leading #", () => {
    expect(viewFromHash("PDF")).toBe("pdf");
    expect(viewFromHash("#Reading")).toBe("html");
  });

  it("names no view for any other fragment: a tab, a paragraph, nothing", () => {
    for (const hash of ["", "#", "#proof", "#reviews", "#p-abc123", "#pdfs", "#pdf-1"]) {
      expect(viewFromHash(hash)).toBeNull();
    }
  });

  it("agrees with the constant the PDF is shown at", () => {
    expect(viewFromHash(PDF_HASH)).toBe("pdf");
  });
});

describe("the page as the server sends it", () => {
  it("starts on the HTML: it is the current view, and the PDF is not", () => {
    render(<Harness />);

    expect(htmlLink().getAttribute("aria-current")).toBe("true");
    expect(pdfLink().hasAttribute("aria-current")).toBe(false);
    expect(textBody().hidden).toBe(false);
  });

  it("sends the text, visible, in the first HTML, and no PDF", () => {
    const html = renderToStaticMarkup(<Harness />);

    expect(html).toContain("The paper&#x27;s text");
    expect(html).not.toMatch(/<div class="ppg-view" hidden/);
    expect(html).not.toContain("PDF of this version");
  });

  it("does not fetch PDF.js, or mount the PDF, until it is asked for", () => {
    const loadPdf = vi.fn<LoadPdfjs>(() => new Promise(() => {}));
    render(<Harness loadPdf={loadPdf} />);

    expect(loadPdf).not.toHaveBeenCalled();
    expect(pdfRegion()).toBeNull();
  });

  it("keeps the PDF action a link to the file, opening in a new tab", () => {
    render(<Harness />);

    expect(pdfLink().getAttribute("href")).toBe(PDF_URL);
    expect(pdfLink().getAttribute("target")).toBe("_blank");
    expect(pdfLink().getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps the HTML action a link to the reading column", () => {
    render(<Harness />);

    expect(htmlLink().getAttribute("href")).toBe("#reading");
  });
});

describe("choosing the PDF", () => {
  it("shows the PDF in the column on a plain click, instead of opening the file", async () => {
    const pdf = fakePdf();
    render(<Harness loadPdf={pdf.loadPdf} />);

    const { takenOver } = click(pdfLink());

    expect(takenOver).toBe(true);
    expect(pdfRegion()).not.toBeNull();
    await waitFor(() => expect(pdf.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: PDF_URL }),
    ));
  });

  it("marks the PDF as the current view, and not the HTML", () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);

    click(pdfLink());

    expect(pdfLink().getAttribute("aria-current")).toBe("true");
    expect(htmlLink().hasAttribute("aria-current")).toBe(false);
  });

  it("hides the HTML rather than removing it", () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    const body = textBody();

    click(pdfLink());

    expect(textBody()).toBe(body);
    expect(textBody().hidden).toBe(true);
  });

  it("puts the view in the address, replacing the entry so back leaves the paper", () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    const entries = window.history.length;

    click(pdfLink());

    expect(window.location.hash).toBe("#pdf");
    expect(window.history.length).toBe(entries);
    expect(window.location.pathname).toBe("/p/6sel-2dio-orm6");
  });

  it("tells a screen-reader user what the link will do, once it can", async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(pdfLink().textContent).toContain("shows the PDF on this page");
    });
  });

  it("tells them it opens a new tab in the server's HTML, which has not run any effect", () => {
    // `render` runs effects before it returns; the server's markup is what
    // there is before any run, and the first client render must match it.
    const html = renderToStaticMarkup(<Harness />);

    expect(html).toContain("PDF<span");
    expect(html).toContain("(opens in a new tab)");
    expect(html).not.toContain("shows the PDF");
  });
});

describe("a click that is not a plain click", () => {
  it.each([
    ["ctrl-click (new tab)", { ctrlKey: true }],
    ["cmd-click (new tab)", { metaKey: true }],
    ["shift-click (new window)", { shiftKey: true }],
    ["alt-click (save)", { altKey: true }],
    ["middle-click (new tab)", { button: 1 }],
    ["right-click", { button: 2 }],
  ])("is left to the browser: %s", (_name, init) => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);

    const { takenOver } = click(pdfLink(), init);

    expect(takenOver).toBe(false);
    expect(pdfRegion()).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

describe("a phone", () => {
  it("opens the PDF in the device's viewer: the click is left to the browser", () => {
    stubScreen(true);
    render(<Harness loadPdf={fakePdf().loadPdf} />);

    const { takenOver } = click(pdfLink());

    expect(takenOver).toBe(false);
    expect(pdfRegion()).toBeNull();
  });

  it("says so in the link's words", async () => {
    stubScreen(true);
    render(<Harness />);
    await settle();

    expect(pdfLink().textContent).toContain("opens in a new tab");
    expect(pdfLink().textContent).not.toContain("shows the PDF");
  });

  it("does not show the PDF for an address that names it", async () => {
    stubScreen(true);
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#pdf");
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    await settle();

    expect(pdfRegion()).toBeNull();
    expect(htmlLink().getAttribute("aria-current")).toBe("true");
  });

  it("follows the window as it is resized", async () => {
    const media = stubScreen(true);
    render(<Harness />);
    await settle();
    expect(pdfLink().textContent).toContain("opens in a new tab");

    media.set(false);

    expect(pdfLink().textContent).toContain("shows the PDF on this page");
  });
});

describe("going back to the HTML", () => {
  it("shows the HTML again when the HTML action is followed", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    click(pdfLink());
    expect(textBody().hidden).toBe(true);

    // A native fragment link: the browser sets the address, the page follows it.
    act(() => {
      window.location.hash = "#reading";
    });

    await waitFor(() => expect(textBody().hidden).toBe(false));
    expect(htmlLink().getAttribute("aria-current")).toBe("true");
    expect(pdfLink().hasAttribute("aria-current")).toBe(false);
  });

  it("keeps a half-written annotation through a look at the PDF", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    fireEvent.change(screen.getByLabelText("Draft annotation"), {
      target: { value: "The proof skips n = 0" },
    });

    click(pdfLink());
    act(() => {
      window.location.hash = "#reading";
    });
    await waitFor(() => expect(textBody().hidden).toBe(false));

    expect((screen.getByLabelText("Draft annotation") as HTMLTextAreaElement).value).toBe(
      "The proof skips n = 0",
    );
  });

  it("does not fetch the PDF again when it is chosen a second time", async () => {
    const pdf = fakePdf();
    render(<Harness loadPdf={pdf.loadPdf} />);

    click(pdfLink());
    await screen.findAllByRole("img");
    act(() => {
      window.location.hash = "#reading";
    });
    await waitFor(() => expect(textBody().hidden).toBe(false));
    click(pdfLink());
    await settle();

    expect(pdf.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfRegion()).not.toBeNull();
  });

  it("hides the PDF, without unmounting it, while the HTML shows", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    click(pdfLink());
    await screen.findAllByRole("img");
    const region = screen.getByRole("region", { name: "PDF of this version" });

    act(() => {
      window.location.hash = "#reading";
    });

    await waitFor(() => expect(region.parentElement?.hidden).toBe(true));
    expect(pdfRegion()).toBe(region);
  });

  it("shows the HTML again on going back to an address with no fragment", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    click(pdfLink());
    expect(textBody().hidden).toBe(true);

    // What the back button does: the address loses its fragment, and the page
    // is told the fragment changed.
    act(() => {
      window.history.replaceState(null, "", "/p/6sel-2dio-orm6");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    await waitFor(() => expect(textBody().hidden).toBe(false));
  });
});

describe("an address that names a view", () => {
  it("shows the PDF on arrival at #pdf", async () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#pdf");
    const pdf = fakePdf();
    render(<Harness loadPdf={pdf.loadPdf} />);

    await waitFor(() => expect(pdfRegion()).not.toBeNull());
    expect(pdfLink().getAttribute("aria-current")).toBe("true");
    expect(textBody().hidden).toBe(true);
  });

  it("shows the HTML on arrival at #reading", () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#reading");
    render(<Harness loadPdf={fakePdf().loadPdf} />);

    expect(textBody().hidden).toBe(false);
    expect(pdfRegion()).toBeNull();
  });

  it("follows a link to #pdf that is followed after arrival", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);

    act(() => {
      window.location.hash = "#pdf";
    });

    await waitFor(() => expect(pdfRegion()).not.toBeNull());
    expect(textBody().hidden).toBe(true);
  });

  it("leaves the view alone for a fragment that is not a view", async () => {
    render(<Harness loadPdf={fakePdf().loadPdf} />);
    click(pdfLink());
    expect(textBody().hidden).toBe(true);

    for (const hash of ["#proof", "#reviews", "#p-abc123"]) {
      act(() => {
        window.location.hash = hash;
      });
      await settle();
      expect(textBody().hidden).toBe(true);
    }
  });

  it("stays on the HTML when the address names a PDF this version does not have", async () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#pdf");
    render(<Harness pdfAvailable={false} />);
    await settle();

    expect(textBody().hidden).toBe(false);
    expect(pdfRegion()).toBeNull();
  });
});

describe("a version with no PDF", () => {
  it("never shows a PDF view, and never mounts one", async () => {
    const loadPdf = vi.fn<LoadPdfjs>(() => new Promise(() => {}));
    render(<Harness pdfAvailable={false} loadPdf={loadPdf} />);

    act(() => {
      window.location.hash = "#pdf";
    });
    await settle();

    expect(loadPdf).not.toHaveBeenCalled();
    expect(textBody().hidden).toBe(false);
  });
});

describe("outside a provider", () => {
  it("is the static page: the HTML shows and the PDF action is only a link", () => {
    render(
      <>
        <ReadingViewLink view="pdf" className="action" href={PDF_URL}>
          PDF
        </ReadingViewLink>
        <ReadingViewLink view="html" className="action" href="#reading">
          HTML
        </ReadingViewLink>
        <ReadingViews pdfUrl={PDF_URL}>
          <p>The paper's text</p>
        </ReadingViews>
      </>,
    );

    expect(htmlLink().getAttribute("aria-current")).toBe("true");
    const { takenOver } = click(pdfLink());
    expect(takenOver).toBe(false);
    expect(screen.getByText("The paper's text").parentElement?.hidden).toBe(false);
    expect(pdfRegion()).toBeNull();
  });
});
