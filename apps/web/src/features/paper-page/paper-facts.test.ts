import { describe, expect, it } from "vitest";

import { parseManifest, parseVersions } from "../paper-meta/meta";
import {
  authorDetail,
  authorLabel,
  latestVersionNumber,
  pdfAccess,
  shortDid,
  versionOfTotal,
} from "./paper-facts";
import { ALICE, MANIFEST_BODY, VERSIONS_BODY } from "./paper-page-fixtures";

/**
 * The small facts the header states: "v2 of 2", an author's name, and whether
 * the PDF can be opened. They are decisions about words, so they are pinned
 * here rather than inside markup.
 */

const versions = (...ns: number[]) =>
  parseVersions({
    ...VERSIONS_BODY,
    versions: ns.map((n) => ({ n, cid: `bafyrei-v${n}`, anchor: "pending" })),
  });

const manifest = (files: Array<Record<string, unknown>>) =>
  parseManifest({ ...MANIFEST_BODY, files });

const file = (overrides: Record<string, unknown> = {}) => ({
  path: "paper.pdf",
  cid: "bafkrei-pdf",
  size: 10,
  mediaType: "application/pdf",
  role: "manuscript",
  scanStatus: "passed",
  ...overrides,
});

describe("version of total", () => {
  it("reads v2 of 2", () => {
    expect(versionOfTotal(2, 2)).toBe("v2 of 2");
    expect(versionOfTotal(1, 3)).toBe("v1 of 3");
  });

  it("is just the version when the timeline is unknown: of ? would be a guess", () => {
    expect(versionOfTotal(2, null)).toBe("v2");
  });

  it("never says a version is later than the newest one", () => {
    expect(versionOfTotal(3, 2)).toBe("v3");
  });

  it("takes the total from the newest listed version", () => {
    expect(latestVersionNumber(versions(1, 2), 1)).toBe(2);
    expect(latestVersionNumber(versions(1, 2, 3), 3)).toBe(3);
  });

  it("is the number the authors signed, so a gap in the list does not shrink it", () => {
    // v2 was held back; the paper is still on v3, not "v3 of 2".
    expect(latestVersionNumber(versions(1, 3), 3)).toBe(3);
  });

  it("is never smaller than the version on screen", () => {
    expect(latestVersionNumber(versions(1), 2)).toBe(2);
  });

  it("is unknown when the timeline is unreadable or empty", () => {
    expect(latestVersionNumber(undefined, 2)).toBeNull();
    expect(latestVersionNumber(versions(), 2)).toBeNull();
  });
});

describe("authors", () => {
  it("shows the name from the profile", () => {
    expect(authorLabel({ did: ALICE, name: "Mei Zhang" })).toBe("Mei Zhang");
  });

  it("falls back to a shortened DID when there is no profile name", () => {
    expect(authorLabel({ did: ALICE, name: null })).toBe("did:key:z6MkhaXgBZ…2doK");
    expect(authorLabel({ did: ALICE, name: "   " })).toBe("did:key:z6MkhaXgBZ…2doK");
  });

  it("leaves a short DID whole", () => {
    expect(shortDid("did:web:example.org")).toBe("did:web:example.org");
  });

  it("keeps the full DID in the detail, so shortening never hides who the author is", () => {
    expect(
      authorDetail({
        did: ALICE,
        affiliation: "Example University",
        creditRoles: ["conceptualization", "writing"],
      }),
    ).toBe(`Example University · conceptualization, writing · ${ALICE}`);
    expect(authorDetail({ did: ALICE, affiliation: null, creditRoles: [] })).toBe(ALICE);
  });
});

describe("pdfAccess", () => {
  it("links the manuscript PDF through the node's content endpoint", () => {
    const access = pdfAccess(manifest([file()]), "https://node.example");

    expect(access).toEqual({
      kind: "available",
      url: "https://node.example/v1/content/bafkrei-pdf",
      name: "paper.pdf",
    });
  });

  it("prefers the manuscript when there are several PDFs", () => {
    const access = pdfAccess(
      manifest([
        file({ path: "supplement.pdf", cid: "bafkrei-supp", role: "supplement" }),
        file({ path: "paper.pdf", cid: "bafkrei-main", role: "manuscript" }),
      ]),
      "https://node.example",
    );
    expect(access).toMatchObject({ kind: "available", name: "paper.pdf" });
  });

  it("falls back to any PDF when none is the manuscript", () => {
    const access = pdfAccess(
      manifest([file({ path: "supplement.pdf", role: "supplement" })]),
      "https://node.example",
    );
    expect(access).toMatchObject({ kind: "available", name: "supplement.pdf" });
  });

  it("recognises a PDF by its extension when the media type is not declared", () => {
    const access = pdfAccess(manifest([file({ mediaType: null })]), "https://node.example");
    expect(access.kind).toBe("available");
  });

  it("does not take a non-PDF manuscript for a PDF", () => {
    const access = pdfAccess(
      manifest([file({ path: "paper.tex", mediaType: "text/x-tex" })]),
    );
    expect(access).toEqual({ kind: "unavailable", reason: "This version has no PDF." });
  });

  it("says when there is no PDF at all", () => {
    expect(pdfAccess(manifest([]))).toEqual({
      kind: "unavailable",
      reason: "This version has no PDF.",
    });
  });

  it("never links a PDF the node will not serve, and says why in the scan's own words", () => {
    expect(pdfAccess(manifest([file({ scanStatus: "scanning" })]))).toEqual({
      kind: "unavailable",
      reason: "The file is still being scanned. Download opens when it finishes.",
    });
    expect(pdfAccess(manifest([file({ scanStatus: "failed" })]))).toEqual({
      kind: "unavailable",
      reason: "The scan found active content, so the file is not served.",
    });
  });

  it("says the file list could not be read when there is no manifest", () => {
    expect(pdfAccess(undefined)).toEqual({
      kind: "unavailable",
      reason: "The file list could not be read, so the PDF cannot be opened.",
    });
  });
});
