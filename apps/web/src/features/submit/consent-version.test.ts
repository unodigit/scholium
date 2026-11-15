// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError, RecordSigningError, type SignedRecord } from "../web-auth";
import { shortDid } from "./authors";
import {
  CONSENT_COMMENT_MAX,
  ConsentVersionError,
  WrongSignerError,
  closedMessage,
  consentBody,
  consentGate,
  consentRole,
  consentTrackerEntries,
  describeConsentError,
  fileUrl,
  formatSigned,
  loadConsentVersion,
  manifestFiles,
  normalizeConsentVersion,
  parseVersionParam,
  recordUrl,
  submitConsent,
  versionErrorMessage,
  type ConsentVersion,
  type DeviceIdentity,
  type VersionAuthor,
} from "./consent-version";
import type { ConsentReport } from "./consents";

const A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const C = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSRPnE";
const GENESIS = "bafyreigenesis7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const MANIFEST = "bafyreimanifest7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

afterEach(() => {
  vi.unstubAllEnvs();
});

function versionEnvelope(body: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "paper.version",
    author: A,
    created: "2026-11-14T05:33:00Z",
    prev: GENESIS,
    body: {
      paper: GENESIS,
      n: 2,
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models.",
      authors: [
        { did: A, position: 1, name: "Mei Chen", creditRoles: ["Conceptualization"] },
        { did: B, position: 2, name: "Rafael Silva", creditRoles: ["Software", "Validation"] },
        { did: C, position: 3, creditRoles: [] },
      ],
      manifest: MANIFEST,
      licence: "CC-BY-4.0",
      changeNote: "Fixed the proof of Lemma 2.",
      categories: ["cs.AI"],
      ...body,
    },
    proofs: [],
    ...over,
  };
}

function manifestEnvelope(files: unknown[] = [{ path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" }]) {
  return {
    v: 1,
    type: "manifest",
    author: A,
    created: "2026-11-14T05:32:00Z",
    prev: null,
    body: { files },
    proofs: [],
  };
}

const VERSION_CID = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";

function version(over: Partial<ConsentVersion> = {}): ConsentVersion {
  return { ...normalizeConsentVersion(versionEnvelope(), VERSION_CID), ...over };
}

function author(did: string, over: Partial<VersionAuthor> = {}): VersionAuthor {
  return { did, position: 1, name: null, orcid: null, creditRoles: [], ...over };
}

function report(state: string, rows: Array<[string, string]>, over: Partial<ConsentReport> = {}): ConsentReport {
  const authors = rows.map(([did, status], index) => ({
    did,
    position: index + 1,
    status,
    consentCid: status === "waiting" ? null : `bafyreiconsent${index}`,
  }));
  const count = (status: string) => rows.filter(([, s]) => s === status).length;
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 2,
    versionCid: VERSION_CID,
    state,
    count: rows.length,
    waiting: count("waiting"),
    signed: count("signed"),
    declined: count("declined"),
    authors,
    ...over,
  };
}

const READY = (did: string | null): DeviceIdentity => ({ phase: "ready", did });

describe("parseVersionParam", () => {
  it("takes a record id", () => {
    expect(parseVersionParam(VERSION_CID)).toEqual({ cid: VERSION_CID });
  });

  it("decodes and trims what the router hands over", () => {
    expect(parseVersionParam(`%20${VERSION_CID}%20`)).toEqual({ cid: VERSION_CID });
  });

  it.each([
    ["", /does not say which version/],
    ["   ", /does not say which version/],
    ["%E0%A4%A", /not a paper version/],
    ["../../etc/passwd", /not a paper version/],
    ["abc", /not a paper version/],
    ["bafy/with/slashes0000", /not a paper version/],
    ["x".repeat(129), /not a paper version/],
  ])("refuses %j with a reason a reader can act on", (raw, reason) => {
    const parsed = parseVersionParam(raw);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toMatch(reason);
  });
});

describe("normalizeConsentVersion", () => {
  it("shapes the signed version for the page", () => {
    const shaped = normalizeConsentVersion(versionEnvelope(), VERSION_CID);
    expect(shaped).toMatchObject({
      versionCid: VERSION_CID,
      paper: GENESIS,
      n: 2,
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models.",
      categories: ["cs.AI"],
      licence: "CC-BY-4.0",
      changeNote: "Fixed the proof of Lemma 2.",
      submittedBy: A,
      created: "2026-11-14T05:33:00Z",
      manifest: MANIFEST,
      files: null,
    });
    expect(shaped.authors.map((a) => [a.did, a.position, a.name, a.creditRoles])).toEqual([
      [A, 1, "Mei Chen", ["Conceptualization"]],
      [B, 2, "Rafael Silva", ["Software", "Validation"]],
      [C, 3, null, []],
    ]);
  });

  it("reads authors the way the API does: bare DIDs, other role spellings, byline order, no repeats", () => {
    const shaped = normalizeConsentVersion(
      versionEnvelope({
        authors: [
          { did: B, position: 2, credit: ["Software"] },
          A,
          { did: B, position: 9 },
          { did: C, credit_roles: ["Validation", 7, " "] },
          { name: "No did" },
          42,
        ],
      }),
      VERSION_CID,
    );
    // A is the second entry and so position 2; B declares 2 as well, C is third.
    expect(shaped.authors.map((a) => a.did)).toEqual([B, A, C]);
    expect(shaped.authors.find((a) => a.did === B)?.creditRoles).toEqual(["Software"]);
    expect(shaped.authors.find((a) => a.did === C)?.creditRoles).toEqual(["Validation"]);
  });

  it("refuses a record of another type", () => {
    expect(() => normalizeConsentVersion(versionEnvelope({}, { type: "manifest" }), VERSION_CID)).toThrow(
      expect.objectContaining({ name: "ConsentVersionError", code: "not-a-version" }),
    );
    expect(() => normalizeConsentVersion("nonsense", VERSION_CID)).toThrow(ConsentVersionError);
    expect(() => normalizeConsentVersion(null, VERSION_CID)).toThrow(ConsentVersionError);
  });

  it.each([
    ["no paper", { paper: undefined }],
    ["a blank paper", { paper: "  " }],
    ["no number", { n: undefined }],
    ["version 0", { n: 0 }],
    ["a fractional number", { n: 1.5 }],
    ["a text number", { n: "2" }],
  ])("refuses a version with %s, which a consent report cannot be asked for", (_label, body) => {
    expect(() => normalizeConsentVersion(versionEnvelope(body), VERSION_CID)).toThrow(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("copes with a sparse body", () => {
    const shaped = normalizeConsentVersion(
      versionEnvelope({ title: undefined, abstract: undefined, authors: undefined, licence: " ", changeNote: undefined, categories: "cs.AI", manifest: undefined }),
      VERSION_CID,
    );
    expect(shaped).toMatchObject({ title: "", abstract: "", authors: [], licence: null, changeNote: null, categories: [], manifest: null });
  });
});

describe("manifestFiles", () => {
  it("lists the files with what is known about each", () => {
    expect(
      manifestFiles(
        manifestEnvelope([
          { path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" },
          { path: "notes.txt" },
          { cid: PDF },
          { path: "odd.bin", size: -1 },
          "nope",
        ]),
      ),
    ).toEqual([
      { path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" },
      { path: "notes.txt", cid: null, size: null, mediaType: null, role: null },
      { path: "odd.bin", cid: null, size: null, mediaType: null, role: null },
    ]);
  });

  it("is empty for a manifest with no file list and refuses any other record", () => {
    expect(manifestFiles({ ...manifestEnvelope(), body: {} })).toEqual([]);
    expect(() => manifestFiles(versionEnvelope())).toThrow(ConsentVersionError);
  });
});

describe("loadConsentVersion", () => {
  /** A server that holds these envelopes under their real ids (verify-core computes them). */
  async function serverHolding(...envelopes: Array<Record<string, unknown>>) {
    const core = await import("../verify-core");
    const byId = new Map<string, unknown>();
    for (const envelope of envelopes) {
      byId.set(core.computeRecordId(envelope), { ...envelope, id: core.computeRecordId(envelope) });
    }
    const fetchRecord = vi.fn(async (cid: string) => {
      if (!byId.has(cid)) {
        throw new ApiError(404, { status: 404, title: "Not Found" });
      }
      return byId.get(cid);
    });
    return { fetchRecord, ids: [...byId.keys()], byId };
  }

  it("loads the version and its files, and the id of what it read is the one asked for", async () => {
    const core = await import("../verify-core");
    const manifest = manifestEnvelope();
    // The version names the manifest by its real id.
    const manifestId = core.computeRecordId(manifest);
    const named = versionEnvelope({ manifest: manifestId });
    const server = await serverHolding(named, manifest);
    const versionId = core.computeRecordId(named);

    const loaded = await loadConsentVersion(versionId, { fetchRecord: server.fetchRecord });

    expect(loaded).toMatchObject({ versionCid: versionId, n: 2, title: "Sparse Probing of Reward Models", manifest: manifestId });
    expect(loaded.files).toEqual([{ path: "paper.pdf", cid: PDF, size: 2048, mediaType: "application/pdf", role: "manuscript" }]);
    expect(server.fetchRecord).toHaveBeenCalledTimes(2);
  });

  it("does not show a record the server swapped: the id has to match the link", async () => {
    const core = await import("../verify-core");
    const real = versionEnvelope();
    const realId = core.computeRecordId(real);
    // The server answers the real id with a different paper, labelled with the real id.
    const forged = { ...versionEnvelope({ title: "Something the author never signed" }), id: realId };

    await expect(loadConsentVersion(realId, { fetchRecord: async () => forged })).rejects.toMatchObject({
      name: "ConsentVersionError",
      code: "mismatch",
      message: expect.stringContaining("Do not sign anything"),
    });
  });

  it("treats a record that cannot be hashed as one it cannot vouch for", async () => {
    await expect(
      loadConsentVersion(VERSION_CID, { fetchRecord: async () => ({ type: "paper.version" }) }),
    ).rejects.toMatchObject({ code: "mismatch" });
  });

  it("carries a missing version to the caller as the server's 404", async () => {
    const server = await serverHolding();
    await expect(loadConsentVersion(VERSION_CID, { fetchRecord: server.fetchRecord })).rejects.toBeInstanceOf(ApiError);
  });

  it("shows the version without files when the manifest is missing or does not check out", async () => {
    const core = await import("../verify-core");
    const manifest = manifestEnvelope();
    const manifestId = core.computeRecordId(manifest);
    const named = versionEnvelope({ manifest: manifestId });
    const namedId = core.computeRecordId(named);

    // Manifest absent.
    const absent = await serverHolding(named);
    expect((await loadConsentVersion(namedId, { fetchRecord: absent.fetchRecord })).files).toBeNull();

    // Manifest swapped for another file list under the real id.
    const swapped = vi.fn(async (cid: string) =>
      cid === namedId ? { ...named, id: namedId } : { ...manifestEnvelope([{ path: "evil.exe" }]), id: manifestId },
    );
    const loaded = await loadConsentVersion(namedId, { fetchRecord: swapped });
    expect(loaded.title).toBe("Sparse Probing of Reward Models");
    expect(loaded.files).toBeNull();
  });

  it("does not ask for a manifest the version does not name", async () => {
    const core = await import("../verify-core");
    // A real record cannot hold `undefined` (DAG-CBOR refuses it), so the key is left out.
    const bare = versionEnvelope();
    delete (bare.body as Record<string, unknown>).manifest;
    const bareId = core.computeRecordId(bare);
    const server = await serverHolding(bare);
    const loaded = await loadConsentVersion(bareId, { fetchRecord: server.fetchRecord });
    expect(loaded.files).toBeNull();
    expect(server.fetchRecord).toHaveBeenCalledTimes(1);
  });

  it("stops quietly when the page has moved on while the manifest was loading", async () => {
    const controller = new AbortController();
    const recordId = vi.fn(async (envelope: unknown) => (envelope as { id: string }).id);
    const fetchRecord = vi.fn(async (cid: string) => {
      if (cid === VERSION_CID) {
        return { ...versionEnvelope(), id: VERSION_CID };
      }
      controller.abort();
      throw new Error("aborted");
    });
    await expect(
      loadConsentVersion(VERSION_CID, { fetchRecord, recordId, signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});

describe("versionErrorMessage", () => {
  it("says what happened in words", () => {
    expect(versionErrorMessage(new ConsentVersionError("mismatch", "Do not sign."))).toBe("Do not sign.");
    expect(versionErrorMessage(new ApiError(404, { status: 404 }))).toMatch(/no paper version for this link/);
    expect(versionErrorMessage(new NetworkError("http://x"))).toMatch(/Could not reach the server/);
    expect(versionErrorMessage(new Error("boom"))).toMatch(/Could not load this version/);
  });
});

describe("urls and dates", () => {
  it("points at the API origin, with the id encoded", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.scholium.test/");
    expect(fileUrl(PDF)).toBe(`https://api.scholium.test/v1/content/${PDF}`);
    expect(recordUrl("a/b")).toBe("https://api.scholium.test/v1/records/a%2Fb");
  });

  it("writes the signing date in UTC, or nothing for a date that is not one", () => {
    expect(formatSigned("2026-11-14T23:59:00Z")).toBe("14 Nov 2026");
    expect(formatSigned("not a date")).toBeNull();
    expect(formatSigned(null)).toBeNull();
  });
});

describe("consentGate", () => {
  const v = version();
  const waiting = report("awaiting_consent", [[A, "signed"], [B, "waiting"], [C, "waiting"]]);

  it("waits for the device's key store and the report before offering anything", () => {
    expect(consentGate({ device: { phase: "checking", did: null }, version: v, report: waiting })).toEqual({ kind: "checking" });
    expect(consentGate({ device: READY(B), version: v, report: null })).toEqual({ kind: "checking" });
  });

  it("says when the report could not be read, rather than guessing", () => {
    expect(consentGate({ device: READY(B), version: v, report: null, reportFailed: true })).toEqual({ kind: "unavailable" });
  });

  it("sends a device with no key to sign in", () => {
    expect(consentGate({ device: READY(null), version: v, report: waiting })).toEqual({ kind: "no-key" });
  });

  it("does not offer buttons to a key the version does not list", () => {
    const stranger = "did:key:z6MkstrangerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    expect(consentGate({ device: READY(stranger), version: v, report: waiting })).toEqual({ kind: "not-listed", did: stranger });
  });

  it("offers accept and decline to a listed author who has not answered while the version waits", () => {
    const gate = consentGate({ device: READY(B), version: v, report: waiting });
    expect(gate).toMatchObject({ kind: "open", author: { did: B, position: 2 } });
  });

  it("treats a listed author the report does not mention as waiting", () => {
    const gate = consentGate({ device: READY(C), version: v, report: report("awaiting_consent", [[A, "signed"]]) });
    expect(gate.kind).toBe("open");
  });

  it("shows an answer already given and never offers a second one", () => {
    expect(consentGate({ device: READY(A), version: v, report: waiting })).toEqual({
      kind: "decided",
      author: expect.objectContaining({ did: A }),
      decision: "accept",
      consentCid: "bafyreiconsent0",
    });
    const declined = report("draft", [[A, "signed"], [B, "declined"], [C, "waiting"]], { declinedBy: B });
    expect(consentGate({ device: READY(B), version: v, report: declined })).toMatchObject({ kind: "decided", decision: "decline" });
  });

  it("closes the page to an author who was still waiting when the version left the consent step", () => {
    const draft = report("draft", [[A, "signed"], [B, "declined"], [C, "waiting"]], { declinedBy: B });
    expect(consentGate({ device: READY(C), version: v, report: draft })).toEqual({ kind: "closed", state: "draft", declinedBy: B });
    const scanning = report("scanning", [[A, "signed"], [B, "signed"], [C, "waiting"]]);
    expect(consentGate({ device: READY(C), version: v, report: scanning })).toMatchObject({ kind: "closed", state: "scanning", declinedBy: null });
  });
});

describe("closedMessage", () => {
  const v = version();

  it("names who declined, by name when the version gives one", () => {
    expect(closedMessage({ kind: "closed", state: "draft", declinedBy: B }, v)).toMatch(/^Rafael Silva declined authorship, so this version is back in draft/);
    expect(closedMessage({ kind: "closed", state: "draft", declinedBy: C }, v)).toMatch(
      new RegExp(`^${shortDid(C)} declined authorship`),
    );
    expect(closedMessage({ kind: "closed", state: "draft", declinedBy: null }, v)).toMatch(/^This version is back in draft/);
  });

  it("says a version past consent has nothing left to sign", () => {
    for (const state of ["scanning", "moderation", "listed", "held", "rejected", "something_else"]) {
      expect(closedMessage({ kind: "closed", state, declinedBy: null }, v)).toMatch(/nothing (left )?to sign/);
    }
  });
});

describe("consentTrackerEntries", () => {
  it("shows everyone as waiting, with names and roles, before the report arrives", () => {
    const entries = consentTrackerEntries(version(), null, B);
    expect(entries.map((e) => [e.name, e.status, e.isYou, e.roles])).toEqual([
      ["Mei Chen", "waiting", false, ["Conceptualization"]],
      ["Rafael Silva", "waiting", true, ["Software", "Validation"]],
      [shortDid(C), "waiting", false, []],
    ]);
  });

  it("takes status and byline order from the report and names from the signed version", () => {
    const entries = consentTrackerEntries(
      version(),
      report("awaiting_consent", [[C, "waiting"], [B, "declined"], [A, "signed"]]),
      null,
    );
    expect(entries.map((e) => [e.key, e.status])).toEqual([[C, "waiting"], [B, "declined"], [A, "signed"]]);
    expect(entries[1]).toMatchObject({ name: "Rafael Silva", monogram: "RS", detail: expect.stringMatching(/^did:key:z6Mk/) });
    // An author with no name is shown by their DID once, with no avatar letters.
    expect(entries[0]).toMatchObject({ monogram: null, detail: null });
    expect(entries.every((e) => !e.isYou)).toBe(true);
  });

  it("falls back to the report's roles for an author the version does not describe", () => {
    const stranger = "did:key:z6MkunlistedXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const r = report("awaiting_consent", [[stranger, "signed"]]);
    r.authors[0].role = "Supervision";
    expect(consentTrackerEntries(version(), r, null)[0].roles).toEqual(["Supervision"]);
  });
});

describe("the consent record", () => {
  it("names every role the author was listed with, in the order listed", () => {
    expect(consentRole(author(B, { creditRoles: ["Software", "Validation"] }))).toBe("Software, Validation");
    expect(consentRole(author(A, { creditRoles: ["Conceptualization"] }))).toBe("Conceptualization");
  });

  it("falls back to Author for an author listed with no role", () => {
    expect(consentRole(author(C))).toBe("Author");
  });

  it("signs the version id under `version`, the key verifiers read", () => {
    expect(consentBody(version(), author(B, { creditRoles: ["Software"] }), "accept")).toEqual({
      version: VERSION_CID,
      role: "Software",
      decision: "accept",
    });
  });

  it("includes a trimmed, bounded comment and leaves a blank one out", () => {
    const body = consentBody(version(), author(B), "decline", `  not my work  `);
    expect(body).toMatchObject({ decision: "decline", comment: "not my work" });
    expect(consentBody(version(), author(B), "accept", "   ")).not.toHaveProperty("comment");
    const long = consentBody(version(), author(B), "accept", "x".repeat(CONSENT_COMMENT_MAX + 50));
    expect((long.comment as string).length).toBe(CONSENT_COMMENT_MAX);
  });
});

describe("submitConsent", () => {
  function signedAs(did: string, id = "bafyreiconsentnew") {
    return vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null): Promise<SignedRecord> => ({
      v: 1,
      type,
      id,
      author: did,
      created: "2026-11-16T10:00:00Z",
      prev,
      body,
      proofs: [],
      sig: "c2ln",
    }));
  }

  it("signs a coauthor.consent as a record of its own (prev null) and submits it", async () => {
    const sign = signedAs(B);
    const submit = vi.fn(async (_record: SignedRecord) => ({ id: "bafyreiconsentnew", state: "accepted" }));
    const roster = version().authors;

    const done = await submitConsent({
      version: version(),
      author: roster.find((a) => a.did === B)!,
      decision: "accept",
      comment: "Happy to be listed.",
      sign,
      submit,
    });

    expect(sign).toHaveBeenCalledWith(
      "coauthor.consent",
      { version: VERSION_CID, role: "Software, Validation", decision: "accept", comment: "Happy to be listed." },
      null,
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({ type: "coauthor.consent", author: B });
    expect(done).toEqual({ id: "bafyreiconsentnew", decision: "accept" });
  });

  it("reports the id the server gave, falling back to the one it signed", async () => {
    const roster = version().authors;
    const base = { version: version(), author: roster[0], decision: "decline" as const, sign: signedAs(A, "signed-id") };
    expect(await submitConsent({ ...base, submit: async () => ({ id: "server-id" }) })).toMatchObject({ id: "server-id" });
    expect(await submitConsent({ ...base, submit: async () => ({}) })).toMatchObject({ id: "signed-id" });
  });

  it("sends nothing when the key that signed is not the author the page is signing for", async () => {
    const submit = vi.fn();
    await expect(
      submitConsent({ version: version(), author: version().authors[1], decision: "accept", sign: signedAs(A), submit }),
    ).rejects.toBeInstanceOf(WrongSignerError);
    expect(submit).not.toHaveBeenCalled();
  });

  it("lets a cancelled passkey prompt and a refused submission through untouched", async () => {
    const cancelled = new PasskeyCancelledError();
    await expect(
      submitConsent({ version: version(), author: version().authors[0], decision: "accept", sign: async () => { throw cancelled; }, submit: vi.fn() }),
    ).rejects.toBe(cancelled);
    const refused = new ApiError(403, { status: 403 });
    await expect(
      submitConsent({ version: version(), author: version().authors[0], decision: "accept", sign: signedAs(A), submit: async () => { throw refused; } }),
    ).rejects.toBe(refused);
  });
});

describe("describeConsentError", () => {
  it("says a dismissed passkey prompt sent nothing, and does not recheck", () => {
    expect(describeConsentError(new PasskeyCancelledError())).toEqual({
      message: expect.stringMatching(/cancelled, so nothing was sent/),
      signIn: false,
      recheck: false,
    });
  });

  it("explains key problems without exposing codes", () => {
    expect(describeConsentError(new DeviceKeyError("not-found", "x")).message).toMatch(/no signing key/);
    expect(describeConsentError(new DeviceKeyError("passkey-failed", "x")).message).toMatch(/passkey could not be confirmed/);
    expect(describeConsentError(new DeviceKeyError("signing-failed", "x")).message).toMatch(/Nothing was sent/);
    expect(describeConsentError(new RecordSigningError("invalid-record", "x")).message).toMatch(/Nothing was sent/);
    expect(describeConsentError(new WrongSignerError()).message).toMatch(/not the author this consent is for/);
  });

  it("sends an expired session to sign in", () => {
    expect(describeConsentError(new ApiError(401, { status: 401 }))).toMatchObject({ signIn: true, recheck: false });
  });

  it("names a refusal, and rechecks when the outcome is unknown", () => {
    expect(describeConsentError(new ApiError(403, { status: 403 }))).toMatchObject({ message: expect.stringMatching(/not listed as an author/), recheck: false });
    expect(describeConsentError(new ApiError(409, { status: 409 }))).toMatchObject({ recheck: true });
    expect(describeConsentError(new ApiError(422, { status: 422, detail: "decision must be accept or decline" }))).toMatchObject({
      message: "The server did not accept the record: decision must be accept or decline",
      recheck: false,
    });
    expect(describeConsentError(new ApiError(503, { status: 503 }))).toMatchObject({ recheck: true });
    expect(describeConsentError(new NetworkError("http://x"))).toMatchObject({ message: expect.stringMatching(/may not have been recorded/), recheck: true });
    expect(describeConsentError(new Error("boom"))).toMatchObject({ recheck: true });
  });
});
