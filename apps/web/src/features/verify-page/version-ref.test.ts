import { describe, expect, it } from "vitest";

import { EXAMPLE_VERSION_ID, parseVersionRef, proofHref } from "./version-ref";

const GOOD = "sch:6sel-2dio-orm6/v2"; // a real id from the shared vectors

describe("parseVersionRef", () => {
  it("reads a version id", () => {
    const parsed = parseVersionRef(GOOD);
    expect(parsed).toEqual({
      ok: true,
      ref: { shortId: "sch:6sel-2dio-orm6", version: 2, schId: GOOD },
    });
  });

  it("accepts the id as a paper page URL spells it: no sch: prefix", () => {
    expect(parseVersionRef("6sel-2dio-orm6/v2")).toMatchObject({ ok: true, ref: { schId: GOOD } });
  });

  it("ignores surrounding space and letter case, and returns the canonical id", () => {
    expect(parseVersionRef("  SCH:6SEL-2DIO-ORM6/V2\n")).toMatchObject({ ok: true, ref: { schId: GOOD } });
  });

  it("decodes an id that was percent-encoded in a link", () => {
    expect(parseVersionRef("sch%3A6sel-2dio-orm6%2Fv2")).toMatchObject({ ok: true, ref: { schId: GOOD } });
  });

  it("is not thrown by text that is not valid percent-encoding", () => {
    expect(parseVersionRef("100%")).toMatchObject({ ok: false });
  });

  it("explains an id that is not shaped like one, with an example", () => {
    for (const text of ["hello", "sch:", "sch:6sel-2dio/v2", "sch:6sel-2dio-orm6/v0", "sch:6sel-2dio-orm1/v2"]) {
      const parsed = parseVersionRef(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.message, text).toContain(EXAMPLE_VERSION_ID);
    }
  });

  it("tells a mistyped id from one that is merely unknown", () => {
    const parsed = parseVersionRef("sch:6sel-2dio-orm7/v2"); // last character changed
    expect(parsed).toEqual({ ok: false, message: expect.stringContaining("checksum") });
  });

  it("asks for the version when only the paper is named", () => {
    for (const text of ["sch:6sel-2dio-orm6", "6sel-2dio-orm6"]) {
      const parsed = parseVersionRef(text);
      expect(parsed, text).toEqual({ ok: false, message: expect.stringContaining("Add the version") });
    }
  });

  it("still reports a typo when the version is also missing", () => {
    expect(parseVersionRef("sch:6sel-2dio-orm7")).toEqual({
      ok: false,
      message: expect.stringContaining("checksum"),
    });
  });

  it("never throws, whatever it is given", () => {
    for (const value of ["", " ", "/", "sch:/v1", "\u0000", "sch:6sel-2dio-orm6/v99999999999"]) {
      expect(() => parseVersionRef(value)).not.toThrow();
    }
    expect(() => parseVersionRef(undefined as unknown as string)).not.toThrow();
  });

  it("gives the example in the placeholder an id that is itself valid", () => {
    expect(parseVersionRef(EXAMPLE_VERSION_ID).ok).toBe(true);
  });
});

describe("proofHref", () => {
  it("points at the Proof page for the same version, without the sch: prefix", () => {
    const parsed = parseVersionRef(GOOD);
    if (!parsed.ok) throw new Error("fixture");
    expect(proofHref(parsed.ref)).toBe("/proof/6sel-2dio-orm6/v2");
  });
});
