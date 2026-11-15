// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import {
  PaperResponseError,
  describePaperError,
  loadPaperPage,
  paperPath,
  parsePaper,
  parsePaperRoute,
  parseProfile,
  type PaperClient,
} from "./paper";

const PAPER = {
  paper: "sch:abcd-efgh-jklm",
  shortId: "sch:abcd-efgh-jklm",
  paperCid: "bafy-paper",
  versionCid: "bafy-version-2",
  cid: "bafy-version-2",
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract: "An evaluation framework for meta-agents.",
  authors: [
    {
      did: "did:key:zMei",
      author: "did:key:zMei",
      position: 1,
      creditRoles: ["Conceptualization"],
    },
    {
      did: "did:key:zAnon",
      author: "did:key:zAnon",
      position: 2,
      creditRoles: null,
    },
  ],
  categories: ["cs.AI", "cs.MA"],
  licence: "CC-BY-4.0",
  status: "reviewed",
  notices: [],
};

function fakeClient(
  routes: Record<string, unknown | Error>,
): PaperClient & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (path: string) => {
    const answer = routes[path];
    if (answer === undefined) {
      throw new Error(`no stub for ${path}`);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  });
  return { get } as unknown as PaperClient & {
    get: ReturnType<typeof vi.fn>;
  };
}

describe("parsePaperRoute", () => {
  it("accepts a paper id and a version id", () => {
    expect(parsePaperRoute(["sch:k3f9-q2xz-7mwd"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: null,
    });
    expect(parsePaperRoute(["sch:k3f9-q2xz-7mwd", "v2"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: 2,
    });
  });

  it("decodes a percent-encoded sch: colon", () => {
    expect(parsePaperRoute(["sch%3Ak3f9-q2xz-7mwd", "v2"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: 2,
    });
  });

  it("canonicalises case and accepts a record cid", () => {
    expect(parsePaperRoute(["SCH:K3F9-Q2XZ-7MWD", "v3"])).toEqual({
      id: "sch:k3f9-q2xz-7mwd",
      version: 3,
    });
    expect(parsePaperRoute(["bafyreipapercid", "v1"])).toEqual({
      id: "bafyreipapercid",
      version: 1,
    });
  });

  it("rejects anything that is not a paper address", () => {
    expect(parsePaperRoute([])).toBeNull();
    expect(parsePaperRoute(["sch:k3f9-q2xz-7mwd", "v2", "extra"])).toBeNull();
    expect(parsePaperRoute(["sch:k3f9-q2xz-7mwd", "2"])).toBeNull();
    expect(parsePaperRoute(["not a cid"])).toBeNull();
  });

  it("builds the API path for an address", () => {
    expect(paperPath({ id: "sch:k3f9-q2xz-7mwd", version: null })).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd",
    );
    expect(paperPath({ id: "sch:k3f9-q2xz-7mwd", version: 2 })).toBe(
      "/papers/sch%3Ak3f9-q2xz-7mwd/v2",
    );
  });
});

describe("parsePaper", () => {
  it("maps the catalog response", () => {
    const paper = parsePaper(PAPER);

    expect(paper.title).toBe(PAPER.title);
    expect(paper.shortId).toBe("sch:abcd-efgh-jklm");
    expect(paper.versionCid).toBe("bafy-version-2");
    expect(paper.n).toBe(2);
    expect(paper.authors.map((author) => author.did)).toEqual([
      "did:key:zMei",
      "did:key:zAnon",
    ]);
    expect(paper.authors[0]).toMatchObject({
      position: 1,
      creditRoles: ["Conceptualization"],
      name: null,
    });
    expect(paper.categories).toEqual(["cs.AI", "cs.MA"]);
    expect(paper.licence).toBe("CC-BY-4.0");
    expect(paper.status).toBe("reviewed");
  });

  it("accepts a bare DID as an author", () => {
    const paper = parsePaper({ title: "A paper", authors: ["did:key:zMei"] });
    expect(paper.authors.map((author) => author.did)).toEqual(["did:key:zMei"]);
  });

  it("refuses a body that is not a paper", () => {
    expect(() => parsePaper(null)).toThrow(PaperResponseError);
    expect(() => parsePaper({ abstract: "no title" })).toThrow(
      "The API did not return a paper.",
    );
  });
});

describe("parseProfile", () => {
  it("reads the public name, affiliation and ORCID iD", () => {
    expect(
      parseProfile(
        {
          did: "did:key:zMei",
          name: "Mei Zhang",
          affiliation: "Example University",
          orcid: "0000-0002-1825-0097",
          tier: 2,
        },
        "did:key:zMei",
      ),
    ).toEqual({
      did: "did:key:zMei",
      name: "Mei Zhang",
      affiliation: "Example University",
      orcid: "0000-0002-1825-0097",
    });
  });

  it("hides personal members after erasure", () => {
    expect(
      parseProfile({
        did: "did:key:zMei",
        name: "Mei Zhang",
        erased: true,
      }),
    ).toMatchObject({ name: null, affiliation: null, orcid: null });
  });
});

describe("loadPaperPage", () => {
  it("pairs each author DID with their profile name, in byline order", async () => {
    const client = fakeClient({
      "/papers/sch%3Aabcd-efgh-jklm/v2": PAPER,
      "/profiles/did%3Akey%3AzMei": { did: "did:key:zMei", name: "Mei Zhang", affiliation: "Example University" },
      "/profiles/did%3Akey%3AzAnon": new ApiError(404, { status: 404, detail: "no profile" }),
    });

    const paper = await loadPaperPage(
      { id: "sch:abcd-efgh-jklm", version: 2 },
      client,
    );

    expect(paper.authors[0]).toMatchObject({
      did: "did:key:zMei",
      name: "Mei Zhang",
      affiliation: "Example University",
    });
    // No readable profile: the author is still listed, by DID.
    expect(paper.authors[1]).toMatchObject({
      did: "did:key:zAnon",
      name: null,
    });
  });
});

describe("describePaperError", () => {
  it("explains a paper this node does not list", () => {
    expect(
      describePaperError(new ApiError(404, { status: 404, detail: "gone" })),
    ).toContain("No paper with that id is listed");
  });

  it("names a transport failure", () => {
    expect(
      describePaperError(new NetworkError("http://api.test")),
    ).toContain("Couldn’t reach the API");
  });

  it("uses a parse failure's own sentence", () => {
    expect(describePaperError(new PaperResponseError("bad body"))).toBe(
      "bad body",
    );
  });
});
