// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  citationUrl,
  withCitationUrl,
  type CiteFormatId,
  type LoadCitation,
} from "./cite";
import { CITE_DIALOG_TITLE, COPIED_FOR_MS, CiteDialog } from "./cite-dialog";
import { BIBTEX_BODY, RIS_BODY, SHORT_ID } from "./paper-page-fixtures";

/**
 * The Cite dialog: a link until the page runs, then a button that opens a modal
 * with BibTeX and RIS, each read from the node and copied with a click. The
 * loader and the clipboard are stubbed, so every state (loading, ready, failed,
 * copied, refused) is reached without a node or a browser.
 */

const HREF = "http://node.test/v1/papers/sch%3A6sel-2dio-orm6/v2/cite?format=bibtex";

const TEXT: Record<CiteFormatId, string> = { bibtex: BIBTEX_BODY, ris: RIS_BODY };

/** What the dialog shows once the canonical web address is added. */
const CITED: Record<CiteFormatId, string> = {
  bibtex: withCitationUrl(BIBTEX_BODY, "bibtex", citationUrl(SHORT_ID, 2)),
  ris: withCitationUrl(RIS_BODY, "ris", citationUrl(SHORT_ID, 2)),
};

/** A loader that answers at once with each format's text. */
function answering(): ReturnType<typeof vi.fn<LoadCitation>> {
  return vi.fn<LoadCitation>(async (_id, _version, format) => TEXT[format]);
}

/** A loader whose answers the test settles by hand. */
function pending() {
  const settle: Record<string, { resolve: (text: string) => void; reject: (error: unknown) => void }> = {};
  const load = vi.fn<LoadCitation>(
    (_id, _version, format) =>
      new Promise<string>((resolve, reject) => {
        settle[format] = { resolve, reject };
      }),
  );
  return { load, settle };
}

function show(load: LoadCitation = answering()) {
  return render(<CiteDialog paperId={SHORT_ID} version={2} href={HREF} load={load} />);
}

const trigger = () => screen.getByRole("button", { name: "Cite" });
const dialog = () => screen.getByRole("dialog");
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLTextAreaElement;

/** Open the dialog and wait for both citations to be on screen. */
async function openReady(load: LoadCitation = answering()): Promise<void> {
  show(load);
  fireEvent.click(trigger());
  await waitFor(() => expect(field("RIS")).toBeTruthy());
}

function stubClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const write = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
  return write;
}

beforeEach(() => {
  document.body.style.overflow = "";
});

afterEach(() => {
  cleanup();
  // Markup the tests wrote straight into the body is not React's to clean up.
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  document.body.style.overflow = "";
});

describe("before the page runs", () => {
  it("is a link to the BibTeX that opens in a new tab", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <CiteDialog paperId={SHORT_ID} version={2} href={HREF} />,
    );

    const link = screen.getByRole("link", { name: /^Cite/ });
    expect(link.getAttribute("href")).toBe(HREF);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toContain("as BibTeX (opens in a new tab)");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("once the page runs", () => {
  it("is a button named Cite that says it opens a dialog", () => {
    show();

    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("link", { name: /^Cite/ })).toBeNull();
  });

  it("shows no dialog and asks the node for nothing until it is clicked", () => {
    const load = answering();
    show(load);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("opening", () => {
  it("opens a modal dialog named Cite this paper", async () => {
    await openReady();

    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: CITE_DIALOG_TITLE })).toBeTruthy();
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(CITE_DIALOG_TITLE);
  });

  it("says which version both entries name", async () => {
    await openReady();

    const description = dialog().getAttribute("aria-describedby") as string;
    expect(document.getElementById(description)?.textContent).toBe(
      `Both entries name the version on screen, ${SHORT_ID}/v2.`,
    );
  });

  it("moves focus into the dialog", async () => {
    await openReady();

    expect(document.activeElement).toBe(dialog());
  });

  it("asks the node for BibTeX and for RIS, for the version on screen", async () => {
    const load = answering();
    await openReady(load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith(SHORT_ID, 2, "bibtex");
    expect(load).toHaveBeenCalledWith(SHORT_ID, 2, "ris");
  });

  it("shows each citation with its canonical web address, keeping the node's fields", async () => {
    await openReady();

    expect(field("BibTeX").value).toBe(CITED.bibtex);
    expect(field("RIS").value).toBe(CITED.ris);
    expect(field("BibTeX").value).toContain("  eprint = {sch:6sel-2dio-orm6/v2},");
    expect(field("BibTeX").readOnly).toBe(true);
    expect(field("RIS").readOnly).toBe(true);
  });

  it("lists BibTeX before RIS, each under its own heading", async () => {
    await openReady();

    const headings = within(dialog()).getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["BibTeX", "RIS"]);
  });

  it("is rendered on the body, outside the header it was opened from", async () => {
    const { container } = show();
    fireEvent.click(trigger());

    expect(container.contains(dialog())).toBe(false);
    expect(document.body.contains(dialog())).toBe(true);
  });

  it("keeps the page behind from scrolling while it is open, and lets it scroll again after", async () => {
    document.body.style.overflow = "auto";
    await openReady();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).toBe("auto");
  });
});

describe("while the citations load", () => {
  it("says it is loading and offers nothing to copy yet", () => {
    const { load } = pending();
    show(load);
    fireEvent.click(trigger());

    expect(screen.getByText("Loading the BibTeX…")).toBeTruthy();
    expect(screen.getByText("Loading the RIS…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy BibTeX" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy RIS" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Download .bib" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Download .ris" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows one citation as soon as it arrives, without waiting for the other", async () => {
    const { load, settle } = pending();
    show(load);
    fireEvent.click(trigger());

    await act(async () => settle.ris.resolve(RIS_BODY));

    expect(field("RIS").value).toBe(CITED.ris);
    expect(screen.getByText("Loading the BibTeX…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy RIS" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Copy BibTeX" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops an answer that arrives after the dialog was closed", async () => {
    const { load, settle } = pending();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    show(load);
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });

    await act(async () => {
      settle.bibtex.resolve(BIBTEX_BODY);
      settle.ris.resolve(RIS_BODY);
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reads the citations again each time the dialog opens, so a retraction is never missed", async () => {
    const load = answering();
    show(load);

    fireEvent.click(trigger());
    await waitFor(() => expect(field("RIS")).toBeTruthy());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(load).toHaveBeenCalledTimes(2);

    fireEvent.click(trigger());
    await waitFor(() => expect(field("RIS")).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe("copying", () => {
  it("puts the BibTeX on the clipboard exactly as shown", async () => {
    const write = stubClipboard(async () => undefined);
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Copy BibTeX" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied BibTeX" })).toBeTruthy());
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(CITED.bibtex);
  });

  it("puts the RIS on the clipboard exactly as shown", async () => {
    const write = stubClipboard(async () => undefined);
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Copy RIS" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied RIS" })).toBeTruthy());
    expect(write).toHaveBeenCalledWith(CITED.ris);
  });

  it("says Copied for the one that was copied, and not for the other", async () => {
    stubClipboard(async () => undefined);
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Copy RIS" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied RIS" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Copy BibTeX" })).toBeTruthy();
  });

  it("announces the copy from inside the dialog, where a screen reader will hear it", async () => {
    stubClipboard(async () => undefined);
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Copy BibTeX" }));

    await waitFor(() =>
      expect(within(dialog()).getAllByRole("status").some((region) => region.textContent === "BibTeX copied to the clipboard.")).toBe(
        true,
      ),
    );
  });

  it("goes back to Copy after a moment", async () => {
    stubClipboard(async () => undefined);
    await openReady();
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy BibTeX" }));
    });
    expect(screen.getByRole("button", { name: "Copied BibTeX" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(COPIED_FOR_MS);
    });
    expect(screen.getByRole("button", { name: "Copy BibTeX" })).toBeTruthy();
  });

  it("never says Copied when the clipboard refuses, and says what to do instead", async () => {
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Copy BibTeX" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn’t copy. Select the text above and copy it by hand.");
    expect(screen.queryByRole("button", { name: /^Copied/ })).toBeNull();
    // The text is still there to select by hand.
    expect(field("BibTeX").value).toBe(CITED.bibtex);
  });
});

describe("downloading", () => {
  /** Stand in for the object-URL and anchor-click machinery jsdom lacks. */
  function stubDownloads() {
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return `blob:citation-${blobs.length}`;
      }),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn((url: string) => {
        revoked.push(url);
      }),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return { blobs, revoked, click };
  }

  it("offers Download .bib, saving the BibTeX as a plain-text sch-{id}-v{n}.bib file", async () => {
    const { blobs, revoked, click } = stubDownloads();
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Download .bib" }));

    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/plain;charset=utf-8");
    expect(await blobs[0].text()).toBe(CITED.bibtex);
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("sch-6sel-2dio-orm6-v2.bib");
    expect(revoked).toEqual(["blob:citation-1"]);
  });

  it("offers Download .ris, saving the RIS as sch-{id}-v{n}.ris", async () => {
    const { blobs, click } = stubDownloads();
    await openReady();

    fireEvent.click(screen.getByRole("button", { name: "Download .ris" }));

    expect(await blobs[0].text()).toBe(CITED.ris);
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(
      "sch-6sel-2dio-orm6-v2.ris",
    );
  });
});

describe("when a citation cannot be loaded", () => {
  const missing = new ApiError(404, { title: "Not Found", status: 404, detail: "No listed paper." });

  it("says why for that format, and still shows the other", async () => {
    show(
      vi.fn<LoadCitation>(async (_id, _version, format) => {
        if (format === "ris") throw new NetworkError("http://node.test/x");
        return TEXT[format];
      }),
    );
    fireEvent.click(trigger());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Couldn’t reach the server to load the RIS. Check your connection and try again.",
    );
    expect(field("BibTeX").value).toBe(CITED.bibtex);
    expect(screen.queryByRole("textbox", { name: "RIS" })).toBeNull();
    expect((screen.getByRole("button", { name: "Copy RIS" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says there is no citation when the node does not list the version", async () => {
    show(vi.fn<LoadCitation>(async () => Promise.reject(missing)));
    fireEvent.click(trigger());

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    for (const alert of screen.getAllByRole("alert")) {
      expect(alert.textContent).toContain("This server has no citation for that version.");
    }
  });

  it("copes with a loader that throws before it returns a promise", async () => {
    show(
      vi.fn<LoadCitation>(() => {
        throw new Error("boom");
      }),
    );
    fireEvent.click(trigger());

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0].textContent).toContain("The BibTeX could not be loaded. Try again.");
  });

  it("tries again for that format only", async () => {
    let attempts = 0;
    const load = vi.fn<LoadCitation>(async (_id, _version, format) => {
      if (format === "ris") {
        attempts += 1;
        if (attempts === 1) throw missing;
      }
      return TEXT[format];
    });
    show(load);
    fireEvent.click(trigger());
    await screen.findByRole("alert");
    expect(load).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Try again loading the RIS" }));

    await waitFor(() => expect(field("RIS").value).toBe(CITED.ris));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenLastCalledWith(SHORT_ID, 2, "ris");
  });
});

describe("closing", () => {
  it("closes with Escape and puts focus back on Cite", async () => {
    await openReady();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes with the Close button and puts focus back on Cite", async () => {
    await openReady();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when the scrim is pressed", async () => {
    await openReady();

    fireEvent.mouseDown(dialog().parentElement as HTMLElement);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("stays open when the press is inside the dialog, as when selecting text in a field", async () => {
    await openReady();

    fireEvent.mouseDown(field("BibTeX"));
    fireEvent.mouseDown(dialog());

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens again after it was closed", async () => {
    await openReady();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(trigger());

    expect(screen.getByRole("dialog", { name: CITE_DIALOG_TITLE })).toBeTruthy();
  });

  it("ignores Escape while it is closed", () => {
    show();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("keyboard", () => {
  it("keeps Tab inside the dialog: from the last control it goes to the first", async () => {
    await openReady();
    const close = within(dialog()).getByRole("button", { name: "Close" });
    const last = within(dialog()).getByRole("textbox", { name: "RIS" });
    last.focus();

    const prevented = !fireEvent.keyDown(last, { key: "Tab" });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it("keeps Shift+Tab inside the dialog: from the first control it goes to the last", async () => {
    await openReady();
    const close = within(dialog()).getByRole("button", { name: "Close" });
    close.focus();

    const prevented = !fireEvent.keyDown(close, { key: "Tab", shiftKey: true });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(within(dialog()).getByRole("textbox", { name: "RIS" }));
  });

  it("sends Shift+Tab from the dialog itself to its last control", async () => {
    await openReady();
    expect(document.activeElement).toBe(dialog());

    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(within(dialog()).getByRole("textbox", { name: "RIS" }));
  });

  it("lets Tab move on between controls inside the dialog", async () => {
    await openReady();
    const close = within(dialog()).getByRole("button", { name: "Close" });
    close.focus();

    const prevented = !fireEvent.keyDown(close, { key: "Tab" });

    expect(prevented).toBe(false);
  });

  it("holds focus on the dialog when nothing in it can take focus", () => {
    const { load } = pending();
    show(load);
    fireEvent.click(trigger());
    // Only Close is focusable while both citations load; take it away.
    within(dialog()).getByRole("button", { name: "Close" }).setAttribute("disabled", "");

    const prevented = !fireEvent.keyDown(dialog(), { key: "Tab" });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(dialog());
  });
});
