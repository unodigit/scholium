// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseManifest, parseVersions } from "../paper-meta/meta";
import { parseReviews } from "../paper-reviews/review";
import { parseThreads } from "../paper-discussion/discussion";
import { MarginPanel, type MarginPanelProps } from "./margin-panel";
import {
  MANIFEST_BODY,
  REVIEWS_BODY,
  SHORT_ID,
  THREADS_BODY,
  VERSIONS_BODY,
  VERSION_CID,
} from "./paper-page-fixtures";

/**
 * The margin panel (docs/design.md §5.2): six tabs, a badge that follows the
 * Proof tab, and tabs that are also addresses (`#proof`).
 *
 * The six tabs are stubs that record what they were given, so these tests are
 * about the panel itself: which tab gets which data, what is mounted when,
 * how the keyboard and the address move between tabs, and what the badge says.
 * The tabs' own behaviour is tested with the tabs.
 */

const stubs = vi.hoisted(() => ({
  props: {} as Record<string, Record<string, unknown>>,
  proofState: undefined as undefined | ((state: string, outcome: null) => void),
}));

vi.mock("../paper-reviews", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    ReviewsTab: (props: Record<string, unknown>) => {
      stubs.props.reviews = props;
      return createElement("div", { "data-testid": "reviews-tab" });
    },
  };
});
vi.mock("../paper-ai", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    AiTab: (props: Record<string, unknown>) => {
      stubs.props.ai = props;
      return createElement("div", { "data-testid": "ai-tab" });
    },
  };
});
vi.mock("../paper-discussion", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    DiscussionTab: (props: Record<string, unknown>) => {
      stubs.props.discussion = props;
      return createElement("div", { "data-testid": "discussion-tab" });
    },
  };
});
vi.mock("../paper-meta", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    VersionsTab: (props: Record<string, unknown>) => {
      stubs.props.versions = props;
      return createElement("div", { "data-testid": "versions-tab" });
    },
    FilesTab: (props: Record<string, unknown>) => {
      stubs.props.files = props;
      return createElement("div", { "data-testid": "files-tab" });
    },
  };
});
vi.mock("../paper-proof", async (importOriginal) => {
  const { createElement } = await import("react");
  return {
    ...(await importOriginal<object>()),
    ProofTab: (props: Record<string, unknown>) => {
      stubs.props.proof = props;
      stubs.proofState = props.onStateChange as typeof stubs.proofState;
      return createElement("div", { "data-testid": "proof-tab" });
    },
  };
});

const ok = <T,>(data: T) => ({ ok: true as const, data });

function props(overrides: Partial<MarginPanelProps> = {}): MarginPanelProps {
  return {
    shortId: SHORT_ID,
    version: 2,
    versionId: `${SHORT_ID}/v2`,
    versionCid: VERSION_CID,
    reviews: ok(parseReviews(REVIEWS_BODY)),
    discussion: ok(parseThreads(THREADS_BODY)),
    versions: ok(parseVersions(VERSIONS_BODY)),
    manifest: ok(parseManifest(MANIFEST_BODY)),
    ...overrides,
  };
}

const TABS = ["Reviews", "AI", "Discussion", "Versions", "Files", "Proof"];

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

/**
 * The Verify badge. It is a live region (`role="status"`), and so is the toast
 * region the ID pill adds to the page, so it is picked out by its own class.
 */
const badge = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".sch-verify");
  if (found === null) throw new Error("The Verify badge is not on the page.");
  return found;
};

beforeEach(() => {
  window.history.replaceState(null, "", "/p/6sel-2dio-orm6");
  stubs.props = {};
  stubs.proofState = undefined;
});

afterEach(cleanup);

describe("the tabs", () => {
  it("are Reviews, AI, Discussion, Versions, Files and Proof, in that order", () => {
    render(<MarginPanel {...props()} />);

    const names = screen.getAllByRole("tab").map((el) => el.textContent ?? "");
    expect(names).toHaveLength(6);
    TABS.forEach((name, index) => expect(names[index]).toMatch(new RegExp(`^${name}`)));
  });

  it("form one tablist, with Reviews open", () => {
    render(<MarginPanel {...props()} />);

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(tab("Reviews").getAttribute("aria-selected")).toBe("true");
    for (const name of TABS.slice(1)) {
      expect(tab(name).getAttribute("aria-selected")).toBe("false");
    }
  });

  it("each own a tabpanel the tab points to, and only the open one is visible", () => {
    render(<MarginPanel {...props()} />);

    for (const name of TABS) {
      const el = tab(name);
      const panel = document.getElementById(el.getAttribute("aria-controls") ?? "");
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(el.id);
    }
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel").contains(screen.getByTestId("reviews-tab"))).toBe(true);
  });

  it("put only the open tab in the tab order", () => {
    render(<MarginPanel {...props()} />);

    expect(tab("Reviews").tabIndex).toBe(0);
    for (const name of TABS.slice(1)) {
      expect(tab(name).tabIndex).toBe(-1);
    }
  });

  it("show how many reviews and posts there are, and nothing for the rest", () => {
    render(<MarginPanel {...props()} />);

    expect(tab("Reviews").textContent).toBe("Reviews (3)");
    // Eight posts in all: replies count.
    expect(tab("Discussion").textContent).toBe("Discussion (8)");
    expect(tab("AI").textContent).toBe("AI");
    expect(tab("Versions").textContent).toBe("Versions");
  });

  it("leave a count off when there is nothing to count, or it is not known", () => {
    render(
      <MarginPanel
        {...props({
          reviews: ok(parseReviews({ ...REVIEWS_BODY, reviews: [], count: 0 })),
          discussion: { ok: false, error: "The server could not answer." },
        })}
      />,
    );

    expect(tab("Reviews").textContent).toBe("Reviews");
    expect(tab("Discussion").textContent).toBe("Discussion");
  });
});

describe("switching tabs", () => {
  it("opens the tab that is clicked and hides the one it replaces", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.click(tab("Discussion"));

    expect(tab("Discussion").getAttribute("aria-selected")).toBe("true");
    expect(tab("Reviews").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel").contains(screen.getByTestId("discussion-tab"))).toBe(true);
  });

  it("moves with the arrow keys, wrapping at both ends", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.keyDown(tab("Reviews"), { key: "ArrowRight" });
    expect(tab("AI").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("AI"));

    fireEvent.keyDown(tab("AI"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab("Reviews"), { key: "ArrowLeft" });
    expect(tab("Proof").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("Proof"), { key: "ArrowRight" });
    expect(tab("Reviews").getAttribute("aria-selected")).toBe("true");
  });

  it("jumps to the first and last tab with Home and End", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.keyDown(tab("Reviews"), { key: "End" });
    expect(tab("Proof").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("Proof"), { key: "Home" });
    expect(tab("Reviews").getAttribute("aria-selected")).toBe("true");
  });

  it("ignores other keys", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.keyDown(tab("Reviews"), { key: "a" });
    fireEvent.keyDown(tab("Reviews"), { key: "ArrowDown" });

    expect(tab("Reviews").getAttribute("aria-selected")).toBe("true");
  });
});

describe("what is mounted, and when", () => {
  it("mounts Reviews and Proof at once, and the others only when first opened", () => {
    render(<MarginPanel {...props()} />);

    expect(screen.queryByTestId("reviews-tab")).not.toBeNull();
    expect(screen.queryByTestId("proof-tab")).not.toBeNull();
    for (const id of ["ai-tab", "discussion-tab", "versions-tab", "files-tab"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }

    fireEvent.click(tab("AI"));
    expect(screen.queryByTestId("ai-tab")).not.toBeNull();
    expect(screen.queryByTestId("files-tab")).toBeNull();
  });

  it("keeps a tab mounted after the reader leaves it, so its state survives", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.click(tab("Discussion"));
    fireEvent.click(tab("Versions"));

    expect(screen.queryByTestId("discussion-tab")).not.toBeNull();
    expect(screen.getByTestId("discussion-tab").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps Proof running while another tab is showing, so the badge can say something", () => {
    render(<MarginPanel {...props()} />);

    expect(screen.getByTestId("proof-tab").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
    expect(stubs.proofState).toBeTypeOf("function");
  });
});

describe("what each tab is given", () => {
  it("hands Reviews the version id and the reviews the server read", () => {
    render(<MarginPanel {...props()} />);

    expect(stubs.props.reviews.paperId).toBe(`${SHORT_ID}/v2`);
    expect(stubs.props.reviews.initial).toMatchObject({ count: 3 });
    expect(stubs.props.reviews.initialError).toBeUndefined();
  });

  it("hands Proof the version id, so it checks the version on screen", () => {
    render(<MarginPanel {...props()} />);
    expect(stubs.props.proof.schId).toBe(`${SHORT_ID}/v2`);
  });

  it("hands AI the version id", () => {
    render(<MarginPanel {...props()} />);
    fireEvent.click(tab("AI"));
    expect(stubs.props.ai.paperId).toBe(`${SHORT_ID}/v2`);
  });

  it("hands Discussion the paper and the version's record, so a new thread attaches to it", () => {
    render(<MarginPanel {...props()} />);
    fireEvent.click(tab("Discussion"));

    expect(stubs.props.discussion.paperId).toBe(SHORT_ID);
    expect(stubs.props.discussion.versionCid).toBe(VERSION_CID);
    expect(stubs.props.discussion.initial).toMatchObject({ threads: expect.any(Array) });
  });

  it("hands Versions the paper and the version on screen, to mark Current", () => {
    render(<MarginPanel {...props({ version: 1, versionId: `${SHORT_ID}/v1` })} />);
    fireEvent.click(tab("Versions"));

    expect(stubs.props.versions.paperId).toBe(SHORT_ID);
    expect(stubs.props.versions.currentVersion).toBe(1);
    expect(stubs.props.versions.initial).toMatchObject({ versions: expect.any(Array) });
  });

  it("hands Versions the paper page's compare address for the adjacent pair", () => {
    render(<MarginPanel {...props()} />);
    fireEvent.click(tab("Versions"));

    const compareHref = stubs.props.versions.compareHref as (
      from: number,
      to: number,
    ) => string;
    expect(compareHref(1, 2)).toBe("/p/6sel-2dio-orm6/compare/1..2");
  });

  it("hands Files the paper, the version and the file list", () => {
    render(<MarginPanel {...props()} />);
    fireEvent.click(tab("Files"));

    expect(stubs.props.files.paperId).toBe(SHORT_ID);
    expect(stubs.props.files.version).toBe(2);
    expect(stubs.props.files.initial).toMatchObject({ files: expect.any(Array) });
  });

  it("passes a failed read on as the tab's own error, so the tab can offer a retry", () => {
    render(
      <MarginPanel
        {...props({
          reviews: { ok: false, error: "Too many requests just now." },
          manifest: { ok: false, error: "This node has no files for that version." },
        })}
      />,
    );
    fireEvent.click(tab("Files"));

    expect(stubs.props.reviews.initialError).toBe("Too many requests just now.");
    expect(stubs.props.reviews.initial).toBeUndefined();
    expect(stubs.props.files.initialError).toBe("This node has no files for that version.");
  });
});

describe("tabs are addresses", () => {
  it("opens the tab the address names when the page arrives", async () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#files");

    render(<MarginPanel {...props()} />);

    await waitFor(() => expect(tab("Files").getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByTestId("files-tab")).not.toBeNull();
  });

  it("follows a link to another tab", async () => {
    render(<MarginPanel {...props()} />);

    act(() => {
      window.location.hash = "#versions";
    });

    await waitFor(() => expect(tab("Versions").getAttribute("aria-selected")).toBe("true"));
  });

  it("writes the tab into the address when the reader opens it", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.click(tab("Discussion"));

    expect(window.location.hash).toBe("#discussion");
  });

  it("replaces the address rather than adding to the history", () => {
    const before = window.history.length;
    render(<MarginPanel {...props()} />);

    fireEvent.click(tab("Discussion"));
    fireEvent.click(tab("Files"));

    expect(window.history.length).toBe(before);
  });

  it("leaves the open tab alone for a fragment that is not a tab", async () => {
    window.history.replaceState(null, "", "/p/6sel-2dio-orm6#p-abc123");

    render(<MarginPanel {...props()} />);

    expect(tab("Reviews").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the badge", () => {
  it("starts as Checking, and does not claim a verdict the browser has not reached", () => {
    render(<MarginPanel {...props()} />);

    expect(badge().textContent).toContain("Checking");
    expect(badge().textContent).not.toContain("Verified");
  });

  it("follows the Proof tab's state", async () => {
    render(<MarginPanel {...props()} />);

    act(() => stubs.proofState?.("verified", null));
    await waitFor(() => expect(badge().textContent).toContain("Verified"));

    act(() => stubs.proofState?.("anchor_pending", null));
    await waitFor(() =>
      expect(badge().textContent).toContain("Signed · anchor pending"),
    );

    act(() => stubs.proofState?.("failed", null));
    await waitFor(() =>
      expect(badge().textContent).toContain("Verification failed"),
    );
  });

  it("always opens the Proof tab, and moves focus there", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.click(badge().querySelector("a") as HTMLElement);

    expect(tab("Proof").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Proof"));
    expect(window.location.hash).toBe("#proof");
  });

  it("is a #proof link, so it still works where the click is not taken over", () => {
    render(<MarginPanel {...props()} />);
    expect(badge().querySelector("a")?.getAttribute("href")).toBe("#proof");
  });

  it("has a Details link that opens Proof too", () => {
    render(<MarginPanel {...props()} />);

    fireEvent.click(screen.getByRole("link", { name: /^Details/ }));

    expect(tab("Proof").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the top of the panel", () => {
  it("shows the version's id, ready to copy", () => {
    render(<MarginPanel {...props()} />);
    expect(screen.getByRole("button", { name: new RegExp(`${SHORT_ID}/v2`) })).toBeTruthy();
  });

  it("says when the version was anchored, or that the anchor is pending", () => {
    const { unmount } = render(<MarginPanel {...props()} />);
    // v2 is anchored in the fixture.
    expect(screen.getByText(/^Anchored 2 Mar 2027/)).toBeTruthy();
    unmount();

    render(<MarginPanel {...props({ version: 1, versionId: `${SHORT_ID}/v1` })} />);
    expect(screen.getByText("Anchor pending")).toBeTruthy();
  });

  it("says nothing about the anchor when the timeline could not be read", () => {
    render(
      <MarginPanel {...props({ versions: { ok: false, error: "No versions." } })} />,
    );
    expect(screen.queryByText(/Anchor/)).toBeNull();
  });
});
