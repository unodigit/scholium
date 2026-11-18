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
  operator: "NextGenius",
  software_version: "0.1.0",
  probes: { window_hours: 24, runs: 0, passed: 0, pass_rate: null },
  incidents: [],
  replication_policy: { replicas: 5, operators: 3, jurisdictions: 2 },
  papers_by_replica_health: { meets_policy: 0, below_policy: 0, single_copy: 12 },
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

describe("NetworkPage transparency facts (design.md 5.8)", () => {
  it("names the operator and the software version on the node card", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const card = screen.getByRole("heading", { level: 2, name: "This node" }).closest("section");
    expect(card).not.toBeNull();
    const facts = within(card as HTMLElement);
    expect(facts.getByText("Operator")).toBeTruthy();
    expect(facts.getByText("NextGenius")).toBeTruthy();
    expect(facts.getByText("Software version")).toBeTruthy();
    expect(facts.getByText("0.1.0")).toBeTruthy();
  });

  it("says 'No probes run yet' rather than 0% when no probe has run", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const card = screen
      .getByRole("heading", { level: 2, name: "Probe pass rate" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("No probes run yet")).toBeTruthy();
    expect(card.textContent).not.toMatch(/\d+%/);
  });

  it("shows the measured probe pass rate over the last 24 hours", () => {
    render(
      <NetworkPage
        initialStatus={{
          ...STATUS,
          probes: { window_hours: 24, runs: 8, passed: 6, pass_rate: 0.75 },
        }}
      />,
    );

    const card = screen
      .getByRole("heading", { level: 2, name: "Probe pass rate" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("75%")).toBeTruthy();
    expect(within(card).getByText("6 of 8 probes passed in the last 24 hours.")).toBeTruthy();
  });

  it("explains that anchoring is not enabled yet", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.getByText(/Anchoring is not enabled on this node yet/)).toBeTruthy();
  });

  it("states the replication policy target beside the honest local summary", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const card = screen
      .getByRole("heading", { level: 2, name: "Replication" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("1 of 1 local")).toBeTruthy();
    expect(
      within(card).getByText("Policy target: 5 replicas, 3 operators, 2 jurisdictions."),
    ).toBeTruthy();
  });

  it("counts listed papers at each replica health, with a words-first segmented meter", () => {
    const { container } = render(
      <NetworkPage
        initialStatus={{
          ...STATUS,
          papers_by_replica_health: { meets_policy: 2, below_policy: 0, single_copy: 10 },
        }}
      />,
    );

    const card = screen
      .getByRole("heading", { level: 2, name: "Replication" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("12 listed papers, by replica health.")).toBeTruthy();

    // Every health is listed, zero included, as a word and a count.
    const rows = within(card).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Meets policy.*2/),
      expect.stringMatching(/Below policy.*0/),
      expect.stringMatching(/Single copy.*10/),
    ]);

    // The bar pictures the list: one segment per health that has papers,
    // hidden from assistive technology.
    const meter = container.querySelector(".np-health-meter");
    expect(meter?.getAttribute("aria-hidden")).toBe("true");
    const segments = Array.from(container.querySelectorAll(".np-health-segment"));
    expect(segments.map((segment) => segment.getAttribute("data-health"))).toEqual([
      "meets_policy",
      "single_copy",
    ]);
    expect(segments.map((segment) => (segment as HTMLElement).style.flexGrow)).toEqual([
      "2",
      "10",
    ]);
  });

  it("does not call a single local copy healthy", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const card = screen
      .getByRole("heading", { level: 2, name: "Replication" })
      .closest("section") as HTMLElement;
    const single = within(card)
      .getAllByRole("listitem")
      .find((row) => /Single copy/.test(row.textContent ?? ""));
    expect(single?.textContent).toMatch(/12/);
    expect(single?.textContent).toMatch(/one copy/i);
    expect(card.textContent).not.toMatch(/healthy/i);
  });

  it("says so, and draws no segment, when no paper is listed", () => {
    const { container } = render(
      <NetworkPage
        initialStatus={{
          ...STATUS,
          papers_by_replica_health: { meets_policy: 0, below_policy: 0, single_copy: 0 },
        }}
      />,
    );

    expect(screen.getByText("No papers are listed yet.")).toBeTruthy();
    expect(container.querySelectorAll(".np-health-segment").length).toBe(0);
  });

  it("shows an Incident log section that says so when it is empty", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    expect(screen.getByRole("heading", { level: 2, name: "Incident log" })).toBeTruthy();
    expect(screen.getByText("No incidents recorded.")).toBeTruthy();
  });

  it("lists recorded incidents with a date, a title and what happened", () => {
    render(
      <NetworkPage
        initialStatus={{
          ...STATUS,
          incidents: [
            {
              occurred_at: "2027-05-04T09:30:00Z",
              title: "Storage volume filled",
              detail: "Writes paused for 12 minutes; no record was lost.",
            },
          ],
        }}
      />,
    );

    const section = screen
      .getByRole("heading", { level: 2, name: "Incident log" })
      .closest("section") as HTMLElement;
    expect(within(section).queryByText("No incidents recorded.")).toBeNull();
    const item = within(section).getByRole("listitem");
    expect(item.textContent).toContain("4 May 2027");
    expect(item.textContent).toContain("Storage volume filled");
    expect(item.textContent).toContain("Writes paused for 12 minutes; no record was lost.");
    expect(item.querySelector("time")?.getAttribute("datetime")).toBe("2027-05-04T09:30:00Z");
  });

  it("links the public export and gives the commands to verify and rebuild it", () => {
    render(<NetworkPage initialStatus={STATUS} />);

    const section = screen
      .getByRole("heading", { level: 2, name: "Public export" })
      .closest("section") as HTMLElement;
    const link = within(section).getByRole("link", { name: "/v1/export/archive.car" });
    // The API's origin: the web app does not serve /v1.
    expect(link.getAttribute("href")).toMatch(/^https?:\/\/.+\/v1\/export\/archive\.car$/);
    expect(within(section).getByText("scholium verify archive.car")).toBeTruthy();
    expect(
      within(section).getByText("scholium rebuild archive.car --db rebuilt.db"),
    ).toBeTruthy();
    // The copy describes what the command really checks: a whole-node archive,
    // not a single paper, and it names the paper that fails.
    expect(section.textContent).toContain("every paper’s history");
    expect(section.textContent).toContain("names the one that fails");
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
