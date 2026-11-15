import { describe, expect, it } from "vitest";

import { PENDING_PROOF, formatAnchorTime, parseRecordProof } from "./anchor";

/** The body `GET /v1/records/{cid}/proof` serves today (ledger/proof.py). */
const NODE_BODY = {
  seq: 38,
  entry_hash: "9f86d081884c7d659a2feaa0c55ad015",
  prev_hash: "2c26b46b68ffc68ff99b453c1d304134",
  head: { seq: 41, entry_hash: "6030", node_did: "did:key:z6Mk", signature: "VXJ4" },
  anchor: "pending",
};

describe("parseRecordProof", () => {
  it("reads what the node serves today: pending, with the log position", () => {
    expect(parseRecordProof(NODE_BODY)).toEqual({ anchor: { status: "pending" }, seq: 38 });
  });

  it("reads an anchored proof", () => {
    expect(
      parseRecordProof({
        ...NODE_BODY,
        anchor: {
          status: "anchored",
          anchored_at: "2027-03-02T04:00:00Z",
          chain: 8453,
          batch: "18211",
          tx_url: "https://basescan.org/tx/0xabc",
        },
      }).anchor,
    ).toEqual({
      status: "anchored",
      anchoredAt: "2027-03-02T04:00:00Z",
      chain: "8453",
      batch: "18211",
      txUrl: "https://basescan.org/tx/0xabc",
    });
  });

  it("renders only https transaction links, so a node's string is never a script URL", () => {
    const anchored = (tx_url: unknown) =>
      parseRecordProof({
        anchor: { status: "anchored", anchored_at: "2027-03-02T04:00:00Z", tx_url },
      }).anchor;
    for (const bad of ["javascript:alert(1)", "http://insecure.example/tx", "data:text/html,x", "not a url", 7, null]) {
      expect(anchored(bad)).toMatchObject({ status: "anchored", txUrl: null });
    }
  });

  it("never reads an unfamiliar answer as more verified than it is", () => {
    for (const body of [
      null,
      undefined,
      "pending",
      [],
      {},
      { anchor: "anchored" },
      { anchor: { status: "anchored" } },
      { anchor: { status: "anchored", anchored_at: "yesterday" } },
      { anchor: { status: "confirmed", anchored_at: "2027-03-02T04:00:00Z" } },
    ]) {
      expect(parseRecordProof(body).anchor).toEqual({ status: "pending" });
    }
    expect(parseRecordProof(null)).toBe(PENDING_PROOF);
  });

  it("ignores a log position that is not a non-negative integer", () => {
    for (const seq of [-1, 1.5, "7", null, Number.NaN]) {
      expect(parseRecordProof({ seq, anchor: "pending" }).seq).toBeNull();
    }
    expect(parseRecordProof({ seq: 0, anchor: "pending" }).seq).toBe(0);
  });
});

describe("formatAnchorTime", () => {
  it("is the same wording everywhere: day, month, year, 24-hour UTC time", () => {
    expect(formatAnchorTime("2027-03-02T04:00:00Z")).toBe("2 Mar 2027 04:00 UTC");
    expect(formatAnchorTime("2027-12-31T23:59:59Z")).toBe("31 Dec 2027 23:59 UTC");
  });

  it("states the instant in UTC whatever offset it was given in", () => {
    expect(formatAnchorTime("2027-03-02T05:30:00+05:30")).toBe("2 Mar 2027 00:00 UTC");
  });

  it("hands back text it cannot read rather than 'Invalid Date'", () => {
    expect(formatAnchorTime("soon")).toBe("soon");
  });
});
