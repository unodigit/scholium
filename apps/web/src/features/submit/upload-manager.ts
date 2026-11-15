/**
 * The Files step's engine: a list of files, each being fingerprinted and
 * uploaded, with no React in it.
 *
 * Every added file becomes an entry that moves through
 *
 * ```text
 *   queued ─▶ uploading ⇄ reconnecting ─▶ verifying ─▶ complete
 *      ▲          │                            │
 *      │          ├──▶ paused ──(resume)──▶ queued
 *      └─(retry)── failed ◀────────────────────┘
 *   rejected  (never uploaded: too big, empty, wrong kind, duplicate name)
 * ```
 *
 * Two jobs run per file, side by side: the **fingerprint** (the file's content
 * ID, computed on this device) and the **upload** (tus, resumable). A file is
 * `complete` only when both have finished *and agree*: the CID the server
 * filed the bytes under equals the fingerprint of the file the author chose.
 *
 * Uploads are limited to {@link DEFAULT_MAX_UPLOADS} at a time and fingerprints
 * to {@link DEFAULT_MAX_FINGERPRINTS}, so dropping forty data files does not
 * open forty connections. The manager is a plain external store
 * (`subscribe` / `getSnapshot`); `useUploadManager` binds it to React.
 */

import { defaultRole, PAPER_ROLES, rolesFor, unsupportedMessage, type FileRole, type FileZone } from "./file-roles";
import { fingerprintBlob, FingerprintAborted, sameCid } from "./fingerprint";
import { checkSize } from "./limits";
import {
  startTusUpload,
  type TusUploadCallbacks,
  type TusUploadConfig,
  type TusUploadHandle,
  type TusUploadInit,
  type UploadFailureKind,
} from "./tus-upload";

export const DEFAULT_MAX_UPLOADS = 2;
export const DEFAULT_MAX_FINGERPRINTS = 2;

export type EntryStatus =
  | "rejected"
  | "queued"
  | "uploading"
  | "reconnecting"
  /** Every byte is on the node; waiting for the local fingerprint to finish and match. */
  | "verifying"
  | "paused"
  | "failed"
  | "complete";

export type FingerprintStatus = "pending" | "hashing" | "done" | "failed";

export interface FingerprintState {
  status: FingerprintStatus;
  hashedBytes: number;
  /** The file's content ID, once computed. */
  cid: string | null;
}

export interface EntryFailure {
  kind: UploadFailureKind | "mismatch" | "unreadable";
  message: string;
  /** Whether the Retry button can help. */
  retryable: boolean;
}

export interface FileEntry {
  id: string;
  file: File;
  name: string;
  size: number;
  mediaType: string;
  zone: FileZone;
  role: FileRole;
  status: EntryStatus;
  /** Why the file was not added (`rejected` only). */
  rejection: string | null;
  /** Why the file stopped (`failed` only). */
  failure: EntryFailure | null;
  bytesSent: number;
  /** An earlier partial upload of this file was found and continued. */
  resumed: boolean;
  fingerprint: FingerprintState;
  /** The content ID the node filed the upload under, once it has. */
  serverCid: string | null;
}

/** A file that is on the node and matches its fingerprint: what the later steps build the manifest from. */
export interface SubmitFile {
  id: string;
  /** The file name, which becomes its path in the manifest. */
  path: string;
  size: number;
  mediaType: string;
  role: FileRole;
  cid: string;
}

export interface ManagerDeps {
  startUpload?: (file: File, init: TusUploadInit, callbacks: TusUploadCallbacks) => TusUploadHandle;
  fingerprint?: typeof fingerprintBlob;
  /** Passed to the default tus uploader (endpoint, retry delays, …). */
  uploadConfig?: TusUploadConfig;
  maxUploads?: number;
  maxFingerprints?: number;
}

/** Work in flight for one entry; never part of the published state. */
interface Runtime {
  upload: TusUploadHandle | null;
  hashing: AbortController | null;
  /** The next upload should be a brand-new one, not a continuation. */
  fresh: boolean;
}

const ACTIVE_STATUSES: readonly EntryStatus[] = ["queued", "uploading", "reconnecting", "verifying"];

const MISMATCH_MESSAGE =
  "The copy on the node does not match this file's fingerprint. " +
  "The file may have changed during the upload. Try again to upload it afresh.";

export class UploadManager {
  private entries: FileEntry[] = [];
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<() => void>();
  private readonly deps: ManagerDeps;
  private nextId = 1;

  constructor(deps: ManagerDeps = {}) {
    this.deps = deps;
  }

  /* ---------------------------------------------------------------- store */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly FileEntry[] => this.entries;

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private update(id: string, patch: Partial<FileEntry> | ((entry: FileEntry) => Partial<FileEntry>)): void {
    let changed = false;
    this.entries = this.entries.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      changed = true;
      return { ...entry, ...(typeof patch === "function" ? patch(entry) : patch) };
    });
    if (changed) {
      this.emit();
    }
  }

  private find(id: string): FileEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = { upload: null, hashing: null, fresh: false };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  /* -------------------------------------------------------------- adding */

  /**
   * Add files dropped or chosen in `zone`. Files that cannot be uploaded are
   * still listed, as `rejected` with the reason, so nothing the author dropped
   * vanishes without a word. Returns the new entries' ids.
   */
  addFiles(files: readonly File[], zone: FileZone): string[] {
    const added: FileEntry[] = [];
    const taken = new Set(this.entries.filter((e) => e.status !== "rejected").map((e) => e.name.toLowerCase()));

    for (const file of files) {
      const facts = { name: file.name, type: file.type, size: file.size };
      const role = defaultRole(facts, zone);
      let rejection: string | null = null;

      if (role === null) {
        rejection = unsupportedMessage(zone);
      } else {
        rejection = checkSize(facts)?.message ?? null;
      }
      if (rejection === null && taken.has(file.name.toLowerCase())) {
        rejection = `A file named ${file.name} is already part of this submission.`;
      }
      if (rejection === null) {
        taken.add(file.name.toLowerCase());
      }

      added.push({
        id: `file-${this.nextId++}`,
        file,
        name: file.name,
        size: file.size,
        mediaType: file.type,
        zone,
        role: role ?? "data",
        status: rejection === null ? "queued" : "rejected",
        rejection,
        failure: null,
        bytesSent: 0,
        resumed: false,
        fingerprint: { status: "pending", hashedBytes: 0, cid: null },
        serverCid: null,
      });
    }

    if (added.length > 0) {
      this.entries = [...this.entries, ...added];
      this.emit();
      this.pump();
    }
    return added.map((entry) => entry.id);
  }

  /** Change a file's role, when it is one the file can have. */
  setRole(id: string, role: FileRole): void {
    const entry = this.find(id);
    if (entry && entry.status !== "rejected" && rolesFor(entry.file).includes(role)) {
      this.update(id, { role });
    }
  }

  /* ------------------------------------------------------------- control */

  /** Stop sending a file, keeping what the node already has so Resume continues from there. */
  pause(id: string): void {
    const entry = this.find(id);
    if (!entry || !(["queued", "uploading", "reconnecting"] as EntryStatus[]).includes(entry.status)) {
      return;
    }
    void this.runtime(id).upload?.stop();
    this.runtime(id).upload = null;
    this.update(id, { status: "paused" });
    this.pump();
  }

  resume(id: string): void {
    if (this.find(id)?.status === "paused") {
      this.update(id, { status: "queued" });
      this.pump();
    }
  }

  /**
   * Try a failed file again. A mismatch or a vanished upload starts over from
   * byte zero; anything else continues from the node's offset.
   */
  retry(id: string): void {
    const entry = this.find(id);
    if (!entry || entry.status !== "failed" || !entry.failure?.retryable) {
      return;
    }
    const runtime = this.runtime(id);
    const { kind } = entry.failure;
    const restart = kind === "mismatch" || kind === "gone";
    runtime.fresh = restart;
    this.update(id, (current) => ({
      status: "queued",
      failure: null,
      serverCid: restart ? null : current.serverCid,
      bytesSent: restart ? 0 : current.bytesSent,
      resumed: false,
      fingerprint:
        restart || kind === "unreadable"
          ? { status: "pending", hashedBytes: 0, cid: null }
          : current.fingerprint,
    }));
    this.pump();
  }

  /** Drop a file from the submission, cancelling its work. The node keeps any bytes it has. */
  remove(id: string): void {
    this.cancelWork(id);
    this.runtimes.delete(id);
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.emit();
    this.pump();
  }

  /** The browser came back online: continue every upload that stopped for want of a connection. */
  resumeAfterReconnect(): void {
    for (const entry of this.entries) {
      if (entry.status === "failed" && entry.failure?.kind === "network") {
        this.retry(entry.id);
      }
    }
  }

  /** Stop all work (the page is going away). Entries stay as they are; nothing calls back afterwards. */
  stopAll(): void {
    for (const entry of this.entries) {
      this.cancelWork(entry.id);
    }
  }

  private cancelWork(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return;
    }
    void runtime.upload?.stop();
    runtime.upload = null;
    runtime.hashing?.abort();
    runtime.hashing = null;
  }

  /* ----------------------------------------------------------- scheduling */

  /** Start whatever is waiting and has room to start. */
  private pump(): void {
    const maxHashing = this.deps.maxFingerprints ?? DEFAULT_MAX_FINGERPRINTS;
    let hashing = this.entries.filter((e) => e.fingerprint.status === "hashing").length;
    for (const entry of this.entries) {
      if (hashing >= maxHashing) {
        break;
      }
      if (entry.fingerprint.status === "pending" && entry.status !== "rejected" && entry.status !== "failed") {
        this.startFingerprint(entry.id);
        hashing += 1;
      }
    }

    const maxUploads = this.deps.maxUploads ?? DEFAULT_MAX_UPLOADS;
    let uploading = this.entries.filter((e) => e.status === "uploading" || e.status === "reconnecting").length;
    for (const entry of this.entries) {
      if (uploading >= maxUploads) {
        break;
      }
      if (entry.status === "queued") {
        this.startUpload(entry.id);
        uploading += 1;
      }
    }
  }

  private startFingerprint(id: string): void {
    const entry = this.find(id);
    if (!entry) {
      return;
    }
    const runtime = this.runtime(id);
    runtime.hashing?.abort();
    const controller = new AbortController();
    runtime.hashing = controller;
    this.update(id, { fingerprint: { status: "hashing", hashedBytes: 0, cid: null } });

    const hash = this.deps.fingerprint ?? fingerprintBlob;
    hash(entry.file, {
      signal: controller.signal,
      onProgress: (hashedBytes) => {
        if (!controller.signal.aborted) {
          this.update(id, (current) => ({ fingerprint: { ...current.fingerprint, hashedBytes } }));
        }
      },
    }).then(
      (cid) => {
        if (controller.signal.aborted) {
          return;
        }
        runtime.hashing = null;
        this.update(id, (current) => ({
          fingerprint: { status: "done", hashedBytes: current.size, cid },
        }));
        this.settle(id);
        this.pump();
      },
      (error: unknown) => {
        if (controller.signal.aborted || error instanceof FingerprintAborted) {
          return;
        }
        runtime.hashing = null;
        void runtime.upload?.stop();
        runtime.upload = null;
        this.update(id, (current) => ({
          status: "failed",
          fingerprint: { ...current.fingerprint, status: "failed" },
          failure: {
            kind: "unreadable",
            message:
              "This file could not be read to fingerprint it. It may have been moved, renamed or changed. " +
              "Check that it is still there, then try again.",
            retryable: true,
          },
        }));
        this.pump();
      },
    );
  }

  private startUpload(id: string): void {
    const entry = this.find(id);
    if (!entry) {
      return;
    }
    const runtime = this.runtime(id);
    const fresh = runtime.fresh;
    runtime.fresh = false;
    this.update(id, { status: "uploading", failure: null });

    const callbacks: TusUploadCallbacks = {
      onProgress: (bytesSent) => {
        this.update(id, (current) => ({
          bytesSent,
          // Bytes moving again means the connection is back.
          status: current.status === "reconnecting" ? "uploading" : current.status,
        }));
      },
      onResumed: () => this.update(id, { resumed: true }),
      onRetrying: () => this.update(id, (current) => (current.status === "uploading" ? { status: "reconnecting" } : {})),
      onSuccess: ({ cid }) => {
        runtime.upload = null;
        this.update(id, (current) => ({ serverCid: cid, bytesSent: current.size, status: "verifying" }));
        this.settle(id);
        this.pump();
      },
      onFailure: (failure) => {
        runtime.upload = null;
        this.update(id, {
          status: "failed",
          failure: { kind: failure.kind, message: failure.message, retryable: failure.retryable },
        });
        this.pump();
      },
    };

    const start =
      this.deps.startUpload ??
      ((file, init, cb) => startTusUpload(file, init, cb, this.deps.uploadConfig));
    runtime.upload = start(entry.file, { role: entry.role, fresh }, callbacks);
  }

  /** Once both the node's CID and the local fingerprint are known, compare them. */
  private settle(id: string): void {
    const entry = this.find(id);
    if (!entry || entry.status !== "verifying" || entry.serverCid === null || entry.fingerprint.cid === null) {
      return;
    }
    if (sameCid(entry.serverCid, entry.fingerprint.cid)) {
      this.update(id, { status: "complete" });
    } else {
      this.update(id, {
        status: "failed",
        failure: { kind: "mismatch", message: MISMATCH_MESSAGE, retryable: true },
      });
    }
  }
}

/* ------------------------------------------------------------------ views */

/** The files that are on the node and match their fingerprints. */
export function completedFiles(entries: readonly FileEntry[]): SubmitFile[] {
  return entries.flatMap((entry) =>
    entry.status === "complete" && entry.serverCid
      ? [
          {
            id: entry.id,
            path: entry.name,
            size: entry.size,
            mediaType: entry.mediaType,
            role: entry.role,
            cid: entry.serverCid,
          },
        ]
      : [],
  );
}

/**
 * Why the author cannot continue to step 2 yet, or `null` when they can.
 *
 * Rejected files never block: they are not part of the submission. Anything
 * that is still moving, stopped or broken does, because the manifest must be
 * built from files that are all on the node.
 */
export function continueBlocker(entries: readonly FileEntry[]): string | null {
  if (entries.some((entry) => entry.status === "failed")) {
    return "Retry or remove the files that failed.";
  }
  if (entries.some((entry) => entry.status === "paused")) {
    return "Resume or remove the paused files.";
  }
  if (entries.some((entry) => ACTIVE_STATUSES.includes(entry.status))) {
    return "Wait for the uploads and fingerprints to finish.";
  }
  if (!completedFiles(entries).some((file) => PAPER_ROLES.includes(file.role))) {
    return "Add your paper as a PDF or LaTeX source to continue.";
  }
  return null;
}

export interface UploadSummary {
  total: number;
  complete: number;
  rejected: number;
  failed: number;
  paused: number;
  /** Queued, uploading, reconnecting or verifying. */
  inProgress: number;
}

export function summarize(entries: readonly FileEntry[]): UploadSummary {
  const count = (test: (entry: FileEntry) => boolean) => entries.filter(test).length;
  return {
    total: entries.length,
    complete: count((e) => e.status === "complete"),
    rejected: count((e) => e.status === "rejected"),
    failed: count((e) => e.status === "failed"),
    paused: count((e) => e.status === "paused"),
    inProgress: count((e) => ACTIVE_STATUSES.includes(e.status)),
  };
}

/** Whether leaving the page now would interrupt an upload. */
export function hasActiveUploads(entries: readonly FileEntry[]): boolean {
  return entries.some((entry) => entry.status === "uploading" || entry.status === "reconnecting" || entry.status === "queued");
}
