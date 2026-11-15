// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasskeyCancelledError } from "./errors";
import type { SignInOptions, SignInResult } from "./signin";
import { SIGNIN_UNSUPPORTED_MESSAGE } from "./signin-messages";
import { useSignIn, type SignInAuth } from "./use-signin";

const RESULT: SignInResult = {
  did: "did:key:z6MkExample",
  isNewAccount: true,
  redirectTo: "/onboarding",
  tokens: { accessToken: "a", refreshToken: "r" },
};

function makeAuth(overrides: Partial<SignInAuth> = {}) {
  const auth = {
    isSupported: vi.fn(() => true),
    signIn: vi.fn(async (_options: SignInOptions) => RESULT),
    ...overrides,
  };
  return auth as SignInAuth & {
    signIn: ReturnType<typeof vi.fn>;
    isSupported: ReturnType<typeof vi.fn>;
  };
}

/** A sign-in the test finishes (or fails) by hand. */
function deferredAuth() {
  let resolve: (value: SignInResult) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  let options: SignInOptions | undefined;
  const auth = makeAuth({
    signIn: vi.fn(
      (given: SignInOptions) =>
        new Promise<SignInResult>((res, rej) => {
          options = given;
          resolve = res;
          reject = rej;
        }),
    ),
  });
  return {
    auth,
    resolve: (value: SignInResult) => resolve(value),
    reject: (reason: unknown) => reject(reason),
    progress: (stage: Parameters<NonNullable<SignInOptions["onProgress"]>>[0]) =>
      options?.onProgress?.(stage),
  };
}

afterEach(() => {
  cleanup();
});

describe("useSignIn", () => {
  it("starts idle and supported", async () => {
    const auth = makeAuth();
    const { result } = renderHook(() => useSignIn({ navigate: vi.fn(), auth }));

    expect(result.current).toMatchObject({
      working: false,
      done: false,
      progress: "",
      error: null,
    });
    await waitFor(() => expect(auth.isSupported).toHaveBeenCalled());
    expect(result.current.unsupported).toBe(false);
  });

  it("signs in and navigates a new account to /onboarding", async () => {
    const auth = makeAuth();
    const navigate = vi.fn();
    const { result } = renderHook(() => useSignIn({ navigate, auth }));

    await act(async () => {
      await result.current.start();
    });

    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/onboarding");
    expect(result.current).toMatchObject({ done: true, working: false, error: null });
    expect(result.current.progress).toMatch(/Signed in/);
  });

  it("passes next through and navigates where the sign-in says", async () => {
    const auth = makeAuth({
      signIn: vi.fn(async () => ({ ...RESULT, isNewAccount: false, redirectTo: "/submit" })),
    });
    const navigate = vi.fn();
    const { result } = renderHook(() => useSignIn({ next: "/submit", navigate, auth }));

    await act(async () => {
      await result.current.start();
    });

    expect(auth.signIn).toHaveBeenCalledWith(expect.objectContaining({ next: "/submit" }));
    expect(navigate).toHaveBeenCalledWith("/submit");
  });

  it("reports each stage while the sign-in runs", async () => {
    const run = deferredAuth();
    const { result } = renderHook(() => useSignIn({ navigate: vi.fn(), auth: run.auth }));

    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = result.current.start();
    });
    expect(result.current.working).toBe(true);
    expect(result.current.progress).toBe("Starting…");

    act(() => run.progress("creating-passkey"));
    expect(result.current.progress).toMatch(/Creating your passkey/);

    act(() => run.progress("waiting-for-passkey"));
    expect(result.current.progress).toMatch(/Confirm with your passkey/);

    await act(async () => {
      run.resolve(RESULT);
      await started;
    });
    expect(result.current.working).toBe(false);
    expect(result.current.done).toBe(true);
  });

  it("ignores a second start while the first is still running", async () => {
    const run = deferredAuth();
    const { result } = renderHook(() => useSignIn({ navigate: vi.fn(), auth: run.auth }));

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.start();
    });
    await act(async () => {
      await result.current.start();
    });
    expect(run.auth.signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      run.resolve(RESULT);
      await first;
    });
  });

  it("explains a dismissed prompt, stays on the page, and allows a retry", async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(new PasskeyCancelledError())
      .mockResolvedValueOnce(RESULT);
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useSignIn({ navigate, auth: makeAuth({ signIn }) }),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toMatch(/prompt was closed/);
    expect(result.current).toMatchObject({ working: false, done: false, progress: "" });
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.error).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/onboarding");
  });

  it("does not report a navigation failure as a failed sign-in", async () => {
    const navigate = vi.fn(() => {
      throw new Error("router unavailable");
    });
    const { result } = renderHook(() => useSignIn({ navigate, auth: makeAuth() }));

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow("router unavailable");
    });

    expect(result.current.error).toBeNull();
    expect(result.current.done).toBe(true);
  });

  it("flags an unsupported browser after mount and still lets start run", async () => {
    const auth = makeAuth({ isSupported: vi.fn(() => false) });
    const { result } = renderHook(() => useSignIn({ navigate: vi.fn(), auth }));

    await waitFor(() => expect(result.current.unsupported).toBe(true));
    expect(SIGNIN_UNSUPPORTED_MESSAGE).toMatch(/passkey/);
  });

  it("does not update state after unmount", async () => {
    const run = deferredAuth();
    const navigate = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useSignIn({ navigate, auth: run.auth }));

    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = result.current.start();
    });
    unmount();
    await act(async () => {
      run.reject(new PasskeyCancelledError());
      await started;
    });

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
