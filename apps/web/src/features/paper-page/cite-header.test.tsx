// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { citationUrl, withCitationUrl } from "./cite";
import { PaperHeader } from "./paper-header";
import { loadPaperPageData, type PaperPageData } from "./paper-page-data";
import {
  BARE_ID,
  BIBTEX_BODY,
  HAPPY,
  PAPER_BODY,
  RIS_BODY,
  SHORT_ID,
  json,
  notFound,
  stubApi,
} from "./paper-page-fixtures";

/**
 * Cite and Download in the paper page's header (spec: "UI shows a Cite dialog
 * with BibTeX and RIS copied from GET /v1/papers/{id}/cite and a Download menu
 * with the paper archive"), end to end as far as the browser goes: the page
 * data is what the route really loads and the requests leave through the real
 * API client, so what these tests read off `fetch` is what the node receives.
 */

const NODE = "http://localhost:8000";

async function loadData(): Promise<PaperPageData> {
  return loadPaperPageData({ id: BARE_ID, version: null });
}

/** The calls the dialog made to the cite route, as `format → URL`. */
function citeCalls(fetchMock: ReturnType<typeof vi.fn>): Record<string, URL> {
  const calls: Record<string, URL> = {};
  for (const [input] of fetchMock.mock.calls) {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cite")) calls[url.searchParams.get("format") ?? ""] = url;
  }
  return calls;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

describe("the header's server HTML", () => {
  it("keeps Cite and Download as plain links, so the row works before any script runs", async () => {
    stubApi();
    document.body.innerHTML = renderToStaticMarkup(<PaperHeader data={await loadData()} />);

    const actions = screen.getByRole("group", { name: "Read, cite and download" });
    expect(within(actions).queryAllByRole("button")).toHaveLength(0);

    const cite = within(actions).getByRole("link", { name: /^Cite/ });
    expect(cite.getAttribute("href")).toBe(
      `${NODE}/v1/papers/${encodeURIComponent(SHORT_ID)}/v2/cite?format=bibtex`,
    );
    const download = within(actions).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(
      `${NODE}/v1/export/paper/${encodeURIComponent(SHORT_ID)}.car`,
    );
    expect(download.hasAttribute("download")).toBe(true);
  });

  it("does not render the dialog or the menu: there is nothing to open them", async () => {
    stubApi();
    const html = renderToStaticMarkup(<PaperHeader data={await loadData()} />);

    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="menu"');
  });
});

describe("the Cite dialog, opened from the header", () => {
  it("asks the node for the BibTeX and the RIS of the version on screen and shows both", async () => {
    const fetchMock = stubApi();
    render(<PaperHeader data={await loadData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Cite" }));

    const bibtex = (await screen.findByRole("textbox", { name: "BibTeX" })) as HTMLTextAreaElement;
    const ris = (await screen.findByRole("textbox", { name: "RIS" })) as HTMLTextAreaElement;
    expect(bibtex.value).toBe(
      withCitationUrl(BIBTEX_BODY, "bibtex", citationUrl(SHORT_ID, 2)),
    );
    expect(ris.value).toBe(withCitationUrl(RIS_BODY, "ris", citationUrl(SHORT_ID, 2)));

    const calls = citeCalls(fetchMock);
    expect(Object.keys(calls).sort()).toEqual(["bibtex", "ris"]);
    for (const url of Object.values(calls)) {
      expect(url.origin).toBe(NODE);
      expect(decodeURIComponent(url.pathname)).toBe(`/v1/papers/${SHORT_ID}/v2/cite`);
    }
  });

  it("copies the citation shown, with the canonical address added", async () => {
    stubApi();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PaperHeader data={await loadData()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    await screen.findByRole("textbox", { name: "RIS" });

    fireEvent.click(screen.getByRole("button", { name: "Copy RIS" }));
    await screen.findByRole("button", { name: "Copied RIS" });
    fireEvent.click(screen.getByRole("button", { name: "Copy BibTeX" }));
    await screen.findByRole("button", { name: "Copied BibTeX" });

    expect(writeText.mock.calls.map(([text]) => text)).toEqual([
      withCitationUrl(RIS_BODY, "ris", citationUrl(SHORT_ID, 2)),
      withCitationUrl(BIBTEX_BODY, "bibtex", citationUrl(SHORT_ID, 2)),
    ]);
  });

  it("cites the version in the address when it is not the newest", async () => {
    const fetchMock = stubApi({
      ...HAPPY,
      paper: (path) => {
        const n = Number(/\/v(\d+)$/.exec(path)?.[1] ?? 2);
        return json({ ...PAPER_BODY, n, version: n });
      },
    });
    render(<PaperHeader data={await loadPaperPageData({ id: BARE_ID, version: 1 })} />);

    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    await screen.findByRole("textbox", { name: "RIS" });

    for (const url of Object.values(citeCalls(fetchMock))) {
      expect(decodeURIComponent(url.pathname)).toBe(`/v1/papers/${SHORT_ID}/v1/cite`);
    }
    const description = screen.getByRole("dialog").getAttribute("aria-describedby") as string;
    expect(document.getElementById(description)?.textContent).toContain(`${SHORT_ID}/v1`);
  });

  it("says so, in the node's terms, when the node does not list the version", async () => {
    stubApi({ ...HAPPY, cite: () => notFound() });
    render(<PaperHeader data={await loadData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Cite" }));

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[0].textContent).toContain(
      "This server has no citation for that version.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the rest of the row working while the dialog is open", async () => {
    stubApi();
    render(<PaperHeader data={await loadData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    await screen.findByRole("textbox", { name: "RIS" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    const actions = screen.getByRole("group", { name: "Read, cite and download" });
    expect(within(actions).getByRole("link", { name: /^PDF/ })).toBeTruthy();
    expect(within(actions).getByRole("link", { name: "HTML" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Cite" })).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Download" })).toBeTruthy();
  });
});

describe("the Download menu, opened from the header", () => {
  it("offers the paper's archive, not the version on screen", async () => {
    stubApi();
    render(<PaperHeader data={await loadData()} />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    const archive = screen.getByRole("menuitem", { name: /Paper archive/ });
    expect(archive.getAttribute("href")).toBe(
      `${NODE}/v1/export/paper/${encodeURIComponent(SHORT_ID)}.car`,
    );
    expect(archive.hasAttribute("download")).toBe(true);
  });

  it("opens and closes without asking the node for anything", async () => {
    const fetchMock = stubApi();
    render(<PaperHeader data={await loadData()} />);
    const before = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});
