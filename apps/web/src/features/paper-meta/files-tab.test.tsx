// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilesTab, fileName, unavailableReason } from "./files-tab";
import type { ManifestData } from "./meta";

const SHORT = "sch:6sel-2dio-orm6";

const MANIFEST: ManifestData = {
  paper: SHORT,
  versionCid: "bafyrei-v2",
  n: 2,
  manifestCid: "bafyrei-manifest",
  licence: "CC-BY-4.0",
  files: [
    {
      path: "paper.pdf",
      cid: "bafkrei-pdf",
      size: 1048576,
      mediaType: "application/pdf",
      role: "manuscript",
      licence: "CC-BY-4.0",
      scanStatus: "passed",
    },
    {
      path: "code/repro.zip",
      cid: "bafkrei-code",
      size: 2048,
      mediaType: "application/zip",
      role: "reproduction-log",
      licence: "CC-BY-4.0",
      scanStatus: "scanning",
    },
    {
      path: "data/raw.bin",
      cid: "bafkrei-data",
      size: 512,
      mediaType: null,
      role: "data",
      licence: "CC-BY-NC-4.0",
      scanStatus: "failed",
    },
    {
      path: "figures/fig1.png",
      cid: "bafkrei-fig",
      size: 0,
      mediaType: "image/png",
      role: "figure",
      licence: "CC-BY-4.0",
      scanStatus: "missing",
    },
  ],
};

afterEach(cleanup);

describe("FilesTab", () => {
  it("lists each file with its size, licence, scan status and download link", () => {
    render(
      <FilesTab
        paperId={SHORT}
        version={2}
        initial={MANIFEST}
        downloadUrl={(cid) => `/content/${cid}`}
      />,
    );

    expect(screen.getByText("4 files · CC BY 4.0")).toBeTruthy();

    const list = screen.getByRole("list", { name: "Files of version 2" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);

    const pdf = rows[0];
    expect(pdf.textContent).toContain("paper.pdf");
    expect(pdf.textContent).toContain("Manuscript");
    expect(pdf.textContent).toContain("1 MiB");
    expect(pdf.textContent).toContain("CC BY 4.0");
    expect(pdf.textContent).toContain("Scan passed");

    const code = rows[1];
    expect(code.textContent).toContain("code/repro.zip");
    expect(code.textContent).toContain("Reproduction log");
    expect(code.textContent).toContain("2 KiB");
    expect(code.textContent).toContain("Scanning");

    expect(rows[2].textContent).toContain("Scan failed");
    expect(rows[2].textContent).toContain("CC BY-NC 4.0");
    expect(rows[3].textContent).toContain("Not available");
    expect(rows[3].textContent).toContain("0 bytes");
  });

  it("offers a download only for a file the node will serve", () => {
    render(
      <FilesTab
        paperId={SHORT}
        version={2}
        initial={MANIFEST}
        downloadUrl={(cid) => `/content/${cid}`}
      />,
    );

    const link = screen.getByRole("link", { name: /Download paper\.pdf/ });
    expect(link.getAttribute("href")).toBe("/content/bafkrei-pdf");
    expect(link.getAttribute("download")).toBe("paper.pdf");

    // The scanning, failed and missing files are not linked.
    expect(screen.queryByRole("link", { name: /repro\.zip/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /raw\.bin/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /fig1\.png/ })).toBeNull();
  });

  it("says why a file has no download instead of offering a dead link", () => {
    render(<FilesTab paperId={SHORT} version={2} initial={MANIFEST} />);
    expect(screen.getByText("Download opens when the scan finishes.")).toBeTruthy();
    expect(screen.getByText("Not served: the scan found active content.")).toBeTruthy();
    expect(screen.getByText("Not available on this node.")).toBeTruthy();
  });

  it("uses the node's content URL by default", () => {
    render(<FilesTab paperId={SHORT} version={2} initial={MANIFEST} />);
    const link = screen.getByRole("link", { name: /Download paper\.pdf/ });
    expect(link.getAttribute("href")).toMatch(/\/v1\/content\/bafkrei-pdf$/);
  });

  it("shows a retryable message when the file list cannot be read", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("The node is down."))
      .mockResolvedValueOnce(MANIFEST);

    render(<FilesTab paperId={SHORT} version={2} load={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The node is down.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("paper.pdf")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(SHORT, 2, expect.any(AbortSignal));
  });

  it("says it is loading while the request is in flight", async () => {
    let resolve!: (data: ManifestData) => void;
    const load = vi.fn(
      () =>
        new Promise<ManifestData>((done) => {
          resolve = done;
        }),
    );

    render(<FilesTab paperId={SHORT} version={2} load={load} />);
    expect(screen.getByRole("status").textContent).toContain("Loading files");

    await act(async () => resolve(MANIFEST));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("paper.pdf")).toBeTruthy();
  });

  it("says so, in words, when a version lists no files", () => {
    render(
      <FilesTab
        paperId={SHORT}
        version={2}
        initial={{ ...MANIFEST, files: [] }}
      />,
    );
    expect(screen.getByText("No files are listed for this version.")).toBeTruthy();
  });

  it("server-renders the file list in the first HTML response", () => {
    const html = renderToString(<FilesTab paperId={SHORT} version={2} initial={MANIFEST} />);
    expect(html).toContain("paper.pdf");
    expect(html).toContain("Scan passed");
    expect(html).toContain("Download");
    expect(html).not.toContain("Loading files");
  });

  it("starts over when the host swaps to another version", async () => {
    const load = vi.fn(async (_paperId: string, version: number) => ({
      ...MANIFEST,
      n: version,
      files: [
        {
          ...MANIFEST.files[0],
          path: `v${version}.pdf`,
          cid: `bafkrei-v${version}`,
        },
      ],
    }));

    const { rerender } = render(<FilesTab paperId={SHORT} version={1} load={load} />);
    expect(await screen.findByText("v1.pdf")).toBeTruthy();

    rerender(<FilesTab paperId={SHORT} version={2} load={load} />);
    expect(await screen.findByText("v2.pdf")).toBeTruthy();
    expect(screen.queryByText("v1.pdf")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(SHORT, 2, expect.any(AbortSignal));
  });

  it("derives a safe download name from the path", () => {
    expect(fileName("paper.pdf")).toBe("paper.pdf");
    expect(fileName("code/repro.zip")).toBe("repro.zip");
    expect(fileName("a/b/c.tar.gz")).toBe("c.tar.gz");
  });

  it("has a reason for every verdict that is not downloadable", () => {
    expect(unavailableReason("scanning")).toMatch(/scan finishes/);
    expect(unavailableReason("failed")).toMatch(/active content/);
    expect(unavailableReason("missing")).toMatch(/Not available/);
    expect(unavailableReason("unknown")).toMatch(/unknown/);
    expect(unavailableReason("passed")).toBe("");
  });
});
