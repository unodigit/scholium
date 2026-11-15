// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChecksVersionRef, VersionChecks } from "./checks";
import { useChecks } from "./use-checks";

const REF: ChecksVersionRef = { paper: "sch:abcd-efgh-ijkl", version: 1 };

function report(overrides: Partial<VersionChecks> = {}): VersionChecks {
  return {
    paper: REF.paper,
    version: 1,
    versionCid: "bafyreiexample",
    state: "scanning",
    files: [
      {
        path: "paper.pdf",
        cid: "bafkreiexample",
        role: "pdf",
        status: "scanning",
        failedChecks: [],
        detail: null,
      },
    ],
    referencesTotal: null,
    referencesUnresolved: null,
    similarityPct: null,
    metadataMatch: null,
    signedTitle: null,
    firstPageTitle: null,
    checkedAt: null,
    ...overrides,
  };
}

const FINISHED: VersionChecks = {
  ...report(),
  state: "moderation",
  files: [
    {
      path: "paper.pdf",
      cid: "bafkreiexample",
      role: "pdf",
      status: "passed",
      failedChecks: [],
      detail: null,
    },
  ],
  referencesTotal: 10,
  referencesUnresolved: 0,
  similarityPct: 2,
  metadataMatch: true,
};

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

describe("useChecks", () => {
  it("does nothing without a version", async () => {
    const fetcher = vi.fn();
    const { result } = renderHook(() => useChecks(null, { fetcher }));
    await tick(60_000);
    expect(result.current).toMatchObject({ phase: "idle", report: null, error: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks once on mount, then again every interval while the version is scanning", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(report())
      .mockResolvedValueOnce(report({ similarityPct: 2 }))
      .mockResolvedValueOnce(FINISHED);
    const { result } = renderHook(() => useChecks(REF, { fetcher, intervalMs: 5_000 }));

    expect(result.current.phase).toBe("loading");
    await tick();
    expect(result.current).toMatchObject({ phase: "ready", error: null });
    expect(result.current.report?.state).toBe("scanning");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await tick(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.report?.similarityPct).toBe(2);

    await tick(5_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.report?.state).toBe("moderation");
  });

  it("stops asking once the checks are finished", async () => {
    const fetcher = vi.fn().mockResolvedValue(FINISHED);
    renderHook(() => useChecks(REF, { fetcher, intervalMs: 1_000 }));
    await tick(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while a file is still being scanned, even after the version leaves scanning", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        report({ state: "moderation", files: [{ ...report().files[0], status: "scanning" }] }),
      )
      .mockResolvedValueOnce(FINISHED);
    renderHook(() => useChecks(REF, { fetcher, intervalMs: 1_000 }));
    await tick();
    await tick(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last report on a failure, says so, and tries again", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(report())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(FINISHED);
    const { result } = renderHook(() => useChecks(REF, { fetcher, intervalMs: 2_000 }));

    await tick();
    await tick(2_000);
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toBe("Could not check this version. Trying again shortly.");
    expect(result.current.report?.state).toBe("scanning");

    await tick(2_000);
    expect(result.current).toMatchObject({ phase: "ready", error: null });
    expect(result.current.report?.state).toBe("moderation");
  });

  it("does not poll at all when the interval is 0", async () => {
    const fetcher = vi.fn().mockResolvedValue(report());
    renderHook(() => useChecks(REF, { fetcher, intervalMs: 0 }));
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks again when refresh is called, even after it stopped polling", async () => {
    const fetcher = vi.fn().mockResolvedValue(FINISHED);
    const { result } = renderHook(() => useChecks(REF, { fetcher, intervalMs: 1_000 }));
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("starts over for a different version, and aborts the old request on unmount", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_ref: ChecksVersionRef, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return report();
    });
    const { rerender, unmount } = renderHook(
      ({ ref }) => useChecks(ref, { fetcher, intervalMs: 1_000 }),
      { initialProps: { ref: REF } },
    );
    await tick();
    expect(signals).toHaveLength(1);

    rerender({ ref: { paper: REF.paper, version: 2 } });
    await tick();
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(fetcher).toHaveBeenLastCalledWith({ paper: REF.paper, version: 2 }, signals[1]);

    unmount();
    expect(signals[1].aborted).toBe(true);
  });
});
