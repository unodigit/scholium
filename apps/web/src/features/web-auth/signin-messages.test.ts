// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError } from "./errors";
import { SignInError } from "./signin";
import {
  SIGNIN_FALLBACK_MESSAGE,
  SIGNIN_STAGE_MESSAGES,
  SIGNIN_UNSUPPORTED_MESSAGE,
  describeSignInError,
} from "./signin-messages";

function apiError(status: number): ApiError {
  return new ApiError(status, { type: "about:blank", title: "Problem", status });
}

describe("describeSignInError", () => {
  it("tells the user a dismissed passkey prompt can simply be retried", () => {
    expect(describeSignInError(new PasskeyCancelledError())).toMatch(/closed.*try again/i);
  });

  it("explains a failed passkey check", () => {
    expect(describeSignInError(new DeviceKeyError("passkey-failed", "x"))).toMatch(
      /PIN or biometric/,
    );
  });

  it("explains an unsupported browser", () => {
    expect(describeSignInError(new DeviceKeyError("unsupported", "x"))).toBe(
      SIGNIN_UNSUPPORTED_MESSAGE,
    );
  });

  it("explains blocked storage", () => {
    expect(describeSignInError(new DeviceKeyError("storage-unavailable", "x"))).toMatch(
      /blocking local storage/,
    );
  });

  it("explains an offline server", () => {
    expect(describeSignInError(new NetworkError("http://api.test/v1/auth/challenge"))).toMatch(
      /connection/,
    );
  });

  it.each([
    [401, /couldn.t verify/],
    [429, /too many attempts/i],
    [500, /trouble/],
    [503, /trouble/],
  ])("explains API status %i", (status, pattern) => {
    expect(describeSignInError(apiError(status))).toMatch(pattern);
  });

  it("falls back for an unexpected API status", () => {
    expect(describeSignInError(apiError(418))).toBe(SIGNIN_FALLBACK_MESSAGE);
  });

  it("explains a malformed server reply", () => {
    expect(describeSignInError(new SignInError("invalid-response", "x"))).toMatch(
      /unexpected reply/,
    );
  });

  it.each([new Error("boom"), "boom", null, undefined])("falls back for %j", (error) => {
    expect(describeSignInError(error)).toBe(SIGNIN_FALLBACK_MESSAGE);
  });

  it("never leaks internals into the copy", () => {
    const messages = [
      describeSignInError(new DeviceKeyError("passkey-failed", "secret internal detail")),
      describeSignInError(new Error("secret internal detail")),
      describeSignInError(apiError(500)),
      ...Object.values(SIGNIN_STAGE_MESSAGES),
    ];
    for (const message of messages) {
      expect(message).not.toMatch(/secret internal detail|token|nonce|\bCID\b|hash|blockchain/i);
    }
  });
});
