import { describe, expect, it, vi } from "vitest";

import {
  NO_OFFER,
  SIGNED_OUT,
  loadPaperAuthors,
  offerFor,
  parseAuthorDids,
  viewerFromToken,
  type AuthorsClient,
  type Viewer,
} from "./viewer";

/** An unsigned JWT with the given claims: the card never checks the signature. */
function token(claims: unknown): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const AUTHOR = "did:key:z6MkAuthor";
const MEMBER = "did:key:z6MkMember";

function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return { signedIn: true, did: MEMBER, tier: 3, ...overrides };
}

describe("viewerFromToken", () => {
  it("reads the DID and the tier the API puts in the access token", () => {
    expect(viewerFromToken(token({ sub: MEMBER, tier: 3, aud: "scholium" }))).toEqual({
      signedIn: true,
      did: MEMBER,
      tier: 3,
    });
  });

  it("is signed out without a token", () => {
    expect(viewerFromToken(null)).toEqual(SIGNED_OUT);
    expect(viewerFromToken(undefined)).toEqual(SIGNED_OUT);
    expect(viewerFromToken("")).toEqual(SIGNED_OUT);
  });

  it("is signed in with an unknown DID and tier when the token is not a JWT", () => {
    const unknown = { signedIn: true, did: null, tier: null };
    expect(viewerFromToken("access-jwt")).toEqual(unknown);
    expect(viewerFromToken("a.b.c")).toEqual(unknown);
    expect(viewerFromToken(`a.${Buffer.from("not json").toString("base64url")}.c`)).toEqual(
      unknown,
    );
    expect(viewerFromToken(token("a string"))).toEqual(unknown);
    expect(viewerFromToken(token(null))).toEqual(unknown);
  });

  it("ignores a tier outside 0-4 or one that is not a whole number", () => {
    for (const tier of [5, -1, 2.5, "3", null, true]) {
      expect(viewerFromToken(token({ sub: MEMBER, tier })).tier).toBeNull();
    }
    expect(viewerFromToken(token({ sub: MEMBER, tier: 0 })).tier).toBe(0);
    expect(viewerFromToken(token({ sub: MEMBER, tier: 4 })).tier).toBe(4);
  });

  it("ignores a subject that is not a non-empty string", () => {
    expect(viewerFromToken(token({ sub: "", tier: 3 })).did).toBeNull();
    expect(viewerFromToken(token({ sub: 7, tier: 3 })).did).toBeNull();
  });
});

describe("offerFor", () => {
  it("offers nothing to a signed-out reader", () => {
    expect(offerFor(SIGNED_OUT, [AUTHOR])).toEqual(NO_OFFER);
    expect(offerFor(SIGNED_OUT, null)).toEqual(NO_OFFER);
  });

  it("offers the reply form to an author, and not the rating", () => {
    expect(offerFor(viewer({ did: AUTHOR, tier: 2 }), [AUTHOR, "did:key:z6MkOther"])).toEqual({
      reply: true,
      rate: false,
    });
  });

  it("does not offer an author the rating even at tier 3: the API refuses authors", () => {
    expect(offerFor(viewer({ did: AUTHOR, tier: 3 }), [AUTHOR])).toEqual({
      reply: true,
      rate: false,
    });
  });

  it("offers the rating to a tier-3 member who is not an author, and not the reply form", () => {
    expect(offerFor(viewer(), [AUTHOR])).toEqual({ reply: false, rate: true });
    expect(offerFor(viewer({ tier: 4 }), [AUTHOR])).toEqual({ reply: false, rate: true });
  });

  it("offers nothing to a signed-in reader below tier 3 who is not an author", () => {
    for (const tier of [0, 1, 2]) {
      expect(offerFor(viewer({ tier }), [AUTHOR])).toEqual(NO_OFFER);
    }
  });

  it("lets an unknown tier through, because the API reads the current tier", () => {
    expect(offerFor(viewer({ tier: null }), [AUTHOR])).toEqual({ reply: false, rate: true });
  });

  it("keeps the reply form out of the way when the byline or the viewer's DID is unknown", () => {
    expect(offerFor(viewer({ did: AUTHOR }), null).reply).toBe(false);
    expect(offerFor(viewer({ did: null }), [AUTHOR]).reply).toBe(false);
  });
});

describe("parseAuthorDids", () => {
  it("reads the DIDs from the paper's authors, in order, without repeats", () => {
    expect(
      parseAuthorDids({
        authors: [
          { did: AUTHOR, author: AUTHOR, position: 1 },
          { author: "did:key:z6MkSecond" },
          "did:key:z6MkThird",
          { did: AUTHOR },
        ],
      }),
    ).toEqual([AUTHOR, "did:key:z6MkSecond", "did:key:z6MkThird"]);
  });

  it("never throws on a body that is not a paper", () => {
    for (const body of [null, undefined, 7, "x", [], {}, { authors: "nope" }, { authors: [null, 3, {}] }]) {
      expect(parseAuthorDids(body)).toEqual([]);
    }
  });
});

/** A stand-in API client whose `get` answers `body` (or throws), and records its calls. */
function fakeClient(body: unknown): { get: ReturnType<typeof vi.fn>; client: AuthorsClient } {
  const get = vi.fn(async (_path: string, _options?: unknown) => {
    if (body instanceof Error) throw body;
    return body;
  });
  return { get, client: { get } as unknown as AuthorsClient };
}

describe("loadPaperAuthors", () => {
  it("reads the paper's public detail, without the account, and returns the byline", async () => {
    const { get, client } = fakeClient({ authors: [{ did: AUTHOR }] });

    await expect(
      loadPaperAuthors("sch:6sel-2dio-orm6", undefined, client),
    ).resolves.toEqual([AUTHOR]);

    expect(get).toHaveBeenCalledWith(
      "/papers/sch%3A6sel-2dio-orm6",
      expect.objectContaining({ auth: false, cache: "no-store" }),
    );
  });

  it("asks for the paper, not for one of its versions", async () => {
    const { get, client } = fakeClient({ authors: [] });

    await loadPaperAuthors("sch:6sel-2dio-orm6/v2", undefined, client);

    expect(get).toHaveBeenCalledWith(
      "/papers/sch%3A6sel-2dio-orm6",
      expect.anything(),
    );
  });

  it("lets a failed read reach the caller", async () => {
    const { client } = fakeClient(new Error("offline"));

    await expect(loadPaperAuthors("sch:6sel-2dio-orm6", undefined, client)).rejects.toThrow(
      "offline",
    );
  });
});
