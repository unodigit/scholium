import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, type ApiClient } from "../../lib/api";

import {
  FOLLOWS_ENDPOINT,
  FollowError,
  describeFollowError,
  followCategory,
  followEndpoint,
  followHref,
  followKind,
  followSigninHref,
  loadFollowedCategories,
  loadFollowedSubjects,
  parseFollowedCategories,
  unfollowCategory,
} from "./follows";

describe("follow endpoints", () => {
  it("addresses one category under /me/follows", () => {
    expect(FOLLOWS_ENDPOINT).toBe("/me/follows");
    expect(followEndpoint("cs.AI")).toBe("/me/follows/cs.AI");
  });

  it("trims and percent-encodes the category, so it stays one path segment", () => {
    expect(followEndpoint("  cs.AI ")).toBe("/me/follows/cs.AI");
    expect(followEndpoint("math/ph")).toBe("/me/follows/math%2Fph");
  });

  it("returns to the category page after sign-in", () => {
    expect(followSigninHref("cs.AI")).toBe("/signin?next=%2Fc%2Fcs.AI");
  });
});

describe("what a follow addresses", () => {
  const PAPER = "sch:z7im-izv3-lom6";
  const PERSON = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

  it("tells papers, people and categories apart by their ids", () => {
    expect(followKind("cs.AI")).toBe("category");
    expect(followKind(PAPER)).toBe("paper");
    expect(followKind(` ${PAPER} `)).toBe("paper");
    expect(followKind(PERSON)).toBe("person");
  });

  it("links each kind to the page that shows it, never to /c/", () => {
    expect(followHref("cs.AI")).toBe("/c/cs.AI");
    // The design drops the `sch:` prefix from a paper page's URL.
    expect(followHref(PAPER)).toBe("/p/z7im-izv3-lom6");
    expect(followHref(PERSON)).toBe(`/u/${encodeURIComponent(PERSON)}`);
  });

  it("returns to the followed subject's page after sign-in", () => {
    expect(followSigninHref(PAPER)).toBe(
      `/signin?next=${encodeURIComponent("/p/z7im-izv3-lom6")}`,
    );
    // `next` decodes once to the profile's href, which encodes the DID's colons.
    expect(followSigninHref(PERSON)).toBe(
      `/signin?next=${encodeURIComponent(`/u/${encodeURIComponent(PERSON)}`)}`,
    );
  });
});

describe("loadFollowedSubjects", () => {
  const PAPER = "sch:z7im-izv3-lom6";
  const PERSON = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

  /** A client that answers the follows read and the two lookups. */
  function client(failing: readonly string[] = []) {
    const routes: Record<string, unknown> = {
      "/me/follows": { categories: ["cs.AI", PAPER, PERSON] },
      [`/papers/${encodeURIComponent(PAPER)}`]: { title: "Pulsar timing" },
      [`/profiles/${encodeURIComponent(PERSON)}`]: { name: "Ada Lovelace" },
    };
    const get = vi.fn(async (path: string) => {
      if (failing.includes(path) || !(path in routes)) {
        throw new ApiError(404, { title: "Not Found" });
      }
      return routes[path];
    });
    return { get } as unknown as Pick<ApiClient, "get"> & {
      get: ReturnType<typeof vi.fn>;
    };
  }

  it("labels a paper by title, a person by name, and a category by its id", async () => {
    const subjects = await loadFollowedSubjects(client());

    // The follows read is alphabetical; `did:` sorts before `sch:`.
    expect(subjects).toEqual([
      { id: "cs.AI", kind: "category", label: "cs.AI", href: "/c/cs.AI" },
      {
        id: PERSON,
        kind: "person",
        label: "Ada Lovelace",
        href: `/u/${encodeURIComponent(PERSON)}`,
      },
      {
        id: PAPER,
        kind: "paper",
        label: "Pulsar timing",
        href: "/p/z7im-izv3-lom6",
      },
    ]);
  });

  it("reads public lookups without a token", async () => {
    const api = client();
    await loadFollowedSubjects(api);

    expect(api.get).toHaveBeenCalledWith(`/profiles/${encodeURIComponent(PERSON)}`, {
      auth: false,
      cache: "no-store",
    });
  });

  it("keeps the follow, with its id as the label, when a lookup fails", async () => {
    const subjects = await loadFollowedSubjects(
      client([
        `/papers/${encodeURIComponent(PAPER)}`,
        `/profiles/${encodeURIComponent(PERSON)}`,
      ]),
    );

    expect(subjects.map((subject) => subject.label)).toEqual([
      "cs.AI",
      PERSON,
      "z7im-izv3-lom6",
    ]);
    expect(subjects.map((subject) => subject.href)).toEqual([
      "/c/cs.AI",
      `/u/${encodeURIComponent(PERSON)}`,
      "/p/z7im-izv3-lom6",
    ]);
  });
});

describe("parseFollowedCategories", () => {
  it("reads {categories: [...]} and a bare array", () => {
    expect(parseFollowedCategories({ categories: ["cs.CR", "cs.AI"] })).toEqual([
      "cs.AI",
      "cs.CR",
    ]);
    expect(parseFollowedCategories(["cs.AI"])).toEqual(["cs.AI"]);
  });

  it("reads entries written as {category}", () => {
    expect(parseFollowedCategories({ categories: [{ category: "cs.MA" }] })).toEqual([
      "cs.MA",
    ]);
  });

  it("drops blanks and non-strings, trims, and de-duplicates", () => {
    expect(
      parseFollowedCategories(["cs.AI", " cs.AI ", "", "  ", 7, null, { nope: 1 }]),
    ).toEqual(["cs.AI"]);
  });

  it("treats an empty list as follows-nothing", () => {
    expect(parseFollowedCategories({ categories: [] })).toEqual([]);
  });

  it.each([null, undefined, "cs.AI", 3, {}, { categories: "cs.AI" }])(
    "rejects %j rather than reading it as follows-nothing",
    (payload) => {
      expect(() => parseFollowedCategories(payload)).toThrow(FollowError);
    },
  );
});

describe("follow calls", () => {
  it("loads the followed categories with an uncached GET", async () => {
    const get = vi.fn().mockResolvedValue({ categories: ["cs.AI"] });
    await expect(loadFollowedCategories({ get })).resolves.toEqual(["cs.AI"]);
    expect(get).toHaveBeenCalledWith("/me/follows", { cache: "no-store" });
  });

  it("follows with PUT and unfollows with DELETE on the category", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const del = vi.fn().mockResolvedValue(undefined);
    await followCategory("cs.AI", { put });
    await unfollowCategory("cs.AI", { delete: del });
    expect(put).toHaveBeenCalledWith("/me/follows/cs.AI");
    expect(del).toHaveBeenCalledWith("/me/follows/cs.AI");
  });

  it("lets an API failure through for the caller to describe", async () => {
    const put = vi.fn().mockRejectedValue(new ApiError(422, { detail: "bad category" }));
    await expect(followCategory("cs.AI", { put })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("describeFollowError", () => {
  it("asks an unauthenticated reader to sign in, in the verb they used", () => {
    const error = new ApiError(401, { detail: "No token." });
    expect(describeFollowError(error, true)).toBe("Sign in to follow categories.");
    expect(describeFollowError(error, false)).toBe("Sign in to unfollow categories.");
  });

  it("passes the API's detail through for other statuses", () => {
    expect(describeFollowError(new ApiError(422, { detail: "Too long." }), true)).toBe(
      "Too long.",
    );
  });

  it("explains an unreachable API", () => {
    expect(describeFollowError(new NetworkError("/v1/me/follows/cs.AI"), true)).toMatch(
      /could not reach the API/,
    );
  });

  it("falls back to a sentence naming the action", () => {
    expect(describeFollowError("boom", true)).toBe("Couldn’t follow this category.");
    expect(describeFollowError(undefined, false)).toBe("Couldn’t unfollow this category.");
    expect(describeFollowError(new Error("custom"), true)).toBe("custom");
  });
});
