import { describe, expect, it } from "vitest";

import {
  CREDIT_ROLES,
  addAuthor,
  applyLookup,
  authorLabel,
  authorsBlockers,
  canContinueAuthors,
  initialAuthors,
  initials,
  moveAuthor,
  normalizeOrcid,
  orcidCheckCharacter,
  parseIdentifier,
  recordAuthors,
  removeAuthor,
  shortDid,
  sortCreditRoles,
  toggleCreditRole,
  withSubmitterDid,
  type DraftAuthor,
} from "./authors";

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ADA = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const ORCID = "0000-0002-1825-0097";

/** Add, failing the test if the input is refused. */
function add(authors: DraftAuthor[], input: string, name = ""): DraftAuthor[] {
  const result = addAuthor(authors, input, name);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.authors;
}

describe("ORCID iD", () => {
  it("computes the check character (ISO 7064 mod 11-2), including X", () => {
    expect(orcidCheckCharacter("000000021825009")).toBe("7");
    expect(orcidCheckCharacter("000000021694233")).toBe("X");
  });

  it("accepts every common spelling and returns the hyphenated iD", () => {
    for (const spelling of [
      "0000-0002-1825-0097",
      "0000000218250097",
      "https://orcid.org/0000-0002-1825-0097",
      "http://www.orcid.org/0000-0002-1825-0097",
      "orcid.org/0000-0002-1825-0097",
      "ORCID: 0000-0002-1825-0097",
      "  0000-0002-1825-0097  ",
    ]) {
      expect(normalizeOrcid(spelling)).toBe(ORCID);
    }
    expect(normalizeOrcid("0000-0002-1694-233x")).toBe("0000-0002-1694-233X");
  });

  it("refuses a wrong check digit and a wrong shape", () => {
    expect(normalizeOrcid("0000-0002-1825-0098")).toBeNull();
    expect(normalizeOrcid("0000-0002-1825")).toBeNull();
    expect(normalizeOrcid("abcd-0002-1825-0097")).toBeNull();
  });
});

describe("parseIdentifier", () => {
  it("tells a DID, an ORCID iD and an email apart", () => {
    expect(parseIdentifier(ADA)).toEqual({ ok: true, kind: "did", value: ADA });
    expect(parseIdentifier("https://orcid.org/0000-0002-1825-0097")).toEqual({
      ok: true,
      kind: "orcid",
      value: ORCID,
    });
    expect(parseIdentifier("  Ada@Example.ORG ")).toEqual({ ok: true, kind: "email", value: "ada@example.org" });
  });

  it("says what is wrong with each kind, in a sentence", () => {
    const bad = (input: string): string => {
      const result = parseIdentifier(input);
      if (result.ok) {
        throw new Error(`${input} should be refused`);
      }
      return result.message;
    };
    expect(bad("")).toContain("DID");
    expect(bad("did:key")).toContain("DID");
    expect(bad("did:key:has spaces")).toContain("DID");
    expect(bad("ada@")).toContain("email");
    expect(bad("ada@example")).toContain("email");
    expect(bad("0000-0002-1825-0098")).toContain("check digit");
    expect(bad("hello")).toContain("ORCID");
  });
});

describe("labels", () => {
  it("shortens a DID but leaves a short one alone", () => {
    expect(shortDid(ME)).toBe("did:key:z6MkhaXg…ta2doK");
    expect(shortDid("did:web:a.b")).toBe("did:web:a.b");
  });

  it("names an author by name, else 'You', else their identifier", () => {
    const [me] = initialAuthors(ME);
    expect(authorLabel(me)).toBe("You");
    expect(authorLabel({ ...me, name: "Mei Chen" })).toBe("Mei Chen");
    const roster = add(add(initialAuthors(ME), "ada@example.org"), ORCID);
    expect(authorLabel(roster[1])).toBe("ada@example.org");
    expect(authorLabel(roster[2])).toBe(ORCID);
    expect(authorLabel(add(initialAuthors(ME), ADA)[1])).toBe(shortDid(ADA));
  });

  it("makes avatar letters from a name and none from a bare identifier", () => {
    expect(initials("Mei Chen")).toBe("MC");
    expect(initials("Okafor")).toBe("O");
    expect(initials("Ana María de la Cruz")).toBe("AC");
    expect(initials("0000-0002-1825-0097")).toBeNull();
  });
});

describe("the roster", () => {
  it("starts with the submitter, matched once their DID is known", () => {
    expect(initialAuthors(ME)[0]).toMatchObject({ isSubmitter: true, did: ME, match: "matched" });
    expect(initialAuthors()[0]).toMatchObject({ isSubmitter: true, did: null, match: "unmatched" });
  });

  it("adds a DID as matched, and an ORCID iD or email as not yet matched", () => {
    const roster = add(add(add(initialAuthors(ME), ADA, "  Ada   Lovelace "), ORCID), "grace@example.org");
    expect(roster.map((a) => [a.kind, a.match, a.did])).toEqual([
      ["did", "matched", ME],
      ["did", "matched", ADA],
      ["orcid", "unmatched", null],
      ["email", "unmatched", null],
    ]);
    expect(roster[1].name).toBe("Ada Lovelace");
    expect(roster[2]).toMatchObject({ identifier: ORCID, orcid: ORCID });
  });

  it("refuses someone already listed, by any spelling of the same identifier", () => {
    let roster = add(initialAuthors(ME), ORCID);
    const again = addAuthor(roster, `https://orcid.org/${ORCID}`);
    expect(again).toEqual({ ok: false, message: `${ORCID} is already on the list.` });
    roster = add(roster, "Ada@example.org");
    expect(addAuthor(roster, "ada@EXAMPLE.org").ok).toBe(false);
    expect(addAuthor(roster, ME)).toEqual({ ok: false, message: "That is you, and you are already listed." });
  });

  it("gives every author a key that is never reused after a removal", () => {
    let roster = add(initialAuthors(ME), ADA);
    const firstKey = roster[1].key;
    roster = removeAuthor(roster, firstKey);
    roster = add(roster, ADA);
    expect(roster[1].key).not.toBe(firstKey);
  });

  it("removes a co-author but never the submitter", () => {
    const roster = add(initialAuthors(ME), ADA);
    expect(removeAuthor(roster, roster[1].key)).toHaveLength(1);
    expect(removeAuthor(roster, roster[0].key)).toHaveLength(2);
  });

  it("moves an author up and down the byline, and stops at the ends", () => {
    const roster = add(add(initialAuthors(ME), ADA, "Ada"), "grace@example.org", "Grace");
    const [, ada, grace] = roster;
    expect(moveAuthor(roster, grace.key, -1).map(authorLabel)).toEqual(["You", "Grace", "Ada"]);
    expect(moveAuthor(roster, ada.key, 1).map(authorLabel)).toEqual(["You", "Grace", "Ada"]);
    expect(moveAuthor(roster, roster[0].key, -1)).toEqual(roster);
    expect(moveAuthor(roster, grace.key, 1)).toEqual(roster);
    expect(moveAuthor(roster, "nobody", 1)).toEqual(roster);
  });

  it("does not change the list it was given", () => {
    const roster = add(initialAuthors(ME), ADA);
    const before = JSON.stringify(roster);
    moveAuthor(roster, roster[1].key, -1);
    toggleCreditRole(roster, roster[1].key, "Software");
    removeAuthor(roster, roster[1].key);
    expect(JSON.stringify(roster)).toBe(before);
  });

  it("folds a co-author added by the submitter's own DID into the submitter's row", () => {
    let roster = add(add(initialAuthors(), ADA, "Ada"), ME, "Mei Chen");
    roster = toggleCreditRole(roster, roster[2].key, "Software");
    const merged = withSubmitterDid(roster, ME);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      isSubmitter: true,
      did: ME,
      match: "matched",
      name: "Mei Chen",
      creditRoles: ["Software"],
    });
    expect(withSubmitterDid(merged, ME)).toEqual(merged);
  });
});

describe("CRediT roles", () => {
  it("lists the fourteen roles of the taxonomy", () => {
    expect(CREDIT_ROLES).toHaveLength(14);
    expect(CREDIT_ROLES[0].id).toBe("Conceptualization");
    expect(CREDIT_ROLES.map((role) => role.id)).toContain("Writing – review & editing");
    expect(new Set(CREDIT_ROLES.map((role) => role.id)).size).toBe(14);
  });

  it("toggles a role on and off, keeping the taxonomy's order", () => {
    let roster = add(initialAuthors(ME), ADA);
    const key = roster[1].key;
    roster = toggleCreditRole(roster, key, "Visualization");
    roster = toggleCreditRole(roster, key, "Conceptualization");
    roster = toggleCreditRole(roster, key, "Software");
    expect(roster[1].creditRoles).toEqual(["Conceptualization", "Software", "Visualization"]);
    roster = toggleCreditRole(roster, key, "Software");
    expect(roster[1].creditRoles).toEqual(["Conceptualization", "Visualization"]);
  });

  it("ignores a role the taxonomy does not have", () => {
    const roster = add(initialAuthors(ME), ADA);
    expect(toggleCreditRole(roster, roster[1].key, "Wizardry")[1].creditRoles).toEqual([]);
    expect(sortCreditRoles(["Software", "Wizardry", "Software", "Conceptualization"])).toEqual([
      "Conceptualization",
      "Software",
    ]);
  });
});

describe("matching an ORCID iD or email to an account", () => {
  it("fills in the DID, keeps a name the author typed, and adopts one they did not", () => {
    let roster = add(add(initialAuthors(ME), ORCID, "Josiah"), "grace@example.org");
    const [, byOrcid, byEmail] = roster;

    const first = applyLookup(roster, byOrcid.key, { did: ADA, name: "J. Carberry" });
    expect(first.ok).toBe(true);
    roster = first.authors;
    expect(roster[1]).toMatchObject({ did: ADA, name: "Josiah", match: "matched", orcid: ORCID });

    const second = applyLookup(roster, byEmail.key, { did: "did:web:grace.example", name: "Grace Hopper" });
    expect(second.authors[2]).toMatchObject({ did: "did:web:grace.example", name: "Grace Hopper", match: "matched" });
  });

  it("leaves them unmatched when nothing is found or the answer is not a DID", () => {
    const roster = add(initialAuthors(ME), ORCID);
    expect(applyLookup(roster, roster[1].key, null).authors[1].match).toBe("unmatched");
    expect(applyLookup(roster, roster[1].key, { did: "not-a-did" }).authors[1].match).toBe("unmatched");
  });

  it("drops the new row when the account is already on the list under another identifier", () => {
    const roster = add(add(initialAuthors(ME), ADA, "Ada"), "ada@example.org");
    const result = applyLookup(roster, roster[2].key, { did: ADA });
    expect(result.ok).toBe(false);
    expect(result.authors).toHaveLength(2);
    expect(!result.ok && result.message).toBe("Ada is already on the list under a different identifier.");
  });

  it("does nothing for an author who has since been removed", () => {
    const roster = add(initialAuthors(ME), ORCID);
    const gone = removeAuthor(roster, roster[1].key);
    expect(applyLookup(gone, roster[1].key, { did: ADA })).toEqual({ ok: true, authors: gone });
  });
});

describe("Continue", () => {
  it("is closed until every author has a role", () => {
    let roster = add(initialAuthors(ME), ADA, "Ada");
    expect(authorsBlockers(roster)).toEqual([
      "Choose at least one CRediT role for yourself.",
      "Choose at least one CRediT role for Ada.",
    ]);
    roster = toggleCreditRole(roster, roster[0].key, "Conceptualization");
    roster = toggleCreditRole(roster, roster[1].key, "Software");
    expect(canContinueAuthors(roster)).toBe(true);
    expect(authorsBlockers(roster)).toEqual([]);
  });

  it("is closed while an ORCID iD or email has no DID, naming who", () => {
    let roster = add(initialAuthors(ME), "grace@example.org", "Grace");
    roster = toggleCreditRole(roster, roster[0].key, "Conceptualization");
    roster = toggleCreditRole(roster, roster[1].key, "Software");
    expect(authorsBlockers(roster)).toEqual([
      "Grace is not matched to an account yet. Remove them, or add them by DID.",
    ]);
  });

  it("is closed when the submitter's own DID is not known", () => {
    let roster = initialAuthors();
    roster = toggleCreditRole(roster, roster[0].key, "Conceptualization");
    expect(authorsBlockers(roster)[0]).toBe("Sign in so your own DID can be listed as an author.");
  });
});

describe("recordAuthors", () => {
  it("lists DIDs in byline order with roles and 1-based positions, as paper.version expects", () => {
    let roster = add(add(initialAuthors(ME), ADA, "Ada"), ORCID);
    roster = applyLookup(roster, roster[2].key, { did: "did:web:josiah.example" }).authors;
    roster = toggleCreditRole(roster, roster[0].key, "Conceptualization");
    roster = toggleCreditRole(roster, roster[1].key, "Software");
    roster = toggleCreditRole(roster, roster[1].key, "Methodology");
    roster = moveAuthor(roster, roster[2].key, -1);

    expect(recordAuthors(roster)).toEqual([
      { did: ME, creditRoles: ["Conceptualization"], position: 1 },
      { did: "did:web:josiah.example", creditRoles: [], position: 2, orcid: ORCID },
      { did: ADA, creditRoles: ["Methodology", "Software"], position: 3, name: "Ada" },
    ]);
  });

  it("leaves out an author with no DID rather than listing a blank", () => {
    const roster = add(initialAuthors(ME), "grace@example.org");
    expect(recordAuthors(roster).map((a) => a.did)).toEqual([ME]);
  });
});
