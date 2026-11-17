// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VersionsTab } from "./versions-tab";
import { changeNoteText, type VersionsData } from "./meta";

const SHORT = "sch:6sel-2dio-orm6";

const TIMELINE: VersionsData = {
  paper: SHORT,
  paperCid: "bafyrei-paper",
  versions: [
    {
      n: 1,
      cid: "bafyrei-v1",
      changeNote: null,
      listedAt: "2026-01-01T00:00:00Z",
      anchor: {
        status: "anchored",
        anchoredAt: "2027-03-02T04:00:00Z",
        txUrl: "https://basescan.org/tx/0xabc",
      },
    },
    {
      n: 2,
      cid: "bafyrei-v2",
      changeNote: "Fixed the proof of Lemma 2.",
      listedAt: "2026-02-01T00:00:00Z",
      anchor: { status: "pending" },
    },
  ],
};

afterEach(cleanup);

describe("VersionsTab", () => {
  it("shows the timeline oldest first, with change notes and anchor status", () => {
    render(<VersionsTab paperId={SHORT} initial={TIMELINE} />);

    const list = screen.getByRole("list", { name: /Version timeline, oldest first/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Version 1");
    expect(rows[1].textContent).toContain("Version 2");

    expect(rows[0].textContent).toContain("First version.");
    expect(rows[1].textContent).toContain("Fixed the proof of Lemma 2.");
    expect(rows[0].textContent).toContain("Anchored 2 Mar 2027 04:00 UTC");
    expect(rows[1].textContent).toContain("Anchor pending");
    // The row says *why* it is pending, in the same words as the Proof tab.
    expect(rows[1].textContent).toContain("Anchoring is not enabled on this node yet");
    expect(rows[1].textContent).toContain("1 Feb 2026");
  });

  it("links each version to the paper page's version URL", () => {
    render(<VersionsTab paperId={SHORT} initial={TIMELINE} />);
    expect(screen.getByRole("link", { name: "Version 1" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v1",
    );
    expect(screen.getByRole("link", { name: "Version 2" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/v2",
    );
  });

  it("marks the version being read 'Viewing' and the newest 'Latest', also when they differ", () => {
    const { rerender } = render(<VersionsTab paperId={SHORT} initial={TIMELINE} />);
    // Reading the newest (the default): it is both the one being viewed and the latest.
    expect(screen.getByText("Viewing").closest("li")?.textContent).toContain("Version 2");
    expect(screen.getByText("Latest").closest("li")?.textContent).toContain("Version 2");

    // Reading v1: v1 is merely being viewed — v2, not v1, is the latest.
    rerender(<VersionsTab paperId={SHORT} initial={TIMELINE} currentVersion={1} />);
    expect(screen.getByText("Viewing").closest("li")?.textContent).toContain("Version 1");
    expect(screen.getByText("Latest").closest("li")?.textContent).toContain("Version 2");
    expect(screen.queryByText("Current")).toBeNull();
  });

  it("offers the compare action only when the host supplies a compare URL", () => {
    const { rerender } = render(<VersionsTab paperId={SHORT} initial={TIMELINE} />);
    expect(screen.queryByRole("link", { name: /Compare/ })).toBeNull();

    rerender(
      <VersionsTab
        paperId={SHORT}
        initial={TIMELINE}
        compareHref={(from, to) => `/p/6sel-2dio-orm6/compare/${from}..${to}`}
      />,
    );
    expect(screen.getByRole("link", { name: "Compare v1 with v2" }).getAttribute("href")).toBe(
      "/p/6sel-2dio-orm6/compare/1..2",
    );
  });

  it("links an anchored transaction only when the node gave an https url", () => {
    render(<VersionsTab paperId={SHORT} initial={TIMELINE} />);
    const link = screen.getByRole("link", { name: /View transaction/ });
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xabc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows a retryable message when the node cannot be read", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("The node is down."))
      .mockResolvedValueOnce(TIMELINE);

    render(<VersionsTab paperId={SHORT} load={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The node is down.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Fixed the proof of Lemma 2.")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("says it is loading while the request is in flight", async () => {
    let resolve!: (data: VersionsData) => void;
    const load = vi.fn(
      () =>
        new Promise<VersionsData>((done) => {
          resolve = done;
        }),
    );

    render(<VersionsTab paperId={SHORT} load={load} />);
    expect(screen.getByRole("status").textContent).toContain("Loading version history");

    await act(async () => resolve(TIMELINE));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Fixed the proof of Lemma 2.")).toBeTruthy();
  });

  it("says so, in words, when a paper has no listed versions", () => {
    render(
      <VersionsTab
        paperId={SHORT}
        initial={{ paper: SHORT, paperCid: null, versions: [] }}
      />,
    );
    expect(screen.getByText("No versions are listed yet.")).toBeTruthy();
  });

  it("server-renders the timeline in the first HTML response", () => {
    const html = renderToString(<VersionsTab paperId={SHORT} initial={TIMELINE} />);
    expect(html).toContain("Version 1");
    expect(html).toContain("Fixed the proof of Lemma 2.");
    expect(html).toContain("Anchor pending");
    expect(html).not.toContain("Loading version history");
  });

  it("starts over when the host swaps to another paper", async () => {
    const other = "sch:aaaa-aaaa-aaac";
    const load = vi.fn(async (paperId: string) => ({
      ...TIMELINE,
      paper: paperId,
      versions: [
        {
          ...TIMELINE.versions[1],
          n: 1,
          changeNote: paperId === other ? "Other paper." : "First paper.",
        },
      ],
    }));

    const { rerender } = render(<VersionsTab paperId={SHORT} load={load} />);
    expect(await screen.findByText("First paper.")).toBeTruthy();

    rerender(<VersionsTab paperId={other} load={load} />);
    expect(await screen.findByText("Other paper.")).toBeTruthy();
    expect(screen.queryByText("First paper.")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("names the missing change note honestly", () => {
    expect(changeNoteText({ n: 1, changeNote: null })).toBe("First version.");
    expect(changeNoteText({ n: 2, changeNote: null })).toBe("No change note was given.");
    expect(changeNoteText({ n: 2, changeNote: "Typo fixes." })).toBe("Typo fixes.");
  });
});
