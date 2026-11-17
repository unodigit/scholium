import { describe, expect, it } from "vitest";

import { initials } from "./initials";

describe("initials", () => {
  it("takes the first and last name initial", () => {
    expect(initials("Mei Chen")).toBe("MC");
    expect(initials("Okafor")).toBe("O");
    expect(initials("Ana María de la Cruz")).toBe("AC");
  });

  it.each([
    ["Dr. Tunde Okafor", "TO"],
    ["Dr Tunde Okafor", "TO"],
    ["Prof. Ada Lovelace", "AL"],
    ["Mr. Alan Turing", "AT"],
    ["Ms. Grace Hopper", "GH"],
    ["Mrs. Katherine Johnson", "KJ"],
    ["Mx. Alex Rivera", "AR"],
    ["Sir Tim Berners", "TB"],
    ["Dame Jane Goodall", "JG"],
  ])("skips the title in %j", (label, expected) => {
    expect(initials(label)).toBe(expected);
  });

  it("matches honorifics whatever their case", () => {
    expect(initials("DR. TUNDE OKAFOR")).toBe("TO");
    expect(initials("prof. ada lovelace")).toBe("AL");
  });

  it("uses the one name that is left when the title is dropped", () => {
    expect(initials("Dr. Okafor")).toBe("O");
    expect(initials("Dr. Keller")).toBe("K");
  });

  it("gives no letters for an identifier, an empty label or only a title", () => {
    expect(initials("0000-0002-1825-0097")).toBeNull();
    expect(initials("")).toBeNull();
    expect(initials("Dr.")).toBeNull();
  });
});
