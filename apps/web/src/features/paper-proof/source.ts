/**
 * Where the Proof tab gets the records it verifies.
 *
 * The tab does not care how records arrive, only that they are *signed
 * envelopes* (`id`, `sig` and the seven content fields), so it takes a
 * {@link ProofSource}. {@link createNodeProofSource} is the default: it replays
 * the node's event log the way `scholium verify --node` does, and asks the node
 * for the ledger proof and the file bytes. A paper page that already holds the
 * records, or a future archive endpoint, passes its own source.
 *
 * **Signatures.** `GET /v1/sync/range` serves `raw`, the canonical bytes of the
 * seven content fields, because the ledger does not retain `sig` (it is checked
 * at ingest; see `apps/api/.../ledger/records.py`). Records rebuilt from it
 * therefore carry no signature unless the node starts sending one, which this
 * source picks up when a log entry has a `sig`. A node that sends *no*
 * signatures at all has not given the browser anything to check, which is not
 * the same as a forged paper: the source reports that as
 * {@link ProofUnavailableError}, shown as "Could not check", never as
 * "Verification failed". (A record that is signed but wrongly, or a paper with
 * one unsigned record among signed ones, is a real failure and is left to
 * verify-core.)
 *
 * No React here; the module is safe to import from a server component.
 */

import { ApiError, NetworkError, api, type ApiClient } from "../../lib/api";
import { decodeRecordBytes } from "../verify-core";
import { parseRecordProof, type RecordProofInfo } from "./anchor";
import type { FileLoader } from "./files";
import type { PaperRef } from "./paper-ref";
import { loadPreservation, type PreservationInfo } from "./preservation";

/** A signed record envelope as `verifyPaper` reads it. */
export type SignedRecord = Record<string, unknown>;

export interface ProofSource {
  /**
   * Every signed record the node holds that could belong to `ref`'s paper.
   * Records of other papers may be mixed in; verify-core ignores them.
   */
  loadRecords(ref: PaperRef, signal?: AbortSignal): Promise<readonly SignedRecord[]>;
  /** The ledger's proof for one record (`GET /v1/records/{cid}/proof`). */
  loadRecordProof?(recordId: string, signal?: AbortSignal): Promise<RecordProofInfo>;
  /** Bytes of a listed file by its signed id, or `null` when not held. */
  loadFile?: FileLoader;
  /**
   * The node's replication summary (`GET /v1/network`), for the checklist's
   * preservation line. Answers `null` when the node did not say.
   */
  loadPreservation?(signal?: AbortSignal): Promise<PreservationInfo | null>;
}

/**
 * The check cannot be run, for a reason worth saying in words: the node has
 * nothing to check, or is not sending what a check needs. Its message is shown
 * to the reader as is, so write it for them.
 */
export class ProofUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofUnavailableError";
  }
}

/** Entries asked of the log per request (the API's page limit is 1000). */
export const SYNC_PAGE_SIZE = 500;

/**
 * Pages replayed before giving up. A log longer than this is not something a
 * browser tab should pull whole; the offline command is the answer there.
 */
export const MAX_SYNC_PAGES = 100;

/** `GET`-only slice of the API client, so tests need no network stack. */
export type ProofClient = Pick<ApiClient, "get">;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Rebuild one record from a `GET /v1/sync/range` entry, as the CLI's `--node`
 * path does: decode `raw`, take the id from `record_cid`, and keep a `sig` the
 * node sent. An entry that cannot be decoded is dropped (verify-core then sees
 * a hole, not a guess).
 */
export function recordFromSyncEntry(entry: unknown): SignedRecord | null {
  if (!isMapping(entry) || typeof entry.raw !== "string") return null;
  let decoded: unknown;
  try {
    decoded = decodeRecordBytes(base64ToBytes(entry.raw));
  } catch {
    return null;
  }
  if (!isMapping(decoded)) return null;
  const record: SignedRecord = { ...decoded };
  if (typeof entry.record_cid === "string") record.id = entry.record_cid;
  if (record.sig === undefined && typeof entry.sig === "string") record.sig = entry.sig;
  return record;
}

/** The default source: a node's public read API. */
export function createNodeProofSource(client: ProofClient = api): ProofSource {
  return {
    async loadRecords(ref, signal) {
      const entries = await client.get<unknown>(`/export/paper/${ref.shortId}/records`, {
        auth: false,
        signal,
      });
      if (!Array.isArray(entries)) {
        throw new ProofUnavailableError(
          "The node's answer was not a list of log entries.",
        );
      }
      const records: SignedRecord[] = [];
      for (const entry of entries) {
        const record = recordFromSyncEntry(entry);
        if (record !== null) records.push(record);
      }

      if (records.length > 0 && records.every((record) => record.sig === undefined)) {
        throw new ProofUnavailableError(
          "This node did not send the authors' signatures, so the browser cannot check them.",
        );
      }
      return records;
    },

    async loadRecordProof(recordId, signal) {
      const body = await client.get<unknown>(
        `/records/${encodeURIComponent(recordId)}/proof`,
        { auth: false, signal },
      );
      return parseRecordProof(body);
    },

    async loadFile(cid, signal) {
      try {
        const body = await client.get<ArrayBuffer>(
          `/content/${encodeURIComponent(cid)}`,
          { auth: false, parse: "arrayBuffer", signal },
        );
        return new Uint8Array(body);
      } catch (error) {
        // Not stored, still being scanned, or withheld for legal reasons: the
        // node has no bytes to compare, which is not a mismatch.
        if (error instanceof ApiError && [404, 423, 451].includes(error.status)) {
          return null;
        }
        throw error;
      }
    },

    loadPreservation(signal) {
      return loadPreservation(signal, client);
    },
  };
}

/** A reader-facing sentence for why a check could not run. */
export function describeProofError(error: unknown): string {
  if (error instanceof ProofUnavailableError) return error.message;
  if (error instanceof NetworkError) {
    return "Scholium could not reach the node. You may be offline.";
  }
  if (error instanceof ApiError) {
    return error.isNotFound
      ? "The node has no proof for this paper."
      : error.detail || error.title || "The node could not provide the proof.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "The proof could not be checked.";
}
