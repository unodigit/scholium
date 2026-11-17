// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadMyReviews, MyReview } from "./my-reviews";
import { useMyReviews } from "./use-my-reviews";

/** The read of the reviewer's own reviews: only when asked, and never stale. */

afterEach(cleanup);

const REVIEW: MyReview = {
  reviewCid: "bafycommit",
  paper: "sch:6sel-2dio-orm6",
  versionCid: "bafyv1",
  sealed: true,
  revealed: false,
  version: 1,
  recommendation: null,
  confidence: null,
  scores: null,
  revealedAt: null,
};

describe("useMyReviews", () => {
  it("makes no request while it is not enabled", () => {
    const load = vi.fn<LoadMyReviews>(async () => [REVIEW]);

    const { result } = renderHook(() => useMyReviews(false, "p", load));

    expect(result.current.status).toBe("idle");
    expect(load).not.toHaveBeenCalled();
  });

  it("is loading from the render in which it is enabled, then ready", async () => {
    const load = vi.fn<LoadMyReviews>(async () => [REVIEW]);

    const { result, rerender } = renderHook(
      ({ enabled }) => useMyReviews(enabled, "p", load),
      { initialProps: { enabled: false } },
    );
    rerender({ enabled: true });

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({ status: "ready", reviews: [REVIEW] });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is failed, not thrown, when the read fails", async () => {
    const load: LoadMyReviews = vi.fn(async () => {
      throw new Error("offline");
    });

    const { result } = renderHook(() => useMyReviews(true, "p", load));

    await waitFor(() => expect(result.current.status).toBe("failed"));
  });

  it("starts over, rather than show the earlier answer, when the question changes", async () => {
    let release: (reviews: readonly MyReview[]) => void = () => undefined;
    const load = vi
      .fn<LoadMyReviews>()
      .mockResolvedValueOnce([REVIEW])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

    const { result, rerender } = renderHook(({ key }) => useMyReviews(true, key, load), {
      initialProps: { key: "one" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ key: "two" });
    expect(result.current.status).toBe("loading");

    await act(async () => release([]));
    await waitFor(() => expect(result.current).toEqual({ status: "ready", reviews: [] }));
  });

  it("ignores an answer that arrives after it was disabled", async () => {
    let release: (reviews: readonly MyReview[]) => void = () => undefined;
    const load = vi.fn<LoadMyReviews>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ enabled }) => useMyReviews(enabled, "p", load),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    await act(async () => release([REVIEW]));

    expect(result.current.status).toBe("idle");
  });
});
