/**
 * The words and numbers a file row shows, kept out of the component so they can
 * be tested without rendering anything.
 */

import { formatBytes } from "./limits";
import type { EntryStatus, FileEntry, UploadSummary } from "./upload-manager";

/** The word beside every status icon: status is never colour alone. */
export const STATUS_LABELS: Record<EntryStatus, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  reconnecting: "Reconnecting",
  verifying: "Checking",
  paused: "Paused",
  failed: "Failed",
  complete: "Uploaded",
  rejected: "Not added",
};

export type StatusTone = "neutral" | "active" | "pending" | "verified" | "critical";

/** Reinforcing colour for each status. `--ai` is reserved for AI output and is never used. */
export const STATUS_TONES: Record<EntryStatus, StatusTone> = {
  queued: "neutral",
  uploading: "active",
  reconnecting: "pending",
  verifying: "active",
  paused: "pending",
  failed: "critical",
  complete: "verified",
  rejected: "critical",
};

/**
 * Whole-number percentage, never rounding up to 100 until the work is done, so
 * a bar that says 100% is finished.
 */
export function percent(done: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  if (done >= total) {
    return 100;
  }
  return Math.max(0, Math.min(99, Math.floor((done / total) * 100)));
}

export function uploadPercent(entry: FileEntry): number {
  return percent(entry.bytesSent, entry.size);
}

export function fingerprintPercent(entry: FileEntry): number {
  return entry.fingerprint.status === "done" ? 100 : percent(entry.fingerprint.hashedBytes, entry.size);
}

/** The line beside the upload bar. */
export function uploadText(entry: FileEntry): string {
  const pct = uploadPercent(entry);
  switch (entry.status) {
    case "queued":
      return "Waiting to start";
    case "uploading":
      return `${pct}% · ${formatBytes(entry.bytesSent)} of ${formatBytes(entry.size)}`;
    case "reconnecting":
      return `Connection lost · will continue from ${pct}%`;
    case "verifying":
    case "complete":
      return `100% · ${formatBytes(entry.size)}`;
    case "paused":
      return `Paused at ${pct}%`;
    case "failed":
      return `Stopped at ${pct}%`;
    default:
      return "";
  }
}

/** The line beside the fingerprint bar, for every state but a finished one (which shows the ID). */
export function fingerprintText(entry: FileEntry): string {
  switch (entry.fingerprint.status) {
    case "pending":
      return "Waiting";
    case "hashing":
      return `${fingerprintPercent(entry)}%`;
    case "failed":
      return "Could not read the file";
    default:
      return "";
  }
}

/** The one-line count above the file list. */
export function summaryText(summary: UploadSummary): string {
  if (summary.total === 0) {
    return "No files added yet.";
  }
  const added = summary.total - summary.rejected;
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`${summary.complete} of ${added} ${added === 1 ? "file" : "files"} uploaded`);
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`);
  }
  if (summary.paused > 0) {
    parts.push(`${summary.paused} paused`);
  }
  if (summary.rejected > 0) {
    parts.push(`${summary.rejected} not added`);
  }
  return parts.join(" · ");
}
