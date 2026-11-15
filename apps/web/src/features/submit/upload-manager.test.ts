import { describe, expect, it, vi } from "vitest";

import { FingerprintAborted } from "./fingerprint";
import { MIB } from "./limits";
import type { UploadFailure } from "./tus-upload";
import {
  UploadManager,
  completedFiles,
  continueBlocker,
  hasActiveUploads,
  summarize,
  type FileEntry,
  type ManagerDeps,
} from "./upload-manager";

const CID_A = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CID_B = "bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A File whose reported size is `size`, without allocating that many bytes. */
function file(name: string, size = 1000, type = ""): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

interface FakeUpload {
  file: File;
  init: { role: string; fresh?: boolean };
  callbacks: Parameters<NonNullable<ManagerDeps["startUpload"]>>[2];
  stop: ReturnType<typeof vi.fn>;
}

interface FakeHash {
  file: File;
  signal: AbortSignal | undefined;
  progress: (hashed: number, total: number) => void;
  resolve: (cid: string) => void;
  reject: (error: unknown) => void;
}

function harness(deps: ManagerDeps = {}) {
  const uploads: FakeUpload[] = [];
  const hashes: FakeHash[] = [];
  const manager = new UploadManager({
    startUpload: (f, init, callbacks) => {
      const stop = vi.fn(async () => undefined);
      uploads.push({ file: f, init, callbacks, stop });
      return { stop };
    },
    fingerprint: (f, options) =>
      new Promise<string>((resolve, reject) => {
        hashes.push({
          file: f as File, // the manager always hands over a File
          signal: options?.signal,
          progress: (hashed, total) => options?.onProgress?.(hashed, total),
          resolve,
          reject,
        });
      }),
    ...deps,
  });
  const entry = (index = 0): FileEntry => manager.getSnapshot()[index];
  /** Let promise callbacks run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { manager, uploads, hashes, entry, settle };
}

const failure = (overrides: Partial<UploadFailure> = {}): UploadFailure => ({
  kind: "network",
  status: null,
  message: "The connection was lost.",
  retryable: true,
  ...overrides,
});

describe("adding files", () => {
  it("queues a valid PDF, starts fingerprinting and uploading it, and gives it the paper-PDF role", () => {
    const { manager, uploads, hashes, entry } = harness();
    manager.addFiles([file("paper.pdf", 2 * MIB, "application/pdf")], "paper");

    expect(entry()).toMatchObject({
      name: "paper.pdf",
      role: "pdf",
      zone: "paper",
      size: 2 * MIB,
      status: "uploading",
      rejection: null,
      fingerprint: { status: "hashing", hashedBytes: 0, cid: null },
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].init).toEqual({ role: "pdf", fresh: false });
    expect(hashes).toHaveLength(1);
  });

  it("rejects a PDF over 50 MiB with the exact sizes, and never starts it", () => {
    const { manager, uploads, hashes, entry } = harness();
    manager.addFiles([file("big.pdf", 50 * MIB + 1, "application/pdf")], "paper");

    expect(entry().status).toBe("rejected");
    expect(entry().rejection).toContain("PDFs can be at most 50.0 MB (52,428,800 bytes)");
    expect(uploads).toHaveLength(0);
    expect(hashes).toHaveLength(0);
  });

  it("accepts a 60 MiB bundle that a PDF of that size would not get", () => {
    const { manager, entry } = harness();
    manager.addFiles([file("data.zip", 60 * MIB, "application/zip")], "extras");
    expect(entry().status).toBe("uploading");
  });

  it("rejects an empty file", () => {
    const { manager, entry } = harness();
    manager.addFiles([file("empty.csv", 0)], "extras");
    expect(entry()).toMatchObject({ status: "rejected", rejection: "This file is empty." });
  });

  it("rejects, in the paper zone, a file that is neither PDF nor LaTeX", () => {
    const { manager, entry } = harness();
    manager.addFiles([file("results.csv")], "paper");
    expect(entry().status).toBe("rejected");
    expect(entry().rejection).toMatch(/Code and data/);
  });

  it("rejects a second file with the same name, whatever its case, but not after the first is gone", () => {
    const { manager, entry } = harness();
    manager.addFiles([file("paper.pdf")], "paper");
    manager.addFiles([file("PAPER.PDF")], "paper");
    expect(entry(1)).toMatchObject({ status: "rejected" });
    expect(entry(1).rejection).toContain("already part of this submission");

    manager.remove(entry(0).id);
    manager.addFiles([file("paper.pdf")], "paper");
    expect(manager.getSnapshot().map((e) => e.status)).toEqual(["rejected", "uploading"]);
  });

  it("keeps a rejected file listed with its reason rather than dropping it silently", () => {
    const { manager } = harness();
    manager.addFiles([file("a.pdf"), file("notes.docx")], "paper");
    expect(manager.getSnapshot().map((e) => [e.name, e.status])).toEqual([
      ["a.pdf", "uploading"],
      ["notes.docx", "rejected"],
    ]);
  });

  it("recognises code, data and source by zone and extension", () => {
    const { manager } = harness({ maxUploads: 10, maxFingerprints: 10 });
    manager.addFiles([file("main.tex"), file("paper.pdf")], "paper");
    manager.addFiles([file("run.py"), file("table.csv")], "extras");
    expect(manager.getSnapshot().map((e) => e.role)).toEqual(["source", "pdf", "code", "data"]);
  });

  it("lets the author change a role to one the file can have, and no other", () => {
    const { manager, entry } = harness();
    manager.addFiles([file("main.tex")], "paper");
    manager.setRole(entry().id, "code");
    expect(entry().role).toBe("code");
    manager.setRole(entry().id, "pdf");
    expect(entry().role).toBe("code");
  });

  it("notifies subscribers, with a new snapshot each time, and stops after unsubscribe", () => {
    const { manager } = harness();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    const before = manager.getSnapshot();
    manager.addFiles([file("a.pdf")], "paper");
    expect(listener).toHaveBeenCalled();
    expect(manager.getSnapshot()).not.toBe(before);

    listener.mockClear();
    unsubscribe();
    manager.addFiles([file("b.pdf")], "paper");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("scheduling", () => {
  it("runs two uploads at a time and starts the next when one finishes", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");

    expect(uploads.map((u) => u.file.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(entry(2).status).toBe("queued");

    uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    expect(uploads.map((u) => u.file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(entry(2).status).toBe("uploading");
  });

  it("fingerprints two files at a time", () => {
    const { manager, hashes } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");
    expect(hashes.map((h) => h.file.name)).toEqual(["a.pdf", "b.pdf"]);

    hashes[0].resolve(CID_A);
    return Promise.resolve().then(() => {
      expect(hashes.map((h) => h.file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    });
  });
});

describe("progress", () => {
  it("tracks bytes sent and bytes fingerprinted separately", () => {
    const { manager, uploads, hashes, entry } = harness();
    manager.addFiles([file("a.pdf", 1000)], "paper");

    uploads[0].callbacks.onProgress(250, 1000);
    hashes[0].progress(600, 1000);

    expect(entry().bytesSent).toBe(250);
    expect(entry().fingerprint).toMatchObject({ status: "hashing", hashedBytes: 600 });
  });

  it("shows Reconnecting while the upload retries and Uploading again once bytes move", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");

    uploads[0].callbacks.onRetrying?.(0);
    expect(entry().status).toBe("reconnecting");

    uploads[0].callbacks.onProgress(100, 1000);
    expect(entry().status).toBe("uploading");
  });

  it("notes that an earlier upload of the file is being continued", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onResumed?.();
    expect(entry().resumed).toBe(true);
  });
});

describe("completing", () => {
  it("is complete only when the node's CID and the local fingerprint agree", async () => {
    const { manager, uploads, hashes, entry, settle } = harness();
    manager.addFiles([file("paper.pdf", 1000, "application/pdf")], "paper");

    uploads[0].callbacks.onSuccess({ cid: CID_A, url: "http://api/v1/uploads/1" });
    expect(entry().status).toBe("verifying");

    hashes[0].resolve(CID_A);
    await settle();
    expect(entry()).toMatchObject({
      status: "complete",
      serverCid: CID_A,
      bytesSent: 1000,
      fingerprint: { status: "done", cid: CID_A, hashedBytes: 1000 },
    });
  });

  it("completes the same when the fingerprint is ready before the upload", async () => {
    const { manager, uploads, hashes, entry, settle } = harness();
    manager.addFiles([file("paper.pdf")], "paper");

    hashes[0].resolve(CID_A);
    await settle();
    expect(entry().status).toBe("uploading");

    uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    expect(entry().status).toBe("complete");
  });

  it("fails with a mismatch when the node's copy has a different CID", async () => {
    const { manager, uploads, hashes, entry, settle } = harness();
    manager.addFiles([file("paper.pdf")], "paper");
    hashes[0].resolve(CID_A);
    await settle();
    uploads[0].callbacks.onSuccess({ cid: CID_B, url: null });

    expect(entry().status).toBe("failed");
    expect(entry().failure).toMatchObject({ kind: "mismatch", retryable: true });
    expect(entry().failure?.message).toMatch(/does not match/);
    expect(completedFiles(manager.getSnapshot())).toEqual([]);
  });

  it("retries a mismatch from byte zero with a new upload and a new fingerprint", async () => {
    const { manager, uploads, hashes, entry, settle } = harness();
    manager.addFiles([file("paper.pdf")], "paper");
    hashes[0].resolve(CID_A);
    await settle();
    uploads[0].callbacks.onSuccess({ cid: CID_B, url: null });

    manager.retry(entry().id);

    expect(uploads).toHaveLength(2);
    expect(uploads[1].init.fresh).toBe(true);
    expect(hashes).toHaveLength(2);
    expect(entry()).toMatchObject({ status: "uploading", failure: null, serverCid: null, bytesSent: 0 });

    uploads[1].callbacks.onSuccess({ cid: CID_A, url: null });
    hashes[1].resolve(CID_A);
    await settle();
    expect(entry().status).toBe("complete");
  });

  it("lists only complete files, as manifest-ready records", async () => {
    const { manager, uploads, hashes, settle } = harness();
    manager.addFiles([file("paper.pdf", 1000, "application/pdf"), file("big.pdf", 60 * MIB)], "paper");
    uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    hashes[0].resolve(CID_A);
    await settle();

    expect(completedFiles(manager.getSnapshot())).toEqual([
      { id: "file-1", path: "paper.pdf", size: 1000, mediaType: "application/pdf", role: "pdf", cid: CID_A },
    ]);
  });
});

describe("failing and retrying", () => {
  it("shows why an upload failed and retries from the node's offset (not afresh)", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onProgress(500, 1000);
    uploads[0].callbacks.onFailure(failure({ message: "The connection was lost." }));

    expect(entry()).toMatchObject({ status: "failed", bytesSent: 500 });
    expect(entry().failure?.message).toBe("The connection was lost.");

    manager.retry(entry().id);
    expect(entry().status).toBe("uploading");
    expect(uploads[1].init.fresh).toBe(false);
    expect(entry().bytesSent).toBe(500);
  });

  it("restarts afresh when the server no longer has the file's bytes", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onFailure(failure({ kind: "gone", status: 410, message: "Gone." }));
    manager.retry(entry().id);
    expect(uploads[1].init.fresh).toBe(true);
    expect(entry().bytesSent).toBe(0);
  });

  it("will not retry a failure that retrying cannot fix", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onFailure(failure({ kind: "too-large", status: 413, retryable: false }));
    manager.retry(entry().id);
    expect(entry().status).toBe("failed");
    expect(uploads).toHaveLength(1);
  });

  it("fails an unreadable file, stops its upload, and re-fingerprints it on retry", async () => {
    const { manager, uploads, hashes, entry, settle } = harness();
    manager.addFiles([file("a.pdf")], "paper");

    hashes[0].reject(new Error("NotReadableError"));
    await settle();

    expect(entry().status).toBe("failed");
    expect(entry().fingerprint.status).toBe("failed");
    expect(entry().failure).toMatchObject({ kind: "unreadable", retryable: true });
    expect(uploads[0].stop).toHaveBeenCalled();

    manager.retry(entry().id);
    expect(hashes).toHaveLength(2);
    expect(entry().fingerprint.status).toBe("hashing");
    expect(entry().status).toBe("uploading");
  });

  it("restarts only the uploads that stopped for want of a connection when the browser comes back online", () => {
    const { manager, uploads, entry } = harness({ maxUploads: 5 });
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");
    uploads[0].callbacks.onFailure(failure({ kind: "network" }));
    uploads[1].callbacks.onFailure(failure({ kind: "server", status: 503 }));

    manager.resumeAfterReconnect();

    expect(entry(0).status).toBe("uploading");
    expect(entry(1).status).toBe("failed");
    expect(entry(2).status).toBe("uploading");
    expect(uploads).toHaveLength(4);
  });
});

describe("pausing, resuming and removing", () => {
  it("pauses an upload by stopping it, keeping what the node has", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onProgress(300, 1000);

    manager.pause(entry().id);

    expect(uploads[0].stop).toHaveBeenCalledTimes(1);
    expect(entry()).toMatchObject({ status: "paused", bytesSent: 300 });
  });

  it("resumes a paused upload as a new upload that continues rather than starts over", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    manager.pause(entry().id);
    manager.resume(entry().id);

    expect(uploads).toHaveLength(2);
    expect(uploads[1].init.fresh).toBe(false);
    expect(entry().status).toBe("uploading");
  });

  it("hands a paused upload's slot to a waiting file", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");
    expect(entry(2).status).toBe("queued");

    manager.pause(entry(0).id);
    expect(entry(2).status).toBe("uploading");
    expect(uploads.map((u) => u.file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("can pause a file that is still waiting its turn", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");
    manager.pause(entry(2).id);
    expect(entry(2).status).toBe("paused");

    manager.resume(entry(2).id);
    expect(entry(2).status).toBe("queued");
    expect(uploads).toHaveLength(2);
  });

  it("does nothing when pausing a file that is not moving, or resuming one that is not paused", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    manager.pause(entry().id);
    expect(entry().status).toBe("verifying");

    manager.resume(entry().id);
    expect(entry().status).toBe("verifying");
  });

  it("removes a file, cancelling both its upload and its fingerprint", () => {
    const { manager, uploads, hashes } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    const [{ id }] = manager.getSnapshot();

    manager.remove(id);

    expect(manager.getSnapshot()).toEqual([]);
    expect(uploads[0].stop).toHaveBeenCalled();
    expect(hashes[0].signal?.aborted).toBe(true);
  });

  it("ignores everything a removed file's work reports afterwards", async () => {
    const { manager, uploads, hashes, settle } = harness();
    manager.addFiles([file("a.pdf")], "paper");
    manager.remove(manager.getSnapshot()[0].id);

    uploads[0].callbacks.onProgress(10, 1000);
    uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    hashes[0].reject(new FingerprintAborted());
    await settle();

    expect(manager.getSnapshot()).toEqual([]);
  });

  it("starts the next waiting file when one is removed", () => {
    const { manager, uploads, entry } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf")], "paper");
    manager.remove(entry(0).id);
    expect(uploads.map((u) => u.file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  });

  it("stopAll halts every upload and fingerprint and leaves the entries as they were", () => {
    const { manager, uploads, hashes } = harness();
    manager.addFiles([file("a.pdf"), file("b.pdf")], "paper");
    manager.stopAll();
    expect(uploads.every((u) => u.stop.mock.calls.length === 1)).toBe(true);
    expect(hashes.every((h) => h.signal?.aborted)).toBe(true);
    expect(manager.getSnapshot()).toHaveLength(2);
  });
});

describe("continueBlocker", () => {
  const states = async (setup: (h: ReturnType<typeof harness>) => void | Promise<void>) => {
    const h = harness({ maxUploads: 10, maxFingerprints: 10 });
    await setup(h);
    return continueBlocker(h.manager.getSnapshot());
  };

  /** Finish upload `i` with CID_A and its fingerprint to match. */
  const finish = async (h: ReturnType<typeof harness>, i: number) => {
    h.uploads[i].callbacks.onSuccess({ cid: CID_A, url: null });
    h.hashes[i].resolve(CID_A);
    await h.settle();
  };

  it("asks for the paper when nothing has been added", async () => {
    expect(await states(() => undefined)).toBe("Add your paper as a PDF or LaTeX source to continue.");
  });

  it("waits while anything is still uploading or fingerprinting", async () => {
    expect(await states((h) => void h.manager.addFiles([file("a.pdf")], "paper"))).toBe(
      "Wait for the uploads and fingerprints to finish.",
    );
  });

  it("asks for the paper when only code or data is complete", async () => {
    expect(
      await states(async (h) => {
        h.manager.addFiles([file("table.csv")], "extras");
        await finish(h, 0);
      }),
    ).toBe("Add your paper as a PDF or LaTeX source to continue.");
  });

  it("is open once a PDF is complete", async () => {
    expect(
      await states(async (h) => {
        h.manager.addFiles([file("paper.pdf")], "paper");
        await finish(h, 0);
      }),
    ).toBeNull();
  });

  it("is open once only a LaTeX source is complete", async () => {
    expect(
      await states(async (h) => {
        h.manager.addFiles([file("main.tex")], "paper");
        await finish(h, 0);
      }),
    ).toBeNull();
  });

  it("ignores rejected files: they are not part of the submission", async () => {
    expect(
      await states(async (h) => {
        h.manager.addFiles([file("paper.pdf"), file("notes.docx")], "paper");
        await finish(h, 0);
      }),
    ).toBeNull();
  });

  it("is blocked by a failed file, then by a paused one, until each is dealt with", async () => {
    const h = harness({ maxUploads: 10, maxFingerprints: 10 });
    h.manager.addFiles([file("paper.pdf"), file("data.zip")], "paper");
    await finish(h, 0);
    h.manager.pause(h.entry(1).id);
    expect(continueBlocker(h.manager.getSnapshot())).toBe("Resume or remove the paused files.");

    h.manager.resume(h.entry(1).id);
    h.uploads[2].callbacks.onFailure(failure());
    expect(continueBlocker(h.manager.getSnapshot())).toBe("Retry or remove the files that failed.");

    h.manager.remove(h.entry(1).id);
    expect(continueBlocker(h.manager.getSnapshot())).toBeNull();
  });
});

describe("summaries", () => {
  it("counts files by state", async () => {
    const h = harness({ maxUploads: 10, maxFingerprints: 10 });
    h.manager.addFiles([file("a.pdf"), file("b.pdf"), file("c.pdf"), file("d.docx")], "paper");
    h.uploads[0].callbacks.onSuccess({ cid: CID_A, url: null });
    h.hashes[0].resolve(CID_A);
    await h.settle();
    h.uploads[1].callbacks.onFailure(failure());
    h.manager.pause(h.entry(2).id);

    expect(summarize(h.manager.getSnapshot())).toEqual({
      total: 4,
      complete: 1,
      rejected: 1,
      failed: 1,
      paused: 1,
      inProgress: 0,
    });
  });

  it("says whether leaving the page would interrupt an upload", () => {
    const h = harness();
    expect(hasActiveUploads(h.manager.getSnapshot())).toBe(false);
    h.manager.addFiles([file("a.pdf")], "paper");
    expect(hasActiveUploads(h.manager.getSnapshot())).toBe(true);
    h.manager.pause(h.entry().id);
    expect(hasActiveUploads(h.manager.getSnapshot())).toBe(false);
  });
});
