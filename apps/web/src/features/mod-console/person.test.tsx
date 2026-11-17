// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shortenDid } from "./decision";
import { PersonName, loadPersonName, type PersonClient } from "./person";

/** A stub API client answering every GET with `body` (or throwing `failure`). */
function fakeClient(body: unknown, failure?: Error): PersonClient {
  const get = failure
    ? vi.fn(async () => {
        throw failure;
      })
    : vi.fn(async () => body);
  return { get } as unknown as PersonClient;
}

/**
 * A DID in the console is a person: wherever the node knows a profile name
 * the console shows it, with the DID kept as secondary text; where it does
 * not, the DID stands in alone (verify sweep 2, #1: "DIDs everywhere").
 */

const REPORTER = "did:key:z6MkReporter000000000000000000000000000000000";
const AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PersonName", () => {
  it("shows the profile name with the DID as secondary text", async () => {
    render(
      <PersonName did={AUTHOR} loadName={async () => "Priya Nair"} />,
    );

    expect(await screen.findByText("Priya Nair")).toBeTruthy();
    const secondary = screen.getByText(shortenDid(AUTHOR));
    expect(secondary.className).toContain("mc-person-did");
    expect(secondary.getAttribute("title")).toBe(AUTHOR);
  });

  it("shows the DID alone while the profile loads and when none exists", async () => {
    render(
      <PersonName did={REPORTER} loadName={async () => null} />,
    );

    // The first paint is the DID, and it stays when no name exists.
    expect(screen.getByText(shortenDid(REPORTER))).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(shortenDid(REPORTER))).toBeTruthy(),
    );
    expect(screen.queryByText("mc-person-did")).toBeNull();
  });

  it("keeps the DID when the profile read fails", async () => {
    render(
      <PersonName
        did={REPORTER}
        loadName={async () => {
          throw new Error("network down");
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText(shortenDid(REPORTER))).toBeTruthy(),
    );
  });

  it("renders nothing for an empty DID", () => {
    const { container } = render(<PersonName did="" />);
    expect(container.textContent).toBe("");
  });
});

describe("loadPersonName", () => {
  it("reads the name the public profile carries", async () => {
    const client = fakeClient({
      did: AUTHOR,
      name: "Sam Okafor",
      affiliation: null,
      orcid: null,
    });
    expect(await loadPersonName(AUTHOR, client)).toBe("Sam Okafor");
  });

  it("reads a blank or erased profile as no name", async () => {
    for (const body of [
      { did: AUTHOR, name: "   " },
      { did: AUTHOR },
      { did: AUTHOR, erased: true, name: "Sam Okafor" },
    ]) {
      expect(await loadPersonName(AUTHOR, fakeClient(body))).toBeNull();
    }
  });

  it("answers null when the profile cannot be read", async () => {
    expect(
      await loadPersonName(AUTHOR, fakeClient(null, new Error("404"))),
    ).toBeNull();
  });
});
