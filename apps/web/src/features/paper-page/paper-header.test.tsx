// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { PaperHeader } from "./paper-header";
import { loadPaperPageData } from "./paper-page-data";
import { BARE_ID, HAPPY, stubApi } from "./paper-page-fixtures";

/**
 * The paper header's Follow and Report actions, as the page renders them: the
 * session arrives after the first render (a full page load restores it from
 * the refresh cookie), and the two buttons sit in one row with room between.
 * The preservation fact is a client island that reads the node's replication
 * summary (`GET /v1/network`) after the first render.
 */

const here = dirname(fileURLToPath(import.meta.url));

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

afterEach(() => {
  cleanup();
  act(() => {
    tokenStore.clear();
  });
  vi.unstubAllGlobals();
});

describe("Report in the paper header", () => {
  it("opens the report panel for a signed-in member, whose session arrived after the page rendered", async () => {
    stubApi(HAPPY);
    const assign = vi.fn();
    vi.stubGlobal("location", {
      pathname: `/p/${BARE_ID}`,
      search: "",
      hash: "",
      origin: "http://localhost",
      assign,
    });
    const data = await loadPaperPageData({ id: BARE_ID, version: null });

    render(<PaperHeader data={data} />);
    // The server's HTML and the first client render are signed out; the
    // member's session is restored afterwards, as `bootstrapSession` does.
    act(() => {
      tokenStore.set({ accessToken: accessToken({ sub: "did:key:z6MkMember", tier: 1 }) });
    });

    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(await screen.findByRole("radio", { name: /Spam or advertising/ })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a signed-out reader to sign-in and back to this page", async () => {
    stubApi(HAPPY);
    const assign = vi.fn();
    vi.stubGlobal("location", {
      pathname: `/p/${BARE_ID}`,
      search: "",
      hash: "#reviews",
      origin: "http://localhost",
      assign,
    });
    const data = await loadPaperPageData({ id: BARE_ID, version: null });

    render(<PaperHeader data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));

    expect(assign).toHaveBeenCalledWith(
      `/signin?next=${encodeURIComponent(`/p/${BARE_ID}#reviews`)}`,
    );
  });
});

describe("the header's preservation fact", () => {
  /** Answer `GET /v1/network` with this single node's replication summary. */
  function stubNetworkSummary(replicas: unknown): void {
    const fixtureFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = decodeURIComponent(new URL(String(input)).pathname);
        if (path === "/v1/network") {
          return new Response(JSON.stringify({ node_did: "did:key:z6Mk", standing: "local", replicas }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return fixtureFetch(input);
      }),
    );
  }

  it("says what this node preserves, in words, linking to /network", async () => {
    stubApi(HAPPY);
    stubNetworkSummary({ have: 1, of: 1, local: true, summary: "1 of 1 local" });
    const data = await loadPaperPageData({ id: BARE_ID, version: null });

    render(<PaperHeader data={data} />);

    const fact = await screen.findByRole("link", { name: /Preserved: 1 of 1 local copy/ });
    expect(fact.getAttribute("href")).toBe("/network");
    // The honest qualifier is said out loud, not hidden in a tooltip.
    expect(fact.closest(".ppg-fact")!.textContent).toContain(
      "Multi-operator replication is not enabled yet.",
    );
  });

  it("stays quiet when the node's summary cannot be read", async () => {
    stubApi(HAPPY); // no /v1/network route: every such read is a 404
    const data = await loadPaperPageData({ id: BARE_ID, version: null });

    render(<PaperHeader data={data} />);
    await act(async () => {});

    expect(screen.queryByText(/Preserved:/)).toBeNull();
  });
});

describe("the header's Follow and Report row", () => {
  /** The declarations of the first rule for `selector`, comments removed. */
  function rule(file: string, selector: string): string {
    const css = readFileSync(join(here, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (match[1].trim() === selector) return match[2];
    }
    return "";
  }

  it("is one row with a gap between Follow and Report, the same step as the row above", () => {
    const extra = rule("paper-actions.css", ".ppg-extra-actions");
    const above = rule("paper-page.css", ".ppg-actions");

    expect(extra).toMatch(/display:\s*flex/);
    expect(extra).toMatch(/flex-wrap:\s*wrap/);
    const gap = /gap:\s*([^;]+);/.exec(extra)?.[1].trim();
    expect(gap).toBeDefined();
    // A step of the spacing token, never a bare number that skips the grid.
    expect(gap).toMatch(/^calc\(var\(--space-unit\) \* \d+(\.\d+)?\)$/);
    expect(gap).toBe(/gap:\s*([^;]+);/.exec(above)?.[1].trim());
  });
});
