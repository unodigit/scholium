import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";

import {
  FOLLOWS_ENDPOINT,
  FollowError,
  describeFollowError,
  followCategory,
  followEndpoint,
  followSigninHref,
  loadFollowedCategories,
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
