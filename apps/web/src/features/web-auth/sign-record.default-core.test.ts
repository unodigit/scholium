// @vitest-environment node
//
// How `signRecord` finds verify-core when no `computeRecordCid` is injected.
// verify-core is replaced with `vi.doMock`, so these tests cover the lazy-load
// wiring itself and run without `@ipld/dag-cbor` installed. The real library is
// exercised in `sign-record.verify-core.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordSigner } from "./sign-record";

afterEach(() => {
  vi.doUnmock("../verify-core");
  vi.resetModules();
});

/** Fresh `sign-record` module graph, so it re-imports whatever is mocked now. */
async function loadSignRecord() {
  vi.resetModules();
  return import("./sign-record");
}

function createSigner() {
  const signed: Uint8Array[] = [];
  const signer: RecordSigner = {
    didKey: async () => "did:key:z6MkTestAuthor",
    signWithPasskey: async (data) => {
      signed.push(data);
      return new Uint8Array(64).fill(7);
    },
  };
  return { signer, signed };
}

describe("signRecord default record id function", () => {
  it("computes the id with verify-core's computeRecordCid and signs its bytes", async () => {
    const cidBytes = new Uint8Array([1, 0x71, 0x12, 0x20, 9, 9, 9]);
    const computeRecordCid = vi.fn(() => ({
      bytes: cidBytes,
      toString: () => "bafyreiverifycore",
    }));
    vi.doMock("../verify-core", () => ({ computeRecordCid }));
    const { signRecord } = await loadSignRecord();
    const { signer, signed } = createSigner();

    const record = await signRecord("paper.genesis", { title: "T" }, null, {
      signer,
      now: () => Date.UTC(2026, 10, 14, 5, 33, 0),
    });

    expect(computeRecordCid).toHaveBeenCalledTimes(1);
    expect(computeRecordCid).toHaveBeenCalledWith({
      v: 1,
      type: "paper.genesis",
      author: "did:key:z6MkTestAuthor",
      created: "2026-11-14T05:33:00Z",
      prev: null,
      body: { title: "T" },
      proofs: [],
    });
    expect(record.id).toBe("bafyreiverifycore");
    expect(signed).toEqual([cidBytes]);
  });

  it("raises record-id-failed, without a prompt, when verify-core cannot load", async () => {
    vi.doMock("../verify-core", () => {
      throw new Error("Cannot find package '@ipld/dag-cbor'");
    });
    const { signRecord } = await loadSignRecord();
    const { signer, signed } = createSigner();

    const error = await signRecord("t", {}, null, { signer }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      name: "RecordSigningError",
      code: "record-id-failed",
    });
    expect((error as Error).cause).toBeDefined();
    expect(signed).toHaveLength(0);
  });
});
