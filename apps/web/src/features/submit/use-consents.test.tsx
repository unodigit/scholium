// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsentReport, VersionRef } from "./consents";
import { useConsents } from "./use-consents";

const REF: VersionRef = { paper: "sch:abcd-efgh-ijkl", version: 1 };

function report(waiting: number, signed: number, declined = 0): ConsentReport {
  return {
    paper: REF.paper,
    version: 1,
    versionCid: "bafyreiexample",
    state: "awaiting_consent",
    count: waiting + signed + declined,
    waiting,
    signed,
    declined,
    authors: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Let the pending request settle, then move the clock. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useConsents", () => {
  it("does nothing without a version", async () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() => useConsents(null, { fetcher }));
    await tick(60_000);
    expect(result.current).toMatchObject({ phase: "idle", report: null, error: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks once on mount, then again every interval while someone is waiting", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(report(2, 1))
      .mockResolvedValueOnce(report(1, 2))
      .mockResolvedValueOnce(report(0, 3));
    const { result } = renderHook(() => useConsents(REF, { fetcher, intervalMs: 5_000 }));

    expect(result.current.phase).toBe("loading");
    await tick();
    expect(result.current).toMatchObject({ phase: "ready", error: null });
    expect(result.current.report?.waiting).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await tick(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.report?.waiting).toBe(1);

    await tick(5_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.report?.signed).toBe(3);
  });

  it("stops asking once nobody is waiting", async () => {
    const fetcher = vi.fn().mockResolvedValue(report(0, 3));
    renderHook(() => useConsents(REF, { fetcher, intervalMs: 1_000 }));
    await tick(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops asking after a decline, which sends the version back to draft", async () => {
    const fetcher = vi.fn().mockResolvedValue(report(1, 1, 1));
    renderHook(() => useConsents(REF, { fetcher, intervalMs: 1_000 }));
    await tick(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the last report on a failure, says so, and tries again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(report(1, 1))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(report(0, 2));
    const { result } = renderHook(() => useConsents(REF, { fetcher, intervalMs: 2_000 }));

    await tick();
    await tick(2_000);
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("Could not check who has signed. Trying again shortly.");
    expect(result.current.report?.waiting).toBe(1);

    await tick(2_000);
    expect(result.current).toMatchObject({ phase: "ready", error: null });
    expect(result.current.report?.signed).toBe(2);
  });

  it("does not poll at all when the interval is 0", async () => {
    const fetcher = vi.fn().mockResolvedValue(report(2, 0));
    renderHook(() => useConsents(REF, { fetcher, intervalMs: 0 }));
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts over for a different version, and aborts the old request on unmount", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_ref: VersionRef, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return report(1, 0);
    });
    const { rerender, unmount } = renderHook(({ ref }) => useConsents(ref, { fetcher, intervalMs: 1_000 }), {
      initialProps: { ref: REF },
    });
    await tick();
    rerender({ ref: { ...REF, version: 2 } });
    await tick();
    expect(fetcher.mock.calls.map(([ref]) => ref.version)).toEqual([1, 2]);
    expect(signals[0].aborted).toBe(true);

    unmount();
    expect(signals[1].aborted).toBe(true);
    await tick(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks again straight away on refresh()", async () => {
    const fetcher = vi.fn().mockResolvedValue(report(1, 0));
    const { result } = renderHook(() => useConsents(REF, { fetcher, intervalMs: 60_000 }));
    await tick();
    act(() => result.current.refresh());
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("is not restarted by a new fetcher function on every render", async () => {
    const fetcher = vi.fn().mockResolvedValue(report(1, 0));
    const { rerender } = renderHook(() => useConsents(REF, { fetcher: (...args) => fetcher(...args), intervalMs: 60_000 }));
    await tick();
    rerender();
    rerender();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
