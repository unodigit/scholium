// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOAST_REGION_ID } from "../ui-kit";

import { NetworkPage } from "./network-page";
import type { NetworkStatus } from "./network";

// `cleanup` unmounts the render container but not the IdPill's toast region,
// which lives on <body>; a leftover `role="status"` region would collide with
// the page's own status lines in later tests.
afterEach(() => {
  cleanup();
  document.getElementById(TOAST_REGION_ID)?.remove();
});

/** A realistic `GET /v1/network` body, already parsed. */
const STATUS: NetworkStatus = {
  node_did: "did:key:z6MkfZrSgCZ1XFdNnVFY1cGM",
  standing: "local",
  log_head: { seq: 41, entry_hash: "9f86d081884c7d659a2feaa0c55ad015a" },
  last_anchor: { status: "pending" },
  replicas: { have: 1, of: 1, local: true, summary: "1 of 1 local" },
  moderation: { total: 3, by_clause: { "MOD-01": 2, "MOD-04": 1 } },
};

describe("NetworkPage with server data", () => {
  it("shows the page title and every section's heading", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Network" }),
    ).toBeTruthy();
    for (const name of [
      "This node",
      "Log head",
      "Public timestamp",
      "Replication",
      "Moderation",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
  });

  it("shows the node standing as a word, with its plain-language meaning", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText(/no federation yet/)).toBeTruthy();
  });

  it("shows the node DID as a copyable monospace id", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const pill = screen.getByRole("button", {
      name: `Copy ${STATUS.node_did}`,
    });
    expect(pill.textContent).toBe(STATUS.node_did);
  });

  it("shows the log head: its sequence and the full entry hash", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.getByText("41")).toBeTruthy();
    const hash = screen
      .getAllByText(STATUS.log_head.entry_hash)
      .find((node) => node.tagName === "CODE");
    expect(hash).toBeTruthy();
  });

  it("shows the anchor pending state as a calm word, not an error", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Anchor pending")).toBeTruthy();
    expect(screen.getByText(/public timestamp will be added/)).toBeTruthy();
  });

  it("shows the replica summary in the node's own words, over a meter of one segment", () => {
    const { container } = render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.getByText("1 of 1 local")).toBeTruthy();

    const meter = container.querySelector(".np-meter");
    expect(meter).not.toBeNull();
    // The words carry the state; the bar is a picture of them.
    expect(meter?.getAttribute("aria-hidden")).toBe("true");
    const segments = container.querySelectorAll(".np-meter-segment");
    expect(segments.length).toBe(1);
    expect(segments[0].getAttribute("data-filled")).toBe("true");
  });

  it("counts moderation by clause, linking each clause to its policy", () => {
    // Scoped to the page: the IdPill's toast region on <body> is also a
    // role="status" live region, by design.
    const { container } = render(<NetworkPage initialStatus={STATUS} />);

    expect(within(container).getByRole("status").textContent).toBe(
      "3 accepted decisions, counted by the policy clause each cites.",
    );

    const table = screen.getByRole("table");
    for (const [clause, count] of Object.entries(STATUS.moderation.by_clause)) {
      const link = within(table).getByRole("link", { name: clause });
      expect(link.getAttribute("href")).toBe(`/policies#${clause}`);
      const row = link.closest("tr");
      expect(row?.textContent).toContain(String(count));
    }
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("shows the one-sentence-and-one-action empty state when nothing was decided", () => {
    render(
      <NetworkPage
        initialStatus={{ ...STATUS, moderation: { total: 0, by_clause: {} } }}
      />,
    );

    expect(
      screen.getByText(/No moderation decisions have been accepted yet/),
    ).toBeTruthy();
    const action = screen.getByRole("link", { name: "Read the policies" });
    expect(action.getAttribute("href")).toBe("/policies");
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("NetworkPage client fallback", () => {
  it("fetches once on mount when the server supplied no status", async () => {
    const load = vi.fn(async () => STATUS);

    render(<NetworkPage loadNetworkStatus={load} />);

    expect(await screen.findByText("1 of 1 local")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("announces the loading state while the request is in flight", () => {
    const load = vi.fn(() => new Promise<NetworkStatus>(() => {}));

    const { container } = render(<NetworkPage loadNetworkStatus={load} />);

    expect(within(container).getByRole("status").textContent).toBe(
      "Loading network status…",
    );
  });

  it("renders a retryable notice when the load fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("The API is down."));

    render(<NetworkPage loadNetworkStatus={load} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load the network status");
    expect(alert.textContent).toContain("The API is down.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries after a failure and shows the status when that succeeds", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("The API is down."))
      .mockResolvedValueOnce(STATUS);

    render(<NetworkPage loadNetworkStatus={load} />);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("1 of 1 local")).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("does not fetch when the server already supplied the status", () => {
    const load = vi.fn(async () => STATUS);

    render(<NetworkPage initialStatus={STATUS} loadNetworkStatus={load} />);

    expect(load).not.toHaveBeenCalled();
  });
});
