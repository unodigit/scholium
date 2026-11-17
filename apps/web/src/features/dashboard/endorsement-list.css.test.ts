import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for endorsement-list.css against docs/design.md §3 and §9.
 *
 * The stylesheet is read as shipped so a hard-coded colour, a link that loses
 * its focus ring, or a touch target that is too small fails here rather than
 * in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "endorsement-list.css"), "utf8");
/** Rules only: the header comment deliberately names colours and tokens. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("endorsement-list.css", () => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("keeps the endorser's underline: a link must not rest on colour alone", () => {
    expect(rules).not.toMatch(/text-decoration(?:-line)?:\s*none/);
  });

  it("keeps keyboard focus visible on the endorser link", () => {
    expect(rules).toMatch(
      /\.endorsement-endorser:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s,
    );
  });

  it("lets a long pseudonymous DID break instead of overflowing the card", () => {
    expect(rules).toMatch(/\.endorsement-endorser\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it("gives touch readers a 44 px target (docs/design.md §9)", () => {
    expect(rules).toMatch(
      /@media \(pointer: coarse\)\s*\{[^@]*\.endorsement-endorser[^@]*min-block-size:\s*44px/s,
    );
  });
});
