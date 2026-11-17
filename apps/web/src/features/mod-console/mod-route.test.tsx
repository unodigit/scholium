// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModRoutePage, { metadata } from "../../app/(mod-console)/mod/page";

/**
 * `/mod` is rendered on the client: the queue needs the signed-in account's
 * bearer token, which only exists in the browser. The server HTML is the shell
 * and a loading line, and it must never call the API (there is no token to
 * send, and the queue is private).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mod route (server render)", () => {
  it("renders the console shell and a loading line, and calls no API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(<ModRoutePage />);

    expect(html).toContain("Moderation console");
    expect(html).toContain("Loading the moderation queue…");
    expect(html).not.toContain("<table");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not put the queue, or a sign-in prompt, in the first HTML", () => {
    const html = renderToStaticMarkup(<ModRoutePage />);

    // The first paint matches what the browser will hydrate: no flash of
    // "Sign in" for an account that is in fact signed in.
    expect(html).not.toContain("Sign in to continue");
    expect(html).not.toContain("Moderators only");
  });

  it("titles the page for the browser tab", () => {
    expect(metadata.title).toBe("Moderation console");
  });

  it("describes flags and appeals as well as the queue", () => {
    expect(metadata.description).toContain("flags");
    expect(metadata.description).toContain("appeals");
  });

  it("holds a place for flags and appeals but fetches neither on the server", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(<ModRoutePage />);

    // The session is only readable in the browser, so the server HTML is a
    // loading line: no flag, appeal or vote form can be in it.
    expect(html).toContain("Loading flags and appeals…");
    expect(html).not.toContain("Cast my vote");
    expect(html).not.toContain("Open a flag by its id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
