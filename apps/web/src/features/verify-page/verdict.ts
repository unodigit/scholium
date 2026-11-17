/**
 * What `/verify` tells the reader, as a function of what it knows so far.
 *
 * The page learns two things independently: what the reader's file is (read
 * and fingerprinted on their device) and what the authors signed (the version's
 * file list from the node). {@link deriveVerdict} turns whatever has arrived
 * into one of five answers:
 *
 * | Kind           | Look                          | When                                   |
 * | -------------- | ----------------------------- | -------------------------------------- |
 * | `idle`         | a hint, no icon               | something is still missing from the reader |
 * | `checking`     | grey spinner "Checking…"      | reading the file or loading the list   |
 * | `match`        | green tick                    | the file's id is one of the signed ids |
 * | `mismatch`     | red cross                     | it is none of them                     |
 * | `cannot_check` | grey "?" "Could not check"    | the evidence could not be obtained     |
 *
 * `mismatch` is the only answer that says the file is not what the authors
 * signed, and it says it only when both sides were read. An inability to get
 * the signed list, or to read the file, is grey and says so: it is not
 * evidence against the file (docs/design.md §5.3, the same rule the Proof tab
 * follows).
 *
 * Pure data and functions, no React.
 */

import { formatBytes } from "../submit/limits";
import type { IconName } from "../ui-kit";
import { baseName, compareFile, type FileFacts } from "./compare";
import type { VersionManifest } from "./manifest-source";
import type { VersionRef } from "./version-ref";

/** The sentence the reader is shown when a file matches a signed file. */
export const MATCH_HEADLINE = "This file matches what the authors signed";

/** The sentence the reader is shown when a file matches none of the signed files. */
export const MISMATCH_HEADLINE = "This file does not match what the authors signed";

export const CHECKING_HEADLINE = "Checking…";
export const CANNOT_CHECK_HEADLINE = "Could not check";
export const UNREADABLE_HEADLINE = "Could not read this file";

export type VerdictKind = "idle" | "checking" | "match" | "mismatch" | "cannot_check";

export type VerdictTone = "neutral" | "verified" | "critical";

/** Where the signed file list stands. */
export type ManifestState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly manifest: VersionManifest }
  | { readonly status: "unavailable"; readonly message: string };

/** A signed list (or the failure to get one) and the version it was asked for. */
export interface LoadedManifest {
  readonly schId: string;
  readonly state: ManifestState;
}

/**
 * What is known about the signed list of `ref`, given the last answer received.
 *
 * An answer for another version is no answer: the moment the reader moves to a
 * different id, the old list must stop counting, in the very next render and
 * not only once the new request has been started. Otherwise the file would be
 * compared with a version the reader has already left, and a genuine file could
 * be called a mismatch for a moment (and announced as one).
 */
export function manifestStateFor(ref: VersionRef | null, loaded: LoadedManifest | null): ManifestState {
  if (ref === null) return { status: "idle" };
  return loaded !== null && loaded.schId === ref.schId ? loaded.state : { status: "loading" };
}

/** Where the reader's file stands. */
export type FileState =
  | { readonly status: "idle" }
  | {
      readonly status: "hashing";
      readonly name: string;
      readonly size: number;
      readonly hashed: number;
    }
  | { readonly status: "ready"; readonly file: FileFacts }
  | { readonly status: "unreadable"; readonly name: string; readonly message: string };

export interface VerdictInput {
  /** The version being compared with; `null` until the id field holds a valid one. */
  readonly ref: VersionRef | null;
  readonly manifest: ManifestState;
  readonly file: FileState;
}

export interface Verdict {
  readonly kind: VerdictKind;
  /** The sentence beside the icon; `null` for a hint, which has no verdict to state. */
  readonly headline: string | null;
  /** One line under the headline: the reason, or what to do next. */
  readonly summary: string;
  /** Further lines, the facts behind the verdict. */
  readonly details: readonly string[];
  /** Bytes read so far and in all, while the file is being fingerprinted. */
  readonly progress: { readonly hashed: number; readonly total: number } | null;
  /** True when asking the node again might help. */
  readonly canRetry: boolean;
}

/** The icon and colour family of each kind. Grey (`neutral`) is never a verdict. */
export const VERDICT_LOOKS: Readonly<
  Record<Exclude<VerdictKind, "idle">, { readonly icon: IconName; readonly tone: VerdictTone }>
> = {
  checking: { icon: "spinner", tone: "neutral" },
  match: { icon: "check", tone: "verified" },
  mismatch: { icon: "cross", tone: "critical" },
  cannot_check: { icon: "question", tone: "neutral" },
};

/** `1 file`, `3 files`. */
export function filesPhrase(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function build(
  kind: VerdictKind,
  headline: string | null,
  summary: string,
  extra: Partial<Pick<Verdict, "details" | "progress" | "canRetry">> = {},
): Verdict {
  return {
    kind,
    headline,
    summary,
    details: extra.details ?? [],
    progress: extra.progress ?? null,
    canRetry: extra.canRetry ?? false,
  };
}

/** `main.pdf (manuscript)`, or just the path when the role says nothing. */
function describeSigned(path: string, role: string): string {
  return role === "" || role === "other" ? path : `${path} (${role})`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function matchVerdict(file: FileFacts, manifest: VersionManifest): Verdict {
  const result = compareFile(file, manifest);
  const count = manifest.files.length;
  const countPhrase = count === 1 ? "the only file" : `one of the ${count} files`;

  if (result.kind === "match") {
    const names = joinNames(result.matches.map((signed) => describeSigned(signed.path, signed.role)));
    // Files are compared by content alone; say so when the reader's copy is
    // named differently, so a renamed download is not mistaken for a problem.
    const renamed = !result.matches.some(
      (signed) => baseName(signed.path).toLowerCase() === file.name.toLowerCase(),
    );
    return build(
      "match",
      MATCH_HEADLINE,
      `It is ${names}, ${countPhrase} signed for ${manifest.ref.schId}.`,
      {
        details: renamed
          ? ["Files are compared by their contents, so it does not matter what yours is called."]
          : [],
      },
    );
  }

  const details: string[] = [];
  const named = result.sameName;
  if (named !== null) {
    details.push(
      file.size === named.size
        ? `${named.path} is signed for this version and is also ${file.size} bytes, but its contents differ.`
        : `${named.path} is signed for this version, but yours is ${formatBytes(file.size)} and the signed file is ${formatBytes(named.size)}.`,
    );
  }
  details.push(
    "It may belong to a different version, or it may have changed since the authors signed. " +
      "Check the version id above, or get a fresh copy from the paper's page.",
  );
  return build(
    "mismatch",
    MISMATCH_HEADLINE,
    `It is not ${countPhrase} signed for ${manifest.ref.schId}. Do not rely on it as the authors' version.`,
    { details },
  );
}

/** Work out what to tell the reader from what has arrived so far. */
export function deriveVerdict({ ref, manifest, file }: VerdictInput): Verdict {
  if (file.status === "hashing") {
    return build("checking", CHECKING_HEADLINE, `Reading ${file.name} on this device. It is not uploaded.`, {
      progress: { hashed: file.hashed, total: file.size },
    });
  }

  if (file.status === "unreadable") {
    return build("cannot_check", UNREADABLE_HEADLINE, file.message);
  }

  if (ref === null) {
    return build(
      "idle",
      null,
      file.status === "ready"
        ? "Enter the version id to compare this file with what the authors signed."
        : "Enter a version id and drop a file to compare them.",
    );
  }

  if (manifest.status === "unavailable") {
    return build(
      "cannot_check",
      CANNOT_CHECK_HEADLINE,
      `${manifest.message} This does not mean the file is wrong; it means it could not be compared.`,
      { canRetry: true },
    );
  }

  if (file.status === "idle") {
    return build(
      "idle",
      null,
      manifest.status === "ready"
        ? `Drop a file to compare it with the ${filesPhrase(manifest.manifest.files.length)} signed for ${ref.schId}.`
        : `Drop a file to compare it with the files signed for ${ref.schId}.`,
    );
  }

  if (manifest.status !== "ready") {
    return build("checking", CHECKING_HEADLINE, `Loading the files signed for ${ref.schId}…`);
  }

  return matchVerdict(file.file, manifest.manifest);
}

export interface ContentVerdictInput {
  readonly file: FileState;
  readonly content: {
    readonly status: "idle" | "loading" | "ready" | "unavailable";
    readonly versions: readonly { readonly title: string; readonly n: number; readonly paper: string; readonly fileName: string; readonly schId?: string }[];
    readonly message?: string;
  };
}

/** Work out what to tell the reader when no version id is given. */
export function deriveContentVerdict({ file, content }: ContentVerdictInput): Verdict {
  if (file.status === "hashing") {
    return build("checking", CHECKING_HEADLINE, `Reading ${file.name} on this device. It is not uploaded.`, {
      progress: { hashed: file.hashed, total: file.size },
    });
  }
  if (file.status === "unreadable") {
    return build("cannot_check", UNREADABLE_HEADLINE, file.message);
  }
  if (file.status === "idle") {
    return build("idle", null, "Enter a version id and drop a file to compare them.");
  }
  if (content.status === "loading" || content.status === "idle") {
    return build("checking", CHECKING_HEADLINE, "Looking up which listed paper contains this file…");
  }
  if (content.status === "unavailable") {
    const message = content.message ?? "Could not check.";
    if (message.toLowerCase().includes("no listed paper")) {
      return build("mismatch", MISMATCH_HEADLINE, "No listed paper on this node contains this file.");
    }
    return build("cannot_check", CANNOT_CHECK_HEADLINE, `${message} This does not mean the file is wrong; it means it could not be compared.`, {
      canRetry: true,
    });
  }
  if (content.versions.length === 0) {
    return build("mismatch", MISMATCH_HEADLINE, "No listed paper on this node contains this file.");
  }
  const match = content.versions[0];
  const schId = match.schId && match.schId.trim() !== "" ? match.schId : `${match.paper}/v${match.n}`;
  return build(
    "match",
    MATCH_HEADLINE,
    `This file is ${match.fileName} of ${match.title}, version ${match.n} (${schId}) - signed by its authors`,
  );
}
