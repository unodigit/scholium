import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const home = readFileSync(join(here, "home.css"), "utf8");
const homeRules = home.replace(/\/\*[\s\S]*?\*\//g, "");
const provenance = readFileSync(join(here, "provenance.css"), "utf8");
const provenanceRules = provenance.replace(/\/\*[\s\S]*?\*\//g, "");

describe("home.css", () => {
  it("constrains the hero stage at narrow widths", () => {
    expect(homeRules).toMatch(/\.stage\s*\{[^}]*max-width:\s*100%/);
    const narrow = homeRules.slice(homeRules.indexOf("@media (max-width: 900px)"));
    expect(narrow).toMatch(/\.stage\s*\{[^}]*max-width:\s*100%/);
  });

  it("gives the no-JS nav a solid background", () => {
    expect(homeRules).toMatch(/html:not\(\[data-home-js\]\)\s*\.nav\s*\{[^}]*background:\s*var\(--bg\)/);
    expect(homeRules).toMatch(/html:not\(\[data-home-js\]\)\s*\.nav::before\s*\{[^}]*opacity:\s*1/);
  });
});

describe("provenance.css", () => {
  it("keeps the tampered v2 block visible", () => {
    expect(provenanceRules).toMatch(/html\[data-home-js\]\s*#signed\s*\.demo\[data-state="bad"\]\s*\.block\.v2\s*\{[^}]*opacity:\s*1/);
    expect(provenanceRules).toContain("@keyframes prov-shake");
    expect(provenance).toMatch(/@keyframes prov-shake[\s\S]*opacity:\s*1/);
  });
});