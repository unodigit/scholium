import { describe, expect, it } from "vitest";

import {
  PaperRefError,
  parsePaperRef,
  refFromSegments,
} from "./paper-ref";

// A real id from the shared vectors, so the checksum is genuine.
const PAPER = "sch:6sel-2dio-orm6";

describe("parsePaperRef", () => {
  it("reads a paper id", () => {
    expect(parsePaperRef(PAPER)).toEqual({ shortId: PAPER, version: null, schId: PAPER });
  });

  it("reads a version id", () => {
    expect(parsePaperRef(`${PAPER}/v2`)).toEqual({
      shortId: PAPER,
      version: 2,
      schId: `${PAPER}/v2`,
    });
  });

  it("canonicalises case and surrounding space", () => {
    expect(parsePaperRef(`  SCH:6SEL-2DIO-ORM6/V3 `).schId).toBe(`${PAPER}/v3`);
  });

  it("rejects an id whose checksum is wrong, however the last character changes", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (const char of alphabet.replace("6", "")) {
      expect(() => parsePaperRef(`sch:6sel-2dio-orm${char}`)).toThrow(PaperRefError);
    }
  });

  it.each(["", "k3f9-q2xz-7mwd", "sch:6sel-2dio", `${PAPER}/v0`, `${PAPER}/2`, `${PAPER}/v2/x`])(
    "rejects %j",
    (text) => {
      expect(() => parsePaperRef(text)).toThrow(PaperRefError);
    },
  );
});

describe("refFromSegments", () => {
  it("takes the segments of a paper page URL, which have no sch: prefix", () => {
    expect(refFromSegments(["6sel-2dio-orm6"]).schId).toBe(PAPER);
    expect(refFromSegments(["6sel-2dio-orm6", "v2"]).schId).toBe(`${PAPER}/v2`);
  });

  it("accepts the sch: prefix, plain or percent-encoded", () => {
    expect(refFromSegments([PAPER, "v2"]).schId).toBe(`${PAPER}/v2`);
    expect(refFromSegments(["sch%3A6sel-2dio-orm6", "v2"]).schId).toBe(`${PAPER}/v2`);
  });

  it("rejects no segments, too many segments and a bad version", () => {
    expect(() => refFromSegments([])).toThrow(/Expected a paper id/);
    expect(() => refFromSegments(["6sel-2dio-orm6", "v2", "extra"])).toThrow(/Expected a paper id/);
    expect(() => refFromSegments(["6sel-2dio-orm6", "two"])).toThrow(PaperRefError);
  });

  it("does not throw on text that is not valid URL escaping", () => {
    expect(() => refFromSegments(["100%"])).toThrow(PaperRefError);
  });
});
