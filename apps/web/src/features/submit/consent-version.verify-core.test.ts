// @vitest-environment node
//
// The consent a co-author signs on /consent/[version], counted by the real
// verify-core: the body shape (`version`, `role`, `decision`) and `prev: null`
// are what a verifier reads, so a regression here would leave a paper that
// every author "signed" unverifiable.
//
// Records are signed over the canonical record bytes (`recordBytes`), which is
// what the API's ingest and verify-core check. The helper below does that
// itself rather than going through `signRecord`, so this suite pins the
// consent record and nothing else.
import { describe, expect, it } from "vitest";

import { computeRecordId, recordBytes, verifyPaper } from "../verify-core";
import {
  createEd25519Crypto,
  didKeyFromEd25519PublicKey,
  toBase64Url,
  type SignedRecord,
} from "../web-auth";
import {
  loadConsentVersion,
  normalizeConsentVersion,
  submitConsent,
  type ConsentVersion,
  type SignConsent,
} from "./consent-version";

const NOW = Date.UTC(2026, 10, 14, 5, 33, 0);

interface Author {
  did: string;
  sign: SignConsent;
}

async function createAuthor(): Promise<Author> {
  const ed25519 = createEd25519Crypto();
  const pair = await ed25519.generateKeyPair();
  const did = didKeyFromEd25519PublicKey(await ed25519.exportPublicKey(pair.publicKey));
  const sign: SignConsent = async (type, body, prev) => {
    const envelope = {
      v: 1,
      type,
      author: did,
      created: new Date(NOW).toISOString().replace(/\.\d{3}Z$/, "Z"),
      prev,
      body,
      proofs: [],
    };
    const signature = await ed25519.sign(pair.privateKey, recordBytes(envelope));
    return { ...envelope, id: computeRecordId(envelope), sig: toBase64Url(signature) } as SignedRecord;
  };
  return { did, sign };
}

const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/** A signed paper with two listed authors; nobody has consented yet. */
async function publishedPaper() {
  const [mei, rafael] = await Promise.all([createAuthor(), createAuthor()]);
  const authors = [
    { did: mei.did, position: 1, name: "Mei Chen", creditRoles: ["Conceptualization"] },
    { did: rafael.did, position: 2, name: "Rafael Silva", creditRoles: ["Software", "Validation"] },
  ];
  const genesis = await mei.sign(
    "paper.genesis",
    { seed: "seed-1", title: "Sparse Probing", abstract: "We probe.", categories: ["cs.AI"], licence: "CC-BY-4.0", authors },
    null,
  );
  const manifest = await mei.sign(
    "manifest",
    { files: [{ path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" }] },
    null,
  );
  const versionRecord = await mei.sign(
    "paper.version",
    {
      paper: genesis.id,
      n: 1,
      title: "Sparse Probing",
      abstract: "We probe.",
      authors,
      manifest: manifest.id,
      licence: "CC-BY-4.0",
      changeNote: "Initial version.",
      categories: ["cs.AI"],
    },
    genesis.id,
  );
  const version: ConsentVersion = normalizeConsentVersion(versionRecord, versionRecord.id);
  return { mei, rafael, genesis, manifest, versionRecord, version };
}

/** What the API stores and serves: the envelope with its id, without `sig`. */
function served(record: SignedRecord): Record<string, unknown> {
  const { sig: _sig, ...envelope } = record;
  return envelope;
}

describe("a consent signed on /consent/[version], seen by verify-core", () => {
  it("is counted as each author's acceptance, so the paper verifies", async () => {
    const { mei, rafael, genesis, manifest, versionRecord, version } = await publishedPaper();
    const consents: SignedRecord[] = [];
    const submit = async (record: SignedRecord) => {
      consents.push(record);
      return { id: record.id };
    };

    for (const [author, who] of [[mei, 0], [rafael, 1]] as const) {
      await submitConsent({ version, author: version.authors[who], decision: "accept", sign: author.sign, submit });
    }

    expect(consents.map((c) => [c.type, c.prev, c.body.decision, c.body.role])).toEqual([
      ["coauthor.consent", null, "accept", "Conceptualization"],
      ["coauthor.consent", null, "accept", "Software, Validation"],
    ]);
    expect(consents.every((c) => c.body.version === versionRecord.id)).toBe(true);

    const report = verifyPaper([genesis, manifest, versionRecord, ...consents]);
    expect(report.checks.consents).toMatchObject({
      passed: true,
      message: expect.stringContaining("Signed by all 2 listed authors"),
    });
    expect(report.status).toBe("verified");
  });

  it("without the other author's answer leaves the paper unverified, naming who is missing", async () => {
    const { mei, rafael, genesis, manifest, versionRecord, version } = await publishedPaper();
    const consents: SignedRecord[] = [];
    await submitConsent({
      version,
      author: version.authors[0],
      decision: "accept",
      sign: mei.sign,
      submit: async (record) => {
        consents.push(record);
        return { id: record.id };
      },
    });

    const report = verifyPaper([genesis, manifest, versionRecord, ...consents]);
    expect(report.checks.consents.passed).toBe(false);
    expect(report.checks.consents.details).toEqual([expect.stringContaining(`no consent from ${rafael.did}`)]);
  });

  it("when declined is counted as a decline: the paper does not verify and the decliner is named", async () => {
    const { mei, rafael, genesis, manifest, versionRecord, version } = await publishedPaper();
    const consents: SignedRecord[] = [];
    const submit = async (record: SignedRecord) => {
      consents.push(record);
      return { id: record.id };
    };
    await submitConsent({ version, author: version.authors[0], decision: "accept", sign: mei.sign, submit });
    await submitConsent({
      version,
      author: version.authors[1],
      decision: "decline",
      comment: "I did not agree to this version.",
      sign: rafael.sign,
      submit,
    });

    expect(consents[1].body).toEqual({
      version: versionRecord.id,
      role: "Software, Validation",
      decision: "decline",
      comment: "I did not agree to this version.",
    });
    const report = verifyPaper([genesis, manifest, versionRecord, ...consents]);
    expect(report.checks.consents.passed).toBe(false);
    expect(report.checks.consents.details.join("\n")).toContain(`declined by ${rafael.did}`);
    expect(report.status).not.toBe("verified");
  });

  it("is signed for the version the page loaded: a record served for that id checks out, a swapped one does not", async () => {
    const { versionRecord, manifest } = await publishedPaper();

    const loaded = await loadConsentVersion(versionRecord.id, {
      fetchRecord: async (cid) => served(cid === manifest.id ? manifest : versionRecord),
    });
    expect(loaded).toMatchObject({ versionCid: versionRecord.id, n: 1, title: "Sparse Probing" });
    expect(loaded.files).toEqual([
      { path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" },
    ]);

    const swapped = { ...served(versionRecord), body: { ...versionRecord.body, title: "A different paper" } };
    await expect(loadConsentVersion(versionRecord.id, { fetchRecord: async () => swapped })).rejects.toMatchObject({
      code: "mismatch",
    });
  });
});
