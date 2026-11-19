import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeRecordId,
  didKeyFromSeed,
  signEnvelope,
  verifyPaper,
  type VerifyPaperOptions,
} from "../verify-core";
import { formatDate } from "../ui-kit/format-date";
import { PENDING_PROOF, type RecordProofInfo } from "./anchor";
import {
  abbreviateId,
  archiveCommand,
  buildChecklist,
  checkLines,
  cliWording,
  offlineCommand,
  technicalRows,
  verdictCopy,
  verdictState,
  withdrawalFromRecords,
  type ItemKey,
  type ItemState,
} from "./checklist";
import type { WithdrawalNotice } from "./checklist";
import { versionManifest } from "./files";
import { buildPaper } from "./proof-fixtures";
import { LOCAL_PRESERVATION, type PreservationInfo } from "./preservation";

/** A seed for `didKeyFromSeed`, the same shape `proof-fixtures` uses. */
function seedFor(author: number): Uint8Array {
  return new Uint8Array(32).fill(author + 1);
}

/** A genuinely signed notice record, the shape the node's export serves. */
function signNotice(
  author: number,
  type: string,
  body: Record<string, unknown>,
  created: string,
): Record<string, unknown> {
  const envelope = {
    v: 1,
    type,
    author: didKeyFromSeed(seedFor(author)),
    created,
    prev: null,
    body,
    proofs: [],
  };
  return {
    ...envelope,
    id: computeRecordId(envelope),
    sig: signEnvelope(envelope, seedFor(author)),
  };
}

/**
 * The browser's checklist must fold verify-core's six checks into the same
 * five lines, with the same fail/warn rules, as `scholium verify`
 * (`apps/api/packages/cli/src/scholium_cli/checklist.py`). The shared
 * verification vectors are what both verifiers are pinned to, so running every
 * one of them through the checklist is the cq-19 check: "does the in-browser
 * indicator give the same result as the CLI verifier?"
 */

interface Vector {
  name: string;
  records: Array<Record<string, unknown>>;
  call: VerifyPaperOptions;
  expect: {
    status: string;
    version_count: number;
    checks: Record<string, boolean>;
  };
}

function vectorsPath(): string {
  const candidates = [
    resolve(process.cwd(), "../api/packages/record-core/vectors/verification.json"),
    resolve(process.cwd(), "apps/api/packages/record-core/vectors/verification.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const vectors = (JSON.parse(readFileSync(vectorsPath(), "utf8")) as { vectors: Vector[] })
  .vectors;

const ANCHORED: RecordProofInfo = {
  seq: 38,
  anchor: {
    status: "anchored",
    anchoredAt: "2027-03-02T04:00:00Z",
    chain: "8453",
    batch: "18211",
    txUrl: "https://basescan.org/tx/0xabc",
  },
};

function checklistOf(
  vector: Vector,
  proof: RecordProofInfo = PENDING_PROOF,
  preservation: PreservationInfo | null = LOCAL_PRESERVATION,
) {
  const report = verifyPaper(vector.records, vector.call);
  const manifest = versionManifest(vector.records, report);
  const items = buildChecklist({
    report,
    manifest,
    fileResults: [],
    proof,
    preservation,
    withdrawal: null,
  });
  const states = Object.fromEntries(items.map((item) => [item.key, item.state])) as Record<
    ItemKey,
    ItemState
  >;
  return { report, items, states, state: verdictState(items, report, proof) };
}

describe("the checklist agrees with the shared vectors (and so with the CLI)", () => {
  for (const vector of vectors) {
    it(`${vector.name}`, () => {
      const { states, state, items } = checklistOf(vector);
      const checks = vector.expect.checks;
      const invalid = vector.expect.status === "invalid";

      // The CLI's rule for each line: a fail exactly when one of its checks failed.
      expect(states.authors === "fail").toBe(!checks.signatures || !checks.consents);
      expect(states.history === "fail").toBe(!checks.chain || !checks.prev_hashes);
      expect(states.retraction === "fail").toBe(!checks.supersession);
      // The files line also depends on the files themselves; here none are held,
      // so only a failed manifest check can fail it.
      expect(states.files === "fail").toBe(!checks.manifests);

      // The verdict is the CLI's exit code: non-zero exactly for invalid papers.
      expect(state === "failed").toBe(invalid);
      expect(items.some((item) => item.state === "fail")).toBe(invalid);

      if (!invalid) {
        // Status is not a failure: a retracted paper's history still verifies.
        const warns = ["retracted", "tombstoned", "corrected"].includes(vector.expect.status);
        expect(states.retraction).toBe(warns ? "warn" : "pass");
        // Not anchored: pending, never a pass.
        expect(states.anchor).toBe("pending");
        expect(state).toBe("anchor_pending");
      }
    });
  }

  it("exercises every status verify-core can report", () => {
    // Guards against the vectors silently not loading (an empty loop passes).
    const statuses = new Set(vectors.map((vector) => vector.expect.status));
    expect([...statuses].sort()).toEqual(
      ["corrected", "invalid", "retracted", "tombstoned", "verified"],
    );
  });
});

describe("plain-language lines", () => {
  const verified = vectors.find((vector) => vector.name === "verified-three-versions")!;

  it("says the seven plain things, in order, with the ledger and preservation lines", () => {
    const { items } = checklistOf(verified);
    expect(items.map((item) => item.key)).toEqual([
      "authors",
      "history",
      "files",
      "ledger",
      "anchor",
      "retraction",
      "preservation",
    ]);
    expect(items[0].text).toBe("Signed by all 3 listed authors");
    expect(items[1].text).toMatch(/^Version history is intact \(v1 → v3\)/);
    expect(items[3].text).toBe("Recorded in the node's public log (entry number not reported)");
    expect(items[4].text).toBe(
      "Timestamp anchor pending: anchoring is not enabled on this node yet",
    );
    expect(items[5].text).toBe("No retraction or correction on record");
    expect(items[6]).toMatchObject({
      state: "pending",
      text: "Preserved: 1 of 1 local copy",
      details: ["Multi-operator replication is not enabled yet."],
      link: { href: "/network", label: "Network details" },
    });
  });

  it("says 'the listed author' for a paper with one author", () => {
    const paper = buildPaper({ authors: 1 });
    const report = verifyPaper(paper.records, { paper: paper.shortId });
    expect(report.status).toBe("verified");
    const items = buildChecklist({
      report,
      manifest: versionManifest(paper.records, report),
      fileResults: [],
      proof: PENDING_PROOF,
      preservation: LOCAL_PRESERVATION,
      withdrawal: null,
    });
    expect(items[0]).toMatchObject({ state: "pass", text: "Signed by the listed author" });
  });

  it("says 'both listed authors' for two authors, not the ungrammatical 'all 2'", () => {
    const paper = buildPaper({ authors: 2 });
    const report = verifyPaper(paper.records, { paper: paper.shortId });
    const items = buildChecklist({
      report,
      manifest: versionManifest(paper.records, report),
      fileResults: [],
      proof: PENDING_PROOF,
      preservation: LOCAL_PRESERVATION,
      withdrawal: null,
    });
    expect(items[0]).toMatchObject({ state: "pass", text: "Signed by both listed authors" });
  });

  it("rewords the checks' own counts: previous-version links are versions − 1, listed authors in words", () => {
    const messages = (records: readonly Record<string, unknown>[], shortId: string) =>
      Object.fromEntries(
        checkLines(verifyPaper(records, { paper: shortId })).map((line) => [
          line.name,
          line.message,
        ]),
      );

    // verify-core writes "All 1 prev link match…" and "Signed by all 2…";
    // the technical details say the same fact in grammatical English.
    const two = buildPaper({ authors: 2, versions: 2 });
    const twoLines = messages(two.records, two.shortId);
    // A chain of two versions has ONE previous-version link: the oldest
    // version's link is to the genesis record, not to a previous version
    // (bug_spec_verify6 bug 2).
    expect(twoLines.prev_hashes).toBe(
      "The previous-version link matches the hash of the record it names",
    );
    expect(twoLines.consents).toBe(
      "Signed by both listed authors (every version has a consent from each of its authors)",
    );

    const four = buildPaper({ authors: 2, versions: 4 });
    expect(messages(four.records, four.shortId).prev_hashes).toBe(
      "All 3 previous-version links match the hash of the record they name",
    );

    const first = buildPaper({ authors: 2, versions: 1 });
    expect(messages(first.records, first.shortId).prev_hashes).toBe(
      "The first version's link to the genesis record matches its hash",
    );
  });

  it("explains a tampered record in words, with the technical finding underneath", () => {
    const tampered = vectors.find((vector) => vector.name === "invalid-tampered-head-body")!;
    const { items } = checklistOf(tampered);
    expect(items[0]).toMatchObject({
      key: "authors",
      state: "fail",
      text: "A record was altered, or its signature does not match its author",
    });
    expect(items[0].details.join(" ")).toMatch(/id does not match the hash of its content/);
  });

  it("does not repeat a broken history on every line", () => {
    const fork = vectors.find((vector) => vector.name === "invalid-fork-without-a-chosen-head")!;
    const { items } = checklistOf(fork);
    const [authors, history, files, , , retraction] = items;
    expect(history).toMatchObject({ state: "fail", text: "The version history is broken" });
    expect(history.details.join(" ")).toMatch(/competing heads/);
    for (const downstream of [authors, files, retraction]) {
      expect(downstream.text).toBe("Not checked, because the version history is broken");
      expect(downstream.details).toEqual([]);
    }
  });

  it("names a missing consent as an author who has not signed", () => {
    const missing = vectors.find((vector) => vector.name === "invalid-missing-consent")!;
    expect(checklistOf(missing).items[0]).toMatchObject({
      state: "fail",
      text: "Not every listed author has signed",
    });
  });

  it("names a forged retraction as not genuine, and fails the paper like the CLI", () => {
    const forged = vectors.find((vector) => vector.name === "invalid-forged-retraction")!;
    const { items, state } = checklistOf(forged);
    expect(items[5]).toMatchObject({
      state: "fail",
      text: "A retraction or correction on record is not genuine",
    });
    expect(state).toBe("failed");
  });

  it("warns, rather than fails, for a retraction, and says the history still verifies", () => {
    const retracted = vectors.find((vector) => vector.name === "retracted-by-author")!;
    const { items, state } = checklistOf(retracted);
    expect(items[5]).toMatchObject({ state: "warn" });
    expect(items[5].text).toMatch(/Retracted.*history still verifies/);
    expect(state).toBe("anchor_pending");
  });

  it("names people and records in words: no record id or did:key in the primary list", () => {
    const retracted = vectors.find((vector) => vector.name === "retracted-by-author")!;
    const { items, report } = checklistOf(retracted);
    expect(items[5].details[0]).toBe("Retraction notice signed by a listed author (applies)");
    for (const detail of items[5].details) {
      expect(detail).not.toMatch(/^retraction bafy/i);
      expect(detail).not.toMatch(/did:key/);
    }

    const corrected = vectors.find((vector) => vector.name === "corrected-by-co-author")!;
    const correction = checklistOf(corrected).items[5];
    expect(correction.text).toMatch(/^Corrected/);
    expect(correction.details[0]).toBe("Correction notice signed by a listed author (applies)");

    // The raw ids the details used to print live in the technical details instead.
    const notice = report.supersessions[0];
    const rows = technicalRows({
      report,
      manifest: versionManifest(retracted.records, report),
      proof: PENDING_PROOF,
      withdrawal: null,
    });
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "notice-1-record", label: "Retraction record", value: notice.id }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "notice-1-signer", label: "Retraction signer", value: notice.author }),
    );
  });

  it("shows a notice that does not apply as information, not as a warning", () => {
    const outsider = vectors.find(
      (vector) => vector.name === "retraction-by-outsider-is-not-applied",
    )!;
    const { items } = checklistOf(outsider);
    expect(items[5].state).toBe("pass");
    expect(items[5].details[0]).toMatch(
      /^Retraction notice signed by an unrecognised signer \(not applied: signer is neither an author/,
    );
  });

  it("names a trusted authority's tombstone in words too", () => {
    const vector = vectors.find(
      (entry) => entry.name === "tombstoned-by-trusted-authority",
    )!;
    const { items } = checklistOf(vector);
    expect(items[5].details[0]).toBe("Tombstone notice signed by a trusted authority (applies)");
  });
});

describe("the withdrawal notice (D1: a withdrawal changes no status, so the row names it)", () => {
  const vector = vectors.find((entry) => entry.name === "verified-single-version")!;
  const WITHDRAWN_AT = "2026-11-14T12:00:00Z";
  const NOTICE_ID = "bafyreicwithdrawalnotice0000000000000000000000";

  function itemsOf(
    withdrawal: WithdrawalNotice | null,
    vectorName = vector.name,
  ) {
    const chosen = vectors.find((entry) => entry.name === vectorName)!;
    const report = verifyPaper(chosen.records, chosen.call);
    return buildChecklist({
      report,
      manifest: versionManifest(chosen.records, report),
      fileResults: [],
      proof: PENDING_PROOF,
      preservation: LOCAL_PRESERVATION,
      withdrawal,
    });
  }

  const signedByAuthor = (
    reportAuthor: string | null,
  ): WithdrawalNotice => ({
    id: NOTICE_ID,
    createdAt: WITHDRAWN_AT,
    author: reportAuthor,
    recordUrl: `https://node.example/v1/records/${NOTICE_ID}`,
  });

  it("names a withdrawal on the notice row, with the local date and a link to the notice record", () => {
    const chosen = vectors.find((entry) => entry.name === vector.name)!;
    const report = verifyPaper(chosen.records, chosen.call);
    const row = itemsOf(signedByAuthor(report.authors[0] ?? null))[5];
    // Neutral, per D1: a withdrawal is the authors taking the paper back, not
    // a defect in the proof, so the line stays a pass and the verdict with it.
    expect(row.state).toBe("pass");
    expect(row.text).toBe(
      `Withdrawn by the authors on ${formatDate(WITHDRAWN_AT)}. No retraction or correction on record`,
    );
    expect(row.link).toEqual({
      href: `https://node.example/v1/records/${NOTICE_ID}`,
      label: "View the withdrawal record",
    });
  });

  it("does not attribute a withdrawal someone else signed to the authors", () => {
    const row = itemsOf(signedByAuthor("did:key:z6MkSomeoneElse"))[5];
    expect(row.state).toBe("pass");
    expect(row.text).toBe(
      `Withdrawn on ${formatDate(WITHDRAWN_AT)}. No retraction or correction on record`,
    );
  });

  it("keeps the clean wording when there is no withdrawal", () => {
    const row = itemsOf(null)[5];
    expect(row).toMatchObject({
      state: "pass",
      text: "No retraction or correction on record",
      link: null,
    });
  });

  it("still warns for a correction, and names the withdrawal underneath it", () => {
    const row = itemsOf(
      signedByAuthor(null),
      "corrected-by-co-author",
    )[5];
    expect(row.state).toBe("warn");
    expect(row.text).toMatch(/^Corrected: a correction notice applies/);
    expect(row.details.at(-1)).toBe(`Withdrawn on ${formatDate(WITHDRAWN_AT)}`);
  });

  it("reads the withdrawal out of the loaded records: the newest wins, and only this paper's", () => {
    const paper = buildPaper({ authors: 2, versions: 2 });
    const older = signNotice(0, "withdrawal", {
      target: paper.genesisId,
      reason: "Taking the paper back.",
    }, "2026-11-01T09:00:00Z");
    const newer = signNotice(1, "withdrawal", {
      target: paper.versionIds[1],
      reason: "Taking the paper back, again.",
    }, "2026-11-14T12:00:00Z");
    const otherPaper = signNotice(0, "withdrawal", {
      target: "bafyreianotherpapergenesis0000000000000000000",
      reason: "Not this paper.",
    }, "2026-11-20T12:00:00Z");
    const report = verifyPaper(paper.records, { paper: paper.shortId });

    const found = withdrawalFromRecords(
      [...paper.records, older, newer, otherPaper],
      report,
      "https://node.example/",
    );
    expect(found).toEqual({
      id: newer.id,
      createdAt: "2026-11-14T12:00:00Z",
      author: newer.author,
      recordUrl: `https://node.example/v1/records/${newer.id}`,
    });

    // No withdrawal at all: nothing to name.
    expect(withdrawalFromRecords(paper.records, report, "https://node.example")).toBeNull();
  });

  it("carries the withdrawal record and signer in the technical details, one copy away", () => {
    const chosen = vectors.find((entry) => entry.name === vector.name)!;
    const report = verifyPaper(chosen.records, chosen.call);
    const rows = technicalRows({
      report,
      manifest: null,
      proof: PENDING_PROOF,
      withdrawal: signedByAuthor(report.authors[0] ?? null),
    });
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "withdrawal-record", label: "Withdrawal record", value: NOTICE_ID }),
    );
  });
});

describe("the timestamp line and the verdict", () => {
  const verified = vectors.find((vector) => vector.name === "verified-single-version")!;

  it("is Verified once the node reports an anchor, with a link to the transaction", () => {
    const { items, state } = checklistOf(verified, ANCHORED);
    expect(items[4]).toMatchObject({
      key: "anchor",
      state: "pass",
      text: "Timestamp anchored: 2 Mar 2027 04:00 UTC",
      link: { href: "https://basescan.org/tx/0xabc", label: "View transaction" },
    });
    expect(state).toBe("verified");
  });

  it("is 'Signed · anchor pending' until then", () => {
    const { items, state } = checklistOf(verified);
    expect(items[4]).toMatchObject({ state: "pending", link: null });
    expect(state).toBe("anchor_pending");
  });

  it("never promises a timestamp the node cannot add", () => {
    const { items } = checklistOf(verified);
    expect(items[4].text).toBe(
      "Timestamp anchor pending: anchoring is not enabled on this node yet",
    );
    expect(items[4].text).not.toMatch(/within the hour/i);
  });

  it("records the record's place in the node's public log when the node reports it", () => {
    const { items } = checklistOf(verified, { ...PENDING_PROOF, seq: 41 });
    expect(items[3]).toMatchObject({
      key: "ledger",
      state: "pass",
      text: "Recorded in the node's public log (entry #41)",
    });
  });

  it("is Failed whatever the anchor says when a check failed", () => {
    const tampered = vectors.find((vector) => vector.name === "invalid-tampered-genesis")!;
    expect(checklistOf(tampered, ANCHORED).state).toBe("failed");
  });
});

describe("technical details", () => {
  const verified = vectors.find((vector) => vector.name === "verified-three-versions")!;

  it("lists the version, manifest and paper records, the anchor and every signer", () => {
    const { report } = checklistOf(verified);
    const manifest = versionManifest(verified.records, report);
    const rows = technicalRows({
      report,
      manifest,
      proof: { ...PENDING_PROOF, seq: 7 },
      withdrawal: null,
    });
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey.version.value).toBe(report.head);
    expect(byKey.manifest.value).toBe(manifest!.cid);
    expect(byKey.paper.value).toBe(report.genesis);
    expect(byKey.anchor).toMatchObject({ value: "pending", kind: "text" });
    expect(byKey.version.kind).toBe("id");
    expect(byKey.log.value).toBe("#7");
    for (const did of report.signers) {
      expect(rows.some((row) => row.value === did)).toBe(true);
    }
  });

  it("says an anchor is the node's word, since the browser does not check the chain", () => {
    const { report } = checklistOf(verified);
    const rows = technicalRows({
      report,
      manifest: null,
      proof: ANCHORED,
      withdrawal: null,
    });
    const anchor = rows.find((row) => row.key === "anchor")!;
    expect(anchor.value).toBe(
      "chain 8453 · batch 18211 · anchored 2 Mar 2027 04:00 UTC · reported by the node",
    );
  });

  it("lists the six verify-core checks the way the CLI's --verbose does", () => {
    const { report } = checklistOf(verified);
    expect(checkLines(report).map((line) => [line.name, line.passed])).toEqual([
      ["chain", true],
      ["signatures", true],
      ["prev_hashes", true],
      ["consents", true],
      ["manifests", true],
      ["supersession", true],
    ]);
  });

  it("rewrites Python argument wording the way the CLI does", () => {
    expect(cliWording("name the one to verify with head=")).toBe(
      "name the one to verify with --head ",
    );
    expect(cliWording("no record for paper=sch:aaaa")).toBe("no record for --paper sch:aaaa");
    expect(cliWording("ahead=of the game")).toBe("ahead=of the game");
  });

  it("abbreviates long ids and leaves short ones whole", () => {
    expect(abbreviateId("bafyreihurc6q2dtup6cbkrt24i7whhyzfogfohqickmagdq7vutbhxlzla")).toBe(
      "bafyrei…lzla",
    );
    expect(abbreviateId("abc")).toBe("abc");
    expect(abbreviateId("pending")).toBe("pending");
  });
});

describe("the offline command", () => {
  it("names the downloaded archive the way the Download menu does", () => {
    expect(archiveCommand("sch:k3f9-q2xz-7mwd/v2")).toBe(
      "scholium verify sch-k3f9-q2xz-7mwd.car",
    );
    expect(archiveCommand("sch:k3f9-q2xz-7mwd")).toBe(
      "scholium verify sch-k3f9-q2xz-7mwd.car",
    );
    expect(archiveCommand("")).toBe("scholium verify paper.car");
  });

  it("names the version and the node, so it runs as printed", () => {
    expect(offlineCommand("sch:k3f9-q2xz-7mwd/v2", "https://node.example")).toBe(
      "scholium verify sch:k3f9-q2xz-7mwd/v2 --node https://node.example",
    );
  });

  it("drops a trailing slash from the node address", () => {
    expect(offlineCommand("sch:k3f9-q2xz-7mwd", "http://localhost:8000/")).toBe(
      "scholium verify sch:k3f9-q2xz-7mwd --node http://localhost:8000",
    );
  });

  it("quotes an address a shell would split or expand", () => {
    expect(offlineCommand("sch:k3f9-q2xz-7mwd/v1", "https://n.example/a b?x=$HOME")).toBe(
      "scholium verify sch:k3f9-q2xz-7mwd/v1 --node 'https://n.example/a b?x=$HOME'",
    );
    expect(offlineCommand("sch:k3f9-q2xz-7mwd/v1", "https://n.example/it's")).toContain(
      `'https://n.example/it'\\''s'`,
    );
  });
});

describe("verdictCopy", () => {
  it("uses the VerifyBadge's own words, so the header badge and this tab agree", () => {
    expect(verdictCopy("cannot_verify").headline).toBe("Could not check");
    expect(verdictCopy("failed").headline).toBe("Verification failed");
    expect(verdictCopy("checking").headline).toBe("Checking in your browser…");
    expect(verdictCopy("failed").summary).toMatch(/Do not rely on it/);
  });

  it("reads the PRD's counted line for a check that passed, then the anchor state", () => {
    // PRD journey 3: "Verified: 3 versions, 4 signatures, anchored 2027-03-02".
    // The anchor state follows as the summary, so a paper that is signed but
    // not anchored says so instead of promising a time.
    expect(verdictCopy("verified", { versions: 3, signatures: 4 })).toEqual({
      headline: "Verified · 4 author signatures across 3 versions",
      summary: "Every check passed and the public timestamp is in place.",
    });
    expect(verdictCopy("anchor_pending", { versions: 2, signatures: 3 })).toEqual({
      headline: "Verified · 3 author signatures across 2 versions",
      summary: "Signed. Anchoring is not enabled on this node yet.",
    });
  });

  it("keeps the badge's own label when there is nothing to count", () => {
    expect(verdictCopy("verified").headline).toBe("Verified");
    expect(verdictCopy("anchor_pending").headline).toBe("Signed · anchor pending");
  });
});

describe("the preservation line", () => {
  const report = verifyPaper(
    vectors.find((vector) => vector.name === "verified-single-version")!.records,
    vectors.find((vector) => vector.name === "verified-single-version")!.call,
  );

  function preservationOf(info: PreservationInfo | null) {
    return buildChecklist({
      report,
      manifest: null,
      fileResults: [],
      proof: PENDING_PROOF,
      preservation: info,
      withdrawal: null,
    }).find((item) => item.key === "preservation")!;
  }

  it("says what this single-node deployment honestly holds, and links to /network", () => {
    expect(preservationOf(LOCAL_PRESERVATION)).toMatchObject({
      state: "pending",
      text: "Preserved: 1 of 1 local copy",
      details: ["Multi-operator replication is not enabled yet."],
      link: { href: "/network", label: "Network details" },
    });
  });

  it("passes a node whose replicas are at target and not only local", () => {
    expect(preservationOf({ have: 5, of: 5, local: false })).toMatchObject({
      state: "pass",
      text: "Preserved: 5 of 5 replicas",
      details: [],
    });
  });

  it("stays honest while a multi-replica node is still filling", () => {
    expect(preservationOf({ have: 2, of: 5, local: false })).toMatchObject({
      state: "pending",
      text: "Preserved: 2 of 5 replicas",
      details: [],
    });
  });

  it("says so, rather than guessing, when the node did not answer", () => {
    expect(preservationOf(null)).toMatchObject({
      state: "warn",
      text: "This node's preservation state could not be read",
      link: { href: "/network", label: "Network details" },
    });
  });
});
