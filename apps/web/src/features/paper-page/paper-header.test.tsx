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
