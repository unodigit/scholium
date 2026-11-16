import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { recordBytes } from "../verify-core";
import { buildPaper } from "./proof-fixtures";
import { parsePaperRef } from "./paper-ref";
import { runProofCheck } from "./run-proof-check";
import {
  MAX_SYNC_PAGES,
  ProofUnavailableError,
  SYNC_PAGE_SIZE,
  createNodeProofSource,
  describeProofError,
  recordFromSyncEntry,
  type ProofClient,
} from "./source";

const paper = buildPaper({ authors: 2 });
const REF = parsePaperRef(paper.shortId);

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** A `GET /v1/sync/range` entry for a record, as the node serves it (no `sig`). */
function entryFor(record: Record<string, unknown>, seq: number, extra: Record<string, unknown> = {}) {
  return {
    seq,
    record_cid: record.id,
    record_type: record.type,
    author_did: record.author,
    body: record.body,
    raw: toBase64(recordBytes(record)),
    prev_hash: "00",
    entry_hash: "11",
    received_at: "2026-11-15T09:30:12Z",
    origin_node: "did:key:node",
    ...extra,
  };
}

interface Call {
  path: string;
  options: Record<string, unknown>;
}

/** A client whose `get` is answered by `answer`, recording every call. */
function clientOf(answer: (call: Call) => unknown): { client: ProofClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    get: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      const call = { path, options };
      calls.push(call);
      return answer(call);
    }),
  } as unknown as ProofClient;
  return { client, calls };
}

describe("recordFromSyncEntry", () => {
  const original = paper.records[0];

  it("rebuilds the record from its canonical bytes and sets the id from the log", () => {
    const record = recordFromSyncEntry(entryFor(original, 1))!;
    expect(record.id).toBe(original.id);
    expect(record.type).toBe("paper.genesis");
    expect(record.body).toEqual(original.body);
    // The ledger keeps no signature, so none can be rebuilt from `raw`.
    expect(record.sig).toBeUndefined();
  });

  it("keeps a signature the node sends", () => {
    expect(recordFromSyncEntry(entryFor(original, 1, { sig: original.sig }))?.sig).toBe(original.sig);
  });

  it("lets verify-core catch a record whose bytes do not match the id the log gave", () => {
    const record = recordFromSyncEntry(entryFor(original, 1, { record_cid: paper.versionIds[0] }))!;
    expect(record.id).toBe(paper.versionIds[0]);
  });

  it.each([null, "x", [], {}, { raw: 7 }, { raw: "" }, { raw: "!!not base64!!" }, { raw: toBase64(new Uint8Array([0xff, 0x00])) }])(
    "drops an entry it cannot decode: %j",
    (entry) => {
      expect(recordFromSyncEntry(entry)).toBeNull();
    },
  );
});

describe("createNodeProofSource: loadRecords", () => {
  const signed = paper.records.map((record, index) => entryFor(record, index + 1, { sig: record.sig }));

  it("replays the log from the start with unauthenticated reads", async () => {
    const { client, calls } = clientOf(() => signed);
    const records = await createNodeProofSource(client).loadRecords(REF);

    expect(records.map((record) => record.id)).toEqual(paper.records.map((record) => record.id));
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`/export/paper/${REF.shortId}/records`);
    expect(calls[0].options).toMatchObject({ auth: false });
  });

  it("passes the abort signal to every request", async () => {
    const controller = new AbortController();
    const { client, calls } = clientOf(() => signed);
    await createNodeProofSource(client).loadRecords(REF, controller.signal);
    expect(calls[0].options.signal).toBe(controller.signal);
  });

  it("reports a node that sends no signatures as unavailable, not as a forgery", async () => {
    const unsigned = paper.records.map((record, index) => entryFor(record, index + 1));
    const { client } = clientOf(() => unsigned);
    const source = createNodeProofSource(client);

    await expect(source.loadRecords(REF)).rejects.toThrow(ProofUnavailableError);
    await expect(source.loadRecords(REF)).rejects.toThrow(
      "This node did not send the authors' signatures, so the browser cannot check them.",
    );

    const outcome = await runProofCheck({ ref: REF, source, nodeUrl: "https://n.example" });
    expect(outcome.state).toBe("cannot_verify");
    expect(outcome.summary).toMatch(/did not send the authors' signatures.*not a failure/);
  });

  it("verifies a paper end to end when the node does send signatures", async () => {
    const { client } = clientOf(({ path }) => (path === `/export/paper/${REF.shortId}/records` ? signed : null));
    const outcome = await runProofCheck({
      ref: REF,
      source: { loadRecords: createNodeProofSource(client).loadRecords },
      nodeUrl: "https://n.example",
    });
    expect(outcome.state).toBe("anchor_pending");
    expect(outcome.items.map((item) => item.state)).toEqual(["pass", "pass", "warn", "pending", "pass"]);
  });

  it("returns an empty log as no records, which the check reports as nothing to check", async () => {
    const { client } = clientOf(() => []);
    expect(await createNodeProofSource(client).loadRecords(REF)).toEqual([]);
  });

  it("rejects an answer that is not a list", async () => {
    const { client } = clientOf(() => ({ entries: [] }));
    await expect(createNodeProofSource(client).loadRecords(REF)).rejects.toThrow(ProofUnavailableError);
  });
});

describe("createNodeProofSource: loadRecordProof and loadFile", () => {
  it("reads the ledger proof for a record", async () => {
    const { client, calls } = clientOf(() => ({ seq: 9, anchor: "pending" }));
    const proof = await createNodeProofSource(client).loadRecordProof!(paper.versionIds[0]);
    expect(proof).toEqual({ anchor: { status: "pending" }, seq: 9 });
    expect(calls[0].path).toBe(`/records/${paper.versionIds[0]}/proof`);
    expect(calls[0].options).toMatchObject({ auth: false });
  });

  it("escapes a record id so it cannot change the path", async () => {
    const { client, calls } = clientOf(() => ({}));
    await createNodeProofSource(client).loadRecordProof!("../x?y#z");
    expect(calls[0].path).toBe("/records/..%2Fx%3Fy%23z/proof");
  });

  it("downloads file bytes", async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const { client, calls } = clientOf(() => buffer);
    const bytes = await createNodeProofSource(client).loadFile!("bafkreiabc");
    expect(Array.from(bytes!)).toEqual([1, 2, 3]);
    expect(calls[0].path).toBe("/content/bafkreiabc");
    expect(calls[0].options).toMatchObject({ auth: false, parse: "arrayBuffer" });
  });

  const problem = (status: number) => new ApiError(status, { status, title: "x", detail: "y" });

  it.each([404, 423, 451])("treats a %d from the content store as 'not held', not a mismatch", async (status) => {
    const { client } = clientOf(() => {
      throw problem(status);
    });
    expect(await createNodeProofSource(client).loadFile!("bafkreiabc")).toBeNull();
  });

  it("lets any other failure through, so the file is reported as not downloadable", async () => {
    const { client } = clientOf(() => {
      throw problem(500);
    });
    await expect(createNodeProofSource(client).loadFile!("bafkreiabc")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("describeProofError", () => {
  it("uses an unavailable error's own words", () => {
    expect(describeProofError(new ProofUnavailableError("Nothing here."))).toBe("Nothing here.");
  });

  it("says the node could not be reached for a network failure", () => {
    expect(describeProofError(new NetworkError("https://n.example/v1/x"))).toBe(
      "Scholium could not reach the node. You may be offline.",
    );
  });

  it("uses the API's detail, and says so plainly for a 404", () => {
    expect(describeProofError(new ApiError(503, { status: 503, title: "Unavailable", detail: "The node key is missing." }))).toBe(
      "The node key is missing.",
    );
    expect(describeProofError(new ApiError(404, { status: 404, title: "Not Found", detail: "No record." }))).toBe(
      "The node has no proof for this paper.",
    );
  });

  it("never returns an empty sentence", () => {
    expect(describeProofError(new Error(""))).toBe("The proof could not be checked.");
    expect(describeProofError("boom")).toBe("The proof could not be checked.");
    expect(describeProofError(undefined)).toBe("The proof could not be checked.");
  });
});
