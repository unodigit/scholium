// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { ReportPaper } from "./report-paper";

/**
 * The paper header's Report button.
 *
 * It must follow the *live* session, like the rest of the header: the access
 * token lives in memory, so a full page load starts signed out and the session
 * is restored after the page has rendered. A button that read the token store
 * once, at render, sent every signed-in member to /signin.
 */

const VERSION_CID = "bafyreiversioncid";
const PAPER_PATH = "/p/6sel-2dio-orm6";

/** An unsigned JWT with the given claims: nothing here checks the signature. */
function accessToken(claims: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function signIn(): void {
  act(() => {
    tokenStore.set({ accessToken: accessToken({ sub: "did:key:z6MkMember", tier: 1 }) });
  });
}

function signOut(): void {
  act(() => {
    tokenStore.clear();
  });
}

/** Stand-in for `window.location` at an address; records `assign`. */
let assign: ReturnType<typeof vi.fn>;

function stubLocation(address: string): void {
  const { pathname, search, hash, origin } = new URL(address, "http://localhost");
  assign = vi.fn();
  vi.stubGlobal("location", { pathname, search, hash, origin, assign });
}

beforeEach(() => {
  stubLocation(PAPER_PATH);
});

afterEach(() => {
  cleanup();
  signOut();
  vi.unstubAllGlobals();
});

describe("Report on the paper header, signed in", () => {
  it("asks about the paper with paper reasons, not post reasons", async () => {
    signIn();
    render(<ReportPaper versionCid={VERSION_CID} />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(await screen.findByText("Why are you reporting this paper?")).toBeTruthy();
    for (const label of [
      "Research misconduct",
      "Plagiarism",
      "Duplicated figures",
      "Spam or advertising",
      "Off topic",
      "Something else",
    ]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.queryByRole("radio", { name: /Harassment or abuse/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Misleading or false/ })).toBeNull();
  });

  it("opens the report panel for a member whose session was restored after the page rendered", async () => {
    // The page rendered signed out (the server's HTML, then the first client
    // render), and only afterwards did the refresh cookie restore the session.
    render(<ReportPaper versionCid={VERSION_CID} />);
    signIn();

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(await screen.findByRole("radio", { name: /Spam or advertising/ })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("opens the report panel when the session was already there at render", async () => {
    signIn();
    render(<ReportPaper versionCid={VERSION_CID} />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(await screen.findByRole("radio", { name: /Spam or advertising/ })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("posts the flag against the version's cid and says it was reported", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "flag-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ReportPaper versionCid={VERSION_CID} />);
    signIn();

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Plagiarism/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(screen.getByText("Reported")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(new URL(String(url)).pathname).toBe("/v1/flags");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      target: VERSION_CID,
      reason: "plagiarism",
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("goes to sign-in once the session has ended", async () => {
    signIn();
    render(<ReportPaper versionCid={VERSION_CID} />);
    signOut();

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0][0])).toMatch(/^\/signin\?next=/);
    expect(screen.queryByRole("radio", { name: /Spam or advertising/ })).toBeNull();
  });
});

describe("Report on the paper header, signed out", () => {
  it("goes to /signin with the page it was clicked on as ?next=", () => {
    render(<ReportPaper versionCid={VERSION_CID} />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/signin?next=${encodeURIComponent(PAPER_PATH)}`);
  });

  it("keeps the query and the hash in ?next=, read at click time", () => {
    render(<ReportPaper versionCid={VERSION_CID} />);

    // The reader opens a tab after the page rendered: the hash moved on.
    stubLocation(`${PAPER_PATH}/v2?from=search#discussion`);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(assign).toHaveBeenCalledWith(
      `/signin?next=${encodeURIComponent(`${PAPER_PATH}/v2?from=search#discussion`)}`,
    );
  });

  it("still lets a caller pin where sign-in goes", () => {
    render(<ReportPaper versionCid={VERSION_CID} signInHref="/signin?next=%2Felsewhere" />);

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(assign).toHaveBeenCalledWith("/signin?next=%2Felsewhere");
  });
});
