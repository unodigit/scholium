import { describe, expect, it } from "vitest";

import { compareFile, baseName, type FileFacts } from "./compare";
import {
  CANNOT_CHECK_HEADLINE,
  CHECKING_HEADLINE,
  MATCH_HEADLINE,
  MISMATCH_HEADLINE,
  UNREADABLE_HEADLINE,
  VERDICT_LOOKS,
  deriveVerdict,
  filesPhrase,
  manifestStateFor,
  type FileState,
  type ManifestState,
} from "./verdict";
import { SIGNED_BYTES, VERSION_ID, manifest, versionRef } from "./verify-fixtures";
import { fileCid } from "../paper-proof/files";

const REF = versionRef();
const MANIFEST = manifest();
const READY: ManifestState = { status: "ready", manifest: MANIFEST };

/** A file the browser has read: `bytes` under `name`, with the id the browser computed. */
function readFile(bytes: Uint8Array, name: string): FileState {
  return { status: "ready", file: { name, size: bytes.length, cid: fileCid(bytes) } };
}

const MAIN = SIGNED_BYTES["main.pdf"];
const OTHER = new TextEncoder().encode("a different file entirely");

describe("the sentences the spec asks for", () => {
  it("says exactly what the authors-signed wording is", () => {
    expect(MISMATCH_HEADLINE).toBe("This file does not match what the authors signed");
    expect(MATCH_HEADLINE).toBe("This file matches what the authors signed");
  });
});

describe("compareFile", () => {
  const facts = (bytes: Uint8Array, name: string): FileFacts => ({ name, size: bytes.length, cid: fileCid(bytes) });

  it("matches a file whose id is a signed id, whatever it is called", () => {
    const result = compareFile(facts(MAIN, "downloaded (1).pdf"), MANIFEST);
    expect(result).toEqual({ kind: "match", matches: [MANIFEST.files[0]] });
  });

  it("matches every path that lists the same contents", () => {
    const twice = manifest({
      files: [
        ...(MANIFEST.files.map((file) => ({ ...file, mediaType: "application/pdf" })) as unknown[]),
        { ...MANIFEST.files[0], path: "copy/main.pdf", mediaType: "application/pdf" },
      ],
    });
    const result = compareFile(facts(MAIN, "main.pdf"), twice);
    expect(result.kind === "match" && result.matches.map((file) => file.path)).toEqual(["main.pdf", "copy/main.pdf"]);
  });

  it("does not match a file that differs by a single byte", () => {
    const edited = Uint8Array.from(MAIN);
    edited[edited.length - 1] ^= 1;
    expect(compareFile(facts(edited, "main.pdf"), MANIFEST).kind).toBe("mismatch");
  });

  it("does not match a file that is the signed contents plus something appended", () => {
    const longer = new Uint8Array(MAIN.length + 1);
    longer.set(MAIN);
    expect(compareFile(facts(longer, "main.pdf"), MANIFEST).kind).toBe("mismatch");
  });

  it("points at the signed file of the same name when the contents differ", () => {
    const result = compareFile(facts(OTHER, "MAIN.pdf"), MANIFEST);
    expect(result).toEqual({ kind: "mismatch", sameName: MANIFEST.files[0] });
  });

  it("finds a same-named file inside a folder of the bundle", () => {
    const result = compareFile(facts(OTHER, "results.csv"), MANIFEST);
    expect(result).toEqual({ kind: "mismatch", sameName: MANIFEST.files[1] });
  });

  it("has no same-named file to point at when none shares the name", () => {
    expect(compareFile(facts(OTHER, "notes.txt"), MANIFEST)).toEqual({ kind: "mismatch", sameName: null });
  });

  it("is exact about ids: the same id in another spelling is not a match", () => {
    const upper = { name: "main.pdf", size: MAIN.length, cid: fileCid(MAIN).toUpperCase() };
    expect(compareFile(upper, MANIFEST).kind).toBe("mismatch");
  });

  it("reads the last part of a path as its name", () => {
    expect(baseName("figures/fig1.png")).toBe("fig1.png");
    expect(baseName("main.pdf")).toBe("main.pdf");
  });
});

describe("deriveVerdict", () => {
  it("is a hint, not a verdict, until there is something to compare", () => {
    const empty = deriveVerdict({ ref: null, manifest: { status: "idle" }, file: { status: "idle" } });
    expect(empty).toMatchObject({
      kind: "idle",
      headline: null,
      summary: "Enter a version id and drop a file to compare them.",
    });

    const idOnly = deriveVerdict({ ref: REF, manifest: READY, file: { status: "idle" } });
    expect(idOnly).toMatchObject({
      kind: "idle",
      headline: null,
      summary: `Drop a file to compare it with the 2 files signed for ${VERSION_ID}.`,
    });

    const idLoading = deriveVerdict({ ref: REF, manifest: { status: "loading" }, file: { status: "idle" } });
    expect(idLoading.summary).toBe(`Drop a file to compare it with the files signed for ${VERSION_ID}.`);
  });

  it("asks for the id when the file is read but no version is named", () => {
    const verdict = deriveVerdict({ ref: null, manifest: { status: "idle" }, file: readFile(MAIN, "main.pdf") });
    expect(verdict.kind).toBe("idle");
    expect(verdict.summary).toContain("Enter the version id");
  });

  it("shows progress while the file is read, and says it is not uploaded", () => {
    const verdict = deriveVerdict({
      ref: REF,
      manifest: READY,
      file: { status: "hashing", name: "big.bin", size: 1000, hashed: 250 },
    });
    expect(verdict).toMatchObject({
      kind: "checking",
      headline: CHECKING_HEADLINE,
      progress: { hashed: 250, total: 1000 },
    });
    expect(verdict.summary).toContain("big.bin");
    expect(verdict.summary).toContain("not uploaded");
  });

  it("is checking while the signed list loads for a file that is already read", () => {
    const verdict = deriveVerdict({ ref: REF, manifest: { status: "loading" }, file: readFile(MAIN, "main.pdf") });
    expect(verdict).toMatchObject({ kind: "checking", headline: CHECKING_HEADLINE, progress: null });
    expect(verdict.summary).toContain(VERSION_ID);
  });

  describe("a file that is one of the signed files", () => {
    const verdict = deriveVerdict({ ref: REF, manifest: READY, file: readFile(MAIN, "main.pdf") });

    it("says it matches, and which signed file it is", () => {
      expect(verdict.kind).toBe("match");
      expect(verdict.headline).toBe(MATCH_HEADLINE);
      expect(verdict.summary).toBe(`It is main.pdf (manuscript), one of the 2 files signed for ${VERSION_ID}.`);
      expect(verdict.canRetry).toBe(false);
    });

    it("has nothing to add when the file has the signed name", () => {
      expect(verdict.details).toEqual([]);
    });

    it("explains that a renamed copy is no problem", () => {
      const renamed = deriveVerdict({ ref: REF, manifest: READY, file: readFile(MAIN, "download (3).pdf") });
      expect(renamed.kind).toBe("match");
      expect(renamed.details).toEqual([expect.stringContaining("compared by their contents")]);
    });
  });

  describe("a file that is none of the signed files", () => {
    it("says This file does not match what the authors signed", () => {
      const verdict = deriveVerdict({ ref: REF, manifest: READY, file: readFile(OTHER, "notes.txt") });

      expect(verdict.kind).toBe("mismatch");
      expect(verdict.headline).toBe("This file does not match what the authors signed");
      expect(verdict.summary).toBe(
        `It is not one of the 2 files signed for ${VERSION_ID}. Do not rely on it as the authors' version.`,
      );
    });

    it("does not blame the file only: it may be another version", () => {
      const verdict = deriveVerdict({ ref: REF, manifest: READY, file: readFile(OTHER, "notes.txt") });
      expect(verdict.details.join(" ")).toContain("may belong to a different version");
    });

    it("compares sizes when a signed file has the same name", () => {
      const smaller = deriveVerdict({ ref: REF, manifest: READY, file: readFile(OTHER, "main.pdf") });
      expect(smaller.details[0]).toBe(
        `main.pdf is signed for this version, but yours is ${OTHER.length} B and the signed file is ${MAIN.length} B.`,
      );

      const sameSize = new Uint8Array(MAIN.length).fill(7);
      const equal = deriveVerdict({ ref: REF, manifest: READY, file: readFile(sameSize, "main.pdf") });
      expect(equal.details[0]).toBe(
        `main.pdf is signed for this version and is also ${MAIN.length} bytes, but its contents differ.`,
      );
    });

    it("has no same-name line when no signed file shares the name", () => {
      const verdict = deriveVerdict({ ref: REF, manifest: READY, file: readFile(OTHER, "notes.txt") });
      expect(verdict.details).toHaveLength(1);
    });
  });

  describe("when the evidence could not be obtained", () => {
    it("is grey 'Could not check', says it is not about the file, and offers to try again", () => {
      const verdict = deriveVerdict({
        ref: REF,
        manifest: { status: "unavailable", message: "Scholium could not reach the node. You may be offline." },
        file: readFile(MAIN, "main.pdf"),
      });

      expect(verdict.kind).toBe("cannot_check");
      expect(verdict.headline).toBe(CANNOT_CHECK_HEADLINE);
      expect(verdict.summary).toContain("could not reach the node");
      expect(verdict.summary).toContain("does not mean the file is wrong");
      expect(verdict.canRetry).toBe(true);
      expect(verdict.headline).not.toBe(MISMATCH_HEADLINE);
    });

    it("says so even before a file is dropped, so a mistyped id is found early", () => {
      const verdict = deriveVerdict({
        ref: REF,
        manifest: { status: "unavailable", message: "This node has no published sch:x." },
        file: { status: "idle" },
      });
      expect(verdict.kind).toBe("cannot_check");
    });

    it("is also 'could not check' when the file itself cannot be read, never a mismatch", () => {
      const verdict = deriveVerdict({
        ref: REF,
        manifest: READY,
        file: { status: "unreadable", name: "gone.pdf", message: "The file could not be read." },
      });
      expect(verdict).toMatchObject({
        kind: "cannot_check",
        headline: UNREADABLE_HEADLINE,
        summary: "The file could not be read.",
        canRetry: false,
      });
    });
  });

  it("looks red only for a mismatch, green only for a match, grey for the rest", () => {
    expect(VERDICT_LOOKS.mismatch).toEqual({ icon: "cross", tone: "critical" });
    expect(VERDICT_LOOKS.match).toEqual({ icon: "check", tone: "verified" });
    expect(VERDICT_LOOKS.checking.tone).toBe("neutral");
    expect(VERDICT_LOOKS.cannot_check.tone).toBe("neutral");
    // Each state has a silhouette of its own: colour is never the only signal.
    const icons = Object.values(VERDICT_LOOKS).map((look) => look.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("filesPhrase", () => {
  it("counts files", () => {
    expect(filesPhrase(1)).toBe("1 file");
    expect(filesPhrase(3)).toBe("3 files");
  });
});

describe("manifestStateFor", () => {
  const OTHER_REF = versionRef("sch:6sel-2dio-orm6/v3");
  const loaded = { schId: VERSION_ID, state: READY };

  it("has nothing to say without a version", () => {
    expect(manifestStateFor(null, loaded)).toEqual({ status: "idle" });
    expect(manifestStateFor(null, null)).toEqual({ status: "idle" });
  });

  it("uses the answer received for this very version", () => {
    expect(manifestStateFor(REF, loaded)).toBe(READY);
    const failed = { schId: VERSION_ID, state: { status: "unavailable", message: "Offline." } } as const;
    expect(manifestStateFor(REF, failed)).toBe(failed.state);
  });

  it("does not use the answer for a version the reader has moved away from", () => {
    // Version 2's list is in hand and holds the file; the reader has just moved
    // to version 3, whose answer has not arrived. Version 2's must not count.
    expect(manifestStateFor(OTHER_REF, loaded)).toEqual({ status: "loading" });
  });

  it("is loading until the first answer arrives", () => {
    expect(manifestStateFor(REF, null)).toEqual({ status: "loading" });
  });
});
