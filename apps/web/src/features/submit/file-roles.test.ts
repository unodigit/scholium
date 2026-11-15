import { describe, expect, it } from "vitest";

import {
  FILE_ROLES,
  defaultRole,
  extensionOf,
  isArchive,
  isPaperFile,
  rolesFor,
  unsupportedMessage,
} from "./file-roles";

const named = (name: string, type = "") => ({ name, type });

describe("file roles", () => {
  it("reads the extension after the last dot, in lower case", () => {
    expect(extensionOf("Paper.TeX")).toBe("tex");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("dir.d/Makefile")).toBe("");
  });

  it("recognises archives, including double extensions", () => {
    expect(isArchive("source.zip")).toBe(true);
    expect(isArchive("source.TAR.GZ")).toBe(true);
    expect(isArchive("source.tgz")).toBe(true);
    expect(isArchive("source.tex")).toBe(false);
  });

  describe("paper zone", () => {
    it.each([
      ["paper.pdf", "pdf"],
      ["PAPER.PDF", "pdf"],
      ["main.tex", "source"],
      ["refs.bib", "source"],
      ["fig1.png", "source"],
      ["fig2.eps", "source"],
      ["source.zip", "source"],
      ["source.tar.gz", "source"],
    ])("puts %s down as %s", (name, role) => {
      expect(defaultRole(named(name), "paper")).toBe(role);
    });

    it("takes a PDF by its media type when the name does not say", () => {
      expect(defaultRole(named("download", "application/pdf"), "paper")).toBe("pdf");
    });

    it.each(["notes.docx", "results.csv", "analysis.py", "README"])("does not take %s", (name) => {
      expect(defaultRole(named(name), "paper")).toBeNull();
      expect(isPaperFile(named(name))).toBe(false);
    });
  });

  describe("code-and-data zone", () => {
    it.each([
      ["analysis.py", "code"],
      ["run.ipynb", "code"],
      ["model.R", "code"],
      ["build.rs", "code"],
      ["results.csv", "data"],
      ["samples.parquet", "data"],
      ["bundle.zip", "data"],
      ["README", "data"],
    ])("puts %s down as %s", (name, role) => {
      expect(defaultRole(named(name), "extras")).toBe(role);
    });

    it("treats a PDF dropped here as supplementary data, not the paper", () => {
      expect(defaultRole(named("appendix.pdf"), "extras")).toBe("data");
    });
  });

  it("only lets a real PDF be switched to the paper-PDF role", () => {
    expect(rolesFor(named("paper.pdf"))).toEqual([...FILE_ROLES]);
    expect(rolesFor(named("main.tex"))).toEqual(["source", "code", "data"]);
  });

  it("explains a refusal in the paper zone and points at the other zone", () => {
    expect(unsupportedMessage("paper")).toMatch(/PDF or LaTeX source/);
    expect(unsupportedMessage("paper")).toMatch(/Code and data/);
  });
});
