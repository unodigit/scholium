import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const home = readFileSync(join(here, "home.css"), "utf8");
const homeRules = home.replace(/\/\*[\s\S]*?\*\//g, "");
const provenance = readFileSync(join(here, "provenance.css"), "utf8");
const provenanceRules = provenance.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first `@media`/`@supports` block whose prelude is `query`. */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(query);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

describe("home.css", () => {
  it("constrains the hero stage at narrow widths", () => {
    expect(homeRules).toMatch(/\.stage\s*\{[^}]*max-width:\s*100%/);
    const narrow = homeRules.slice(homeRules.indexOf("@media (max-width: 900px)"));
    expect(narrow).toMatch(/\.stage\s*\{[^}]*max-width:\s*100%/);
  });

  it("lets the verified pill wrap inside the card at phone widths", () => {
    const narrow = mediaBlock(homeRules, "@media (max-width: 414px)");
    expect(narrow).not.toBe("");
    // The pill must be allowed to take the card's width instead of its
    // max-content width (it is ~348 px wide at 320–390 px viewports).
    expect(narrow).toMatch(/\.verify\s*\{[^}]*max-width:\s*100%/);
    // …and its text must be allowed to break, with the same cap per pill.
    expect(narrow).toMatch(/\.verify\s*>\s*span\s*\{[^}]*white-space:\s*normal/);
    expect(narrow).toMatch(/\.verify\s*>\s*span\s*\{[^}]*max-width:\s*100%/);
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