import { describe, expect, it } from "vitest";

import {
  FILE_MAX_BYTES,
  GIB,
  MIB,
  PDF_MAX_BYTES,
  SIZE_LIMITS,
  checkSize,
  formatBytes,
  formatExactBytes,
  isPdf,
  maxBytesFor,
  pluralize,
} from "./limits";

describe("pluralize", () => {
  it("uses the singular for exactly one, so the page never says '1 files'", () => {
    expect(pluralize(1, "file")).toBe("1 file");
  });

  it("uses the plural for zero and for more than one", () => {
    expect(pluralize(0, "file")).toBe("0 files");
    expect(pluralize(2, "file")).toBe("2 files");
    expect(pluralize(12, "co-author")).toBe("12 co-authors");
  });

  it("takes an irregular plural when the noun has one", () => {
    expect(pluralize(1, "category", "categories")).toBe("1 category");
    expect(pluralize(3, "category", "categories")).toBe("3 categories");
  });

  it("groups thousands for the reader", () => {
    expect(pluralize(1234, "reference")).toBe("1,234 references");
  });
});

describe("limits", () => {
  it("match the API: 50 MiB for a PDF, 5 GiB for everything else", () => {
    expect(PDF_MAX_BYTES).toBe(52_428_800);
    expect(FILE_MAX_BYTES).toBe(5_368_709_120);
  });

  it("states both limits in the words the page shows", () => {
    expect(SIZE_LIMITS.map((l) => `${l.label} ${l.limit}`)).toEqual([
      "PDF 50 MB",
      "LaTeX source, code and data 5 GB per file",
    ]);
  });

  describe("isPdf", () => {
    it("recognises a .pdf name in any case", () => {
      expect(isPdf({ name: "paper.pdf", type: "" })).toBe(true);
      expect(isPdf({ name: "PAPER.PDF", type: "" })).toBe(true);
    });

    it("recognises a PDF media type whatever the name", () => {
      expect(isPdf({ name: "download", type: "application/pdf" })).toBe(true);
      expect(isPdf({ name: "download", type: "application/x-pdf" })).toBe(true);
    });

    it("lets either signal win, as the server does, so a PDF cannot dodge its limit", () => {
      expect(isPdf({ name: "paper.pdf", type: "application/zip" })).toBe(true);
      expect(isPdf({ name: "paper.zip", type: "application/pdf" })).toBe(true);
    });

    it("rejects everything else", () => {
      expect(isPdf({ name: "paper.tex", type: "text/x-tex" })).toBe(false);
      expect(isPdf({ name: "pdf-notes.txt", type: "text/plain" })).toBe(false);
    });
  });

  it("picks the limit by kind", () => {
    expect(maxBytesFor({ name: "a.pdf", type: "" })).toBe(PDF_MAX_BYTES);
    expect(maxBytesFor({ name: "data.zip", type: "application/zip" })).toBe(FILE_MAX_BYTES);
  });

  describe("formatBytes", () => {
    it.each([
      [0, "0 B"],
      [512, "512 B"],
      [1024, "1.0 KB"],
      [5 * 1024, "5.0 KB"],
      [523 * 1024, "523 KB"],
      [MIB, "1.0 MB"],
      [Math.round(49.6 * MIB), "49.6 MB"],
      [50 * MIB, "50.0 MB"],
      [GIB, "1.0 GB"],
      [5 * GIB, "5.0 GB"],
    ])("formats %d bytes as %s", (bytes, expected) => {
      expect(formatBytes(bytes)).toBe(expected);
    });

    it("shows a dash for a size that is not a size", () => {
      expect(formatBytes(Number.NaN)).toBe("—");
      expect(formatBytes(-1)).toBe("—");
    });
  });

  it("formats an exact byte count with thousands separators", () => {
    expect(formatExactBytes(52_428_800)).toBe("52,428,800 bytes");
  });

  describe("checkSize", () => {
    const pdf = (size: number) => ({ name: "paper.pdf", type: "application/pdf", size });
    const zip = (size: number) => ({ name: "data.zip", type: "application/zip", size });

    it("accepts a PDF of exactly 50 MiB and a bundle of exactly 5 GiB", () => {
      expect(checkSize(pdf(PDF_MAX_BYTES))).toBeNull();
      expect(checkSize(zip(FILE_MAX_BYTES))).toBeNull();
    });

    it("refuses an empty file", () => {
      expect(checkSize(pdf(0))).toEqual({ code: "empty", message: "This file is empty." });
    });

    it("refuses a PDF one byte over 50 MiB and says both sizes exactly", () => {
      const problem = checkSize(pdf(PDF_MAX_BYTES + 1));
      expect(problem?.code).toBe("too-large");
      expect(problem?.message).toContain("52,428,801 bytes");
      expect(problem?.message).toContain("PDFs can be at most 50.0 MB (52,428,800 bytes)");
    });

    it("lets a 60 MiB bundle through that a 60 MiB PDF would not get", () => {
      expect(checkSize(zip(60 * MIB))).toBeNull();
      expect(checkSize(pdf(60 * MIB))?.code).toBe("too-large");
    });

    it("refuses a bundle over 5 GiB", () => {
      const problem = checkSize(zip(FILE_MAX_BYTES + 1));
      expect(problem?.code).toBe("too-large");
      expect(problem?.message).toContain("Files can be at most 5.0 GB");
    });
  });
});
