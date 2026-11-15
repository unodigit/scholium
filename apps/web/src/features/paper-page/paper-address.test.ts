import { describe, expect, it } from "vitest";

import { parsePaperAddress } from "./paper-address";

/**
 * `/p/{id}` and `/p/{id}/v{n}`: which paper a URL names. Paper URLs drop the
 * `sch:` prefix (docs/design.md §4), but the search page links with it and a
 * search hit without a short id falls back to a record cid, so all three
 * spellings must keep working now that this page owns the route.
 */

describe("parsePaperAddress", () => {
  it("reads a short id written without its sch: prefix", () => {
    expect(parsePaperAddress(["k3f9-q2xz-7mwd"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: null,
    });
  });

  it("reads a version", () => {
    expect(parsePaperAddress(["k3f9-q2xz-7mwd", "v2"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: 2,
    });
  });

  it("accepts the sch: prefix, plain or percent-encoded", () => {
    expect(parsePaperAddress(["sch:k3f9-q2xz-7mwd", "v3"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: 3,
    });
    expect(parsePaperAddress(["sch%3Ak3f9-q2xz-7mwd"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: null,
    });
  });

  it("is case-insensitive and answers the canonical lowercase id", () => {
    expect(parsePaperAddress(["K3F9-Q2XZ-7MWD"])?.id).toBe("sch:k3f9-q2xz-7mwd");
  });

  it("accepts a record cid, as a search hit with no short id links to", () => {
    expect(parsePaperAddress(["bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soitae"])).toEqual({
      id: "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5kpqcsgz7soitae",
      version: null,
    });
  });

  it.each([
    ["no segments", []],
    ["too many segments", ["k3f9-q2xz-7mwd", "v2", "extra"]],
    ["a version of 0", ["k3f9-q2xz-7mwd", "v0"]],
    ["a bare number as the version", ["k3f9-q2xz-7mwd", "2"]],
    ["a word as the version", ["k3f9-q2xz-7mwd", "latest"]],
    ["a version with a sign", ["k3f9-q2xz-7mwd", "v-1"]],
    ["a malformed short id", ["k3f9-q2xz"]],
    ["a blank id", ["  "]],
    ["something that is not an id", ["not an id!"]],
  ])("is not an address: %s", (_name, segments) => {
    expect(parsePaperAddress(segments)).toBeNull();
  });

  it("does not check the checksum: the API says whether the paper exists", () => {
    // 6sel-2dio-orm7 has a bad checksum; it is still a well-formed address, so
    // the page answers "not listed on this node", not "not an address".
    expect(parsePaperAddress(["6sel-2dio-orm7"])?.id).toBe("sch:6sel-2dio-orm7");
  });
});
