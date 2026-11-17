// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { apiErrorFrom, NetworkError } from "../../lib/api";

import {
  describeVerifyEmailFailure,
  parseVerifyEmailLink,
  resendVerificationEmail,
  verifyEmailAddress,
  type VerifyEmailClient,
} from "./verify-email";

const DID = "did:key:z6MkrQDrTkUp4gGH7aUiPNDDT2B2DzAssL2wib7awcqYzKqG";
const TOKEN = "v1.payload.signature";

function fakeClient(post = vi.fn(async () => undefined)): VerifyEmailClient & {
  post: ReturnType<typeof vi.fn>;
} {
  return { post } as unknown as VerifyEmailClient & {
    post: ReturnType<typeof vi.fn>;
  };
}

describe("parseVerifyEmailLink", () => {
  it("reads the did and token the emailed link carries", () => {
    expect(parseVerifyEmailLink(`?did=${encodeURIComponent(DID)}&token=${TOKEN}`)).toEqual({
      did: DID,
      token: TOKEN,
    });
    expect(parseVerifyEmailLink(`did=${encodeURIComponent(DID)}&token=${TOKEN}`)).toEqual({
      did: DID,
      token: TOKEN,
    });
  });

  it("rejects a link that is missing either half", () => {
    expect(parseVerifyEmailLink("")).toBeNull();
    expect(parseVerifyEmailLink(`?did=${encodeURIComponent(DID)}`)).toBeNull();
    expect(parseVerifyEmailLink(`?did=${encodeURIComponent(DID)}&token=%20`)).toBeNull();
    expect(parseVerifyEmailLink("?token=abc")).toBeNull();
  });
});

describe("verifyEmailAddress", () => {
  it("posts the token to the profiles route for the DID in the link", async () => {
    const client = fakeClient();

    await verifyEmailAddress(client, { did: DID, token: TOKEN });

    expect(client.post).toHaveBeenCalledWith(
      `/profiles/${encodeURIComponent(DID)}/verify-email`,
      { token: TOKEN },
    );
  });
});

describe("resendVerificationEmail", () => {
  it("asks the API to send a fresh link to the account's address", async () => {
    const client = fakeClient();

    await resendVerificationEmail(client, DID);

    expect(client.post).toHaveBeenCalledWith(
      `/profiles/${encodeURIComponent(DID)}/verify-email/resend`,
    );
  });
});

describe("describeVerifyEmailFailure", () => {
  it("leads an expired or invalid link to the resend option", () => {
    const failure = describeVerifyEmailFailure(
      apiErrorFrom(400, {
        title: "Bad Request",
        detail: "The email verification link is invalid or has expired.",
      }),
    );

    expect(failure.expired).toBe(true);
    expect(failure.sessionExpired).toBe(false);
    expect(failure.message).toBe("The email verification link is invalid or has expired.");
  });

  it("treats a missing profile like an unusable link", () => {
    const failure = describeVerifyEmailFailure(
      apiErrorFrom(404, {
        title: "Not Found",
        detail: "There is no profile to verify for this DID.",
      }),
    );

    expect(failure.expired).toBe(true);
    expect(failure.message).toBe("There is no profile to verify for this DID.");
  });

  it("asks a signed-out visitor to sign in", () => {
    const failure = describeVerifyEmailFailure(
      apiErrorFrom(401, { title: "Unauthorized", detail: "Authentication is required." }),
    );

    expect(failure.sessionExpired).toBe(true);
    expect(failure.message).toContain("session has ended");
  });

  it("explains a network failure without calling the link expired", () => {
    const failure = describeVerifyEmailFailure(new NetworkError("offline"));

    expect(failure.expired).toBe(false);
    expect(failure.message).toContain("Can't reach Scholium");
  });
});
