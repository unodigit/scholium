// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { PaperHeader } from "./paper-header";
import { loadPaperPageData, type PaperPageData } from "./paper-page-data";
import {
  ALICE,
  BARE_ID,
  BOB,
  HAPPY,
  SHORT_ID,
  json,
  stubApi,
} from "./paper-page-fixtures";

/**
 * Invite reviewer in the paper page's header (feature 187), end to end as far
 * as the browser goes: the byline comes from the page data the route really
 * loads, the viewer from the real token store, and the request leaves through
 * the real API client, so what these tests read off `fetch` is what the node
 * would receive.
 */

const OKAFOR = "did:key:z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr";

/** An unsigned JWT with the given claims: the page never checks the signature. */
function accessToken(claims: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function signIn(did: string, tier = 2): string {
  const token = accessToken({ sub: did, tier });
  act(() => {
    tokenStore.set({ accessToken: token });
  });
  return token;
}

async function loadData(): Promise<PaperPageData> {
  return loadPaperPageData({ id: BARE_ID, version: null });
}

/** `stubApi` plus the one write this feature makes. */
function stubNode(
  answer: (body: unknown, headers: Headers) => Response = () =>
    json(
      {
        id: "inv-1",
        invitation_id: "inv-1",
        reviewer_did: OKAFOR,
        status: "pending",
        paper: SHORT_ID,
      },
      201,
    ),
): ReturnType<typeof vi.fn> {
  stubApi(HAPPY);
  // `stubApi` installed the node's reads as the global `fetch`; keep them for
  // everything but the invitation.
  const reads = globalThis.fetch;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/review-invitations")) {
      return answer(JSON.parse(String(init?.body ?? "null")), new Headers(init?.headers));
    }
    return reads(input);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The calls to the invitations endpoint, in order. */
function invitations(fetchMock: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname.endsWith("/review-invitations"))
    .map(([input, init]) => [String(input), init as RequestInit]);
}

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.unstubAllGlobals();
});

const inviteButton = () => screen.queryByRole("button", { name: "Invite reviewer" });

describe("the header's Invite reviewer action", () => {
  it("is not in the server's HTML, so the header is the same for every reader", async () => {
    stubApi();
    const html = renderToStaticMarkup(<PaperHeader data={await loadData()} />);

    expect(html).not.toContain("Invite reviewer");
    // The four actions are still there, as plain links.
    for (const action of ["PDF", "HTML", "Cite", "Download"]) {
      expect(html).toContain(action);
    }
  });

  it("is shown to a signed-in author, once the page runs, under the four actions", async () => {
    stubApi();
    const data = await loadData();
    signIn(ALICE);
    const { container } = render(<PaperHeader data={data} />);

    await waitFor(() => expect(inviteButton()).not.toBeNull());
    const actions = container.querySelector(".ppg-actions-block") as HTMLElement;
    const invite = inviteButton() as HTMLElement;
    // Beneath the row, not inside the group that says "Read, cite and download".
    expect(actions.contains(invite)).toBe(false);
    expect(
      actions.compareDocumentPosition(invite) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("is shown to the paper's other author too", async () => {
    stubApi();
    const data = await loadData();
    signIn(BOB);
    render(<PaperHeader data={data} />);
    await waitFor(() => expect(inviteButton()).not.toBeNull());
  });

  it("is not shown to a signed-in reader who is not on the byline", async () => {
    stubApi();
    const data = await loadData();
    signIn(OKAFOR, 3);
    render(<PaperHeader data={data} />);

    // Give the store's answer the chance to land before looking for nothing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(inviteButton()).toBeNull();
  });

  it("is not shown to a signed-out reader", async () => {
    stubApi();
    const data = await loadData();
    render(<PaperHeader data={data} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(inviteButton()).toBeNull();
  });

  it("appears when an author signs in while the page is open, and goes when they sign out", async () => {
    stubApi();
    const data = await loadData();
    render(<PaperHeader data={data} />);
    expect(inviteButton()).toBeNull();

    signIn(ALICE);
    await waitFor(() => expect(inviteButton()).not.toBeNull());

    act(() => {
      tokenStore.clear();
    });
    await waitFor(() => expect(inviteButton()).toBeNull());
  });
});

describe("sending from the header", () => {
  it("POSTs the reviewer and the version on screen to the paper's review-invitations, as the author", async () => {
    const fetchMock = stubNode();
    const data = await loadData();
    const token = signIn(ALICE);
    render(<PaperHeader data={data} />);
    await waitFor(() => expect(inviteButton()).not.toBeNull());

    fireEvent.click(inviteButton() as HTMLElement);
    fireEvent.change(screen.getByLabelText("Reviewer’s DID"), {
      target: { value: OKAFOR },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    });

    const sent = invitations(fetchMock);
    expect(sent).toHaveLength(1);
    const [url, init] = sent[0];
    expect(new URL(url).pathname).toBe(`/v1/papers/${encodeURIComponent(SHORT_ID)}/review-invitations`);
    expect(init.method).toBe("POST");
    // The paper page shows v2 of 2: the invitation is for v2.
    expect(JSON.parse(String(init.body))).toEqual({ reviewer: OKAFOR, version: "2" });
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("content-type")).toBe("application/json");

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Invitation sent to"),
    );
  });

  it("shows the node's refusal when the invitee is not a reviewer in the category", async () => {
    const said = "The invitee must be a tier-3 reviewer in the paper category.";
    stubNode(() =>
      json({ title: "Forbidden", status: 403, detail: said }, 403),
    );
    const data = await loadData();
    signIn(ALICE);
    render(<PaperHeader data={data} />);
    await waitFor(() => expect(inviteButton()).not.toBeNull());

    fireEvent.click(inviteButton() as HTMLElement);
    fireEvent.change(screen.getByLabelText("Reviewer’s DID"), {
      target: { value: OKAFOR },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(said));
    expect(screen.getByRole("alert").textContent).toContain("No invitation was sent.");
  });

  it("sends nothing for a co-author's DID", async () => {
    const fetchMock = stubNode();
    const data = await loadData();
    signIn(ALICE);
    render(<PaperHeader data={data} />);
    await waitFor(() => expect(inviteButton()).not.toBeNull());

    fireEvent.click(inviteButton() as HTMLElement);
    fireEvent.change(screen.getByLabelText("Reviewer’s DID"), {
      target: { value: BOB },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    });

    expect(invitations(fetchMock)).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("Authors cannot review their own paper");
  });
});
