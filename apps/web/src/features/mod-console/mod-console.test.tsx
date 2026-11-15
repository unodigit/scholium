// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, tokenStore } from "../../lib/api";
import { ModConsole } from "./mod-console";
import { QueueListError, parseQueue, type QueueEntry } from "./queue";
import { QueueTable } from "./queue-table";

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    versionCid: "bafy-version-1",
    paperCid: "bafy-paper-1",
    shortId: "sch:k3f9-q2xz-7mwd",
    title: "Sparse attention without the quadratic cost",
    categories: ["cs.AI"],
    ageHours: 5.4,
    similarityPct: 42.5,
    referencesUnresolved: 3,
    scan: "passed",
    newAccount: true,
    ...overrides,
  };
}

const CLEAN = entry({
  versionCid: "bafy-version-2",
  shortId: "sch:abcd-efgh-jklm",
  title: "A tidy proof of a small lemma",
  categories: ["math.CO", "math.NT"],
  ageHours: 52.5,
  similarityPct: 3,
  referencesUnresolved: 0,
  scan: "passed",
  newAccount: false,
});

const RISKY = entry({
  versionCid: "bafy-version-3",
  title: "Results that look familiar",
  ageHours: 0.3,
  similarityPct: 88.25,
  referencesUnresolved: 12,
  scan: "failed",
  newAccount: true,
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

/** The data rows of the table (header row excluded). */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

describe("ModConsole queue table", () => {
  it("shows the page title and, once loaded, a table with a column for each part of a row", async () => {
    render(<ModConsole signedIn loadQueue={async () => [entry()]} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Moderation console" }),
    ).toBeTruthy();

    await screen.findByRole("table");
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual([
      "Paper",
      "Category",
      "Age",
      "Similarity",
      "Unresolved references",
      "Scan",
      "Account",
    ]);
  });

  it("shows a loading line first", () => {
    render(<ModConsole signedIn loadQueue={() => new Promise(() => {})} />);

    expect(screen.getByRole("status").textContent).toBe(
      "Loading the moderation queue…",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the paper, category, age and every signal for a version", async () => {
    render(<ModConsole signedIn loadQueue={async () => [entry()]} />);

    await screen.findByRole("table");
    const [row] = dataRows();
    const cells = within(row);

    const paper = within(cells.getByRole("rowheader"));
    expect(paper.getByText("Sparse attention without the quadratic cost")).toBeTruthy();
    expect(paper.getByText("sch:k3f9-q2xz-7mwd")).toBeTruthy();
    expect(cells.getByText("cs.AI")).toBeTruthy();
    expect(cells.getByText("5 h")).toBeTruthy();
    expect(cells.getByText("42.5%")).toBeTruthy();
    expect(cells.getByText("3 unresolved")).toBeTruthy();
    expect(cells.getByText("Passed")).toBeTruthy();
    expect(cells.getByText("New account")).toBeTruthy();
  });

  it("opens a version's decision view from its title", async () => {
    render(<ModConsole signedIn loadQueue={async () => [entry()]} />);

    await screen.findByRole("table");
    const link = within(dataRows()[0]).getByRole("link", {
      name: "Sparse attention without the quadratic cost",
    });
    expect(link.getAttribute("href")).toBe("/mod/bafy-version-1");
  });

  it("shows a failed scan, a clean reference count and an established account", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => [
          entry({ scan: "failed", referencesUnresolved: 0, newAccount: false }),
        ]}
      />,
    );

    await screen.findByRole("table");
    const cells = within(dataRows()[0]);
    expect(cells.getByText("Failed")).toBeTruthy();
    expect(cells.getByText("None unresolved")).toBeTruthy();
    expect(cells.getByText("Established")).toBeTruthy();
    expect(cells.queryByText("New account")).toBeNull();
  });

  it("says a signal is not checked rather than inventing a number", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => [
          entry({
            similarityPct: null,
            referencesUnresolved: null,
            scan: "unknown",
            newAccount: null,
          }),
        ]}
      />,
    );

    await screen.findByRole("table");
    const cells = within(dataRows()[0]);
    expect(cells.getAllByText("Not checked")).toHaveLength(2);
    expect(cells.getAllByText("Unknown")).toHaveLength(2);
    expect(cells.queryByText(/%/)).toBeNull();
  });

  it("lists every category and an em dash when there is none", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => [CLEAN, entry({ categories: [], ageHours: 9 })]}
      />,
    );

    await screen.findByRole("table");
    expect(screen.getByText("math.CO, math.NT")).toBeTruthy();
    const rows = dataRows();
    expect(within(rows[1]).getByText("—")).toBeTruthy();
  });

  it("gives every signal an icon beside its words, except a plain value", async () => {
    const { container } = render(
      <ModConsole signedIn loadQueue={async () => [RISKY]} />,
    );

    await screen.findByRole("table");
    const flagged = Array.from(
      container.querySelectorAll(
        ".mc-signal--ok, .mc-signal--warn, .mc-signal--bad, .mc-signal--unknown",
      ),
    );
    // references (warn), scan (bad) and account (warn)
    expect(flagged).toHaveLength(3);
    for (const signal of flagged) {
      const icon = signal.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(signal.textContent?.trim()).not.toBe("");
    }
  });

  it("counts the papers waiting", async () => {
    render(<ModConsole signedIn loadQueue={async () => [entry()]} />);
    expect((await screen.findByText("1 paper waiting")).getAttribute("role")).toBe(
      "status",
    );

    cleanup();
    render(<ModConsole signedIn loadQueue={async () => [entry(), CLEAN, RISKY]} />);
    expect(await screen.findByText("3 papers waiting")).toBeTruthy();
  });

  it("makes the scrolling frame keyboard reachable and labels the table", async () => {
    render(<ModConsole signedIn loadQueue={async () => [entry()]} />);

    await screen.findByRole("table");
    const region = screen.getByRole("region", { name: "Moderation queue" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(
      screen.getByRole("table", {
        name: "Versions waiting for a moderation decision, oldest first",
      }),
    ).toBeTruthy();
  });

  it("keeps the order it is given (the loader sorts oldest first)", async () => {
    const sorted = parseQueue([
      { version_cid: "young", title: "Young", age_hours: 2 },
      { version_cid: "old", title: "Old", age_hours: 70 },
    ]);
    render(<ModConsole signedIn loadQueue={async () => sorted} />);

    await screen.findByRole("table");
    const titles = dataRows().map(
      (row) => within(row).getByRole("rowheader").textContent,
    );
    expect(titles).toEqual(["Old", "Young"]);
  });
});

describe("QueueTable on its own", () => {
  it("renders one row per entry, keyed by version", () => {
    render(<QueueTable entries={[entry(), CLEAN, RISKY]} />);
    expect(dataRows()).toHaveLength(3);
  });

  it("omits the id line when the API sent no short id", () => {
    const { container } = render(
      <QueueTable entries={[entry({ shortId: null })]} />,
    );
    expect(container.querySelector(".mc-paper-id")).toBeNull();
  });
});

describe("ModConsole when the queue is empty", () => {
  it("says so in one sentence with one action, and the action checks again", async () => {
    const load = vi
      .fn<() => Promise<QueueEntry[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry()]);
    render(<ModConsole signedIn loadQueue={load} />);

    expect(await screen.findByText("Nothing is waiting for moderation.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await screen.findByRole("table");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("ModConsole access", () => {
  it("asks a visitor with no session to sign in, and makes no request", async () => {
    const load = vi.fn<() => Promise<QueueEntry[]>>();
    render(<ModConsole signedIn={false} loadQueue={load} />);

    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(within(notice).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fmod",
    );
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reads the session from the token store when it is not pinned", async () => {
    const load = vi.fn<() => Promise<QueueEntry[]>>().mockResolvedValue([entry()]);

    render(<ModConsole loadQueue={load} />);
    expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(load).not.toHaveBeenCalled();

    cleanup();
    tokenStore.set({ accessToken: "an-access-token" });
    render(<ModConsole loadQueue={load} />);
    await screen.findByRole("table");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tells an account below tier 4 that the console is for moderators, with its tier", async () => {
    const load = vi.fn(async () => {
      throw new ApiError(403, {
        status: 403,
        detail: "Requires trust tier 4 (Moderator); caller is tier 1 (Member).",
        required_tier: 4,
        caller_tier: 1,
      });
    });
    render(<ModConsole signedIn loadQueue={load} />);

    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { name: "Moderators only" })).toBeTruthy();
    expect(notice.textContent).toContain(
      "The moderation console is for moderators (trust tier 4). Your account is tier 1.",
    );
    // A signed-in account is not asked to sign in, and no table is shown.
    expect(within(notice).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not offer a retry for a 403: trying again cannot raise a tier", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => {
          throw new ApiError(403, { status: 403 });
        }}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(within(notice).queryByRole("button")).toBeNull();
    expect(notice.textContent).not.toContain("Your account is tier");
  });

  it("asks to sign in again when the session ends mid-load", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => {
          throw new ApiError(401, { status: 401 });
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session has ended");
  });
});

describe("ModConsole failures", () => {
  it("shows a retryable notice when the API cannot be reached, and retrying recovers", async () => {
    const load = vi
      .fn<() => Promise<QueueEntry[]>>()
      .mockRejectedValueOnce(new NetworkError("http://api.invalid/v1/moderation/queue"))
      .mockResolvedValueOnce([entry()]);
    render(<ModConsole signedIn loadQueue={load} />);

    const notice = await screen.findByRole("alert");
    expect(within(notice).getByRole("heading", { name: "Couldn’t load the queue" })).toBeTruthy();
    expect(notice.textContent).toContain("could not reach the API");

    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));

    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows a notice, not an empty table, when the API returns something that is not a queue", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => {
          throw new QueueListError("The API did not return a moderation queue.");
        }}
      />,
    );

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("did not return a moderation queue");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Nothing is waiting for moderation.")).toBeNull();
  });

  it("shows the API's own words for a server error", async () => {
    render(
      <ModConsole
        signedIn
        loadQueue={async () => {
          throw new ApiError(500, { status: 500, detail: "The queue index is rebuilding." });
        }}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The queue index is rebuilding.",
    );
  });
});

describe("ModConsole refresh", () => {
  it("keeps the table on screen while refreshing and then shows the new queue", async () => {
    let finish: (entries: QueueEntry[]) => void = () => {};
    const load = vi
      .fn<() => Promise<QueueEntry[]>>()
      .mockResolvedValueOnce([entry()])
      .mockImplementationOnce(
        () =>
          new Promise<QueueEntry[]>((resolve) => {
            finish = resolve;
          }),
      );
    render(<ModConsole signedIn loadQueue={load} />);

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const busy = await screen.findByRole("button", { name: "Refreshing…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByText("Loading the moderation queue…")).toBeNull();

    finish([entry(), CLEAN]);
    expect(await screen.findByText("2 papers waiting")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("replaces the table with a notice when a refresh fails", async () => {
    const load = vi
      .fn<() => Promise<QueueEntry[]>>()
      .mockResolvedValueOnce([entry()])
      .mockRejectedValueOnce(new NetworkError("http://api.invalid/v1/moderation/queue"));
    render(<ModConsole signedIn loadQueue={load} />);

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });
});
