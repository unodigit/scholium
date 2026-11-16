import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError, type SignedRecord } from "../web-auth";
import type { RecordAuthor } from "./authors";
import {
  CHANGE_NOTE_MAX,
  NEW_VERSION_RECORD_TYPE,
  VERSION_OUT_OF_SEQUENCE_TYPE,
  NewVersionPaperError,
  WrongRecordError,
  bylineAsDraft,
  canSignNewVersion,
  describeNewVersionError,
  draftFromPaper,
  loadNewVersionPaper,
  newVersionBlockers,
  newVersionBody,
  newVersionHref,
  newVersionLoadErrorMessage,
  parseNewVersionRef,
  recordAuthorEntries,
  submitNewVersion,
  type NewVersionPaper,
} from "./new-version";

const A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const SHORT_ID = "sch:abcd-efgh-ijkl";
const GENESIS = "bafyreigenesis7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const VERSION_CID = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const MANIFEST_CID = "bafyreimanifest7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";

/** The envelope of the paper's latest version, as `GET /v1/records/{cid}` sends it. */
function versionEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    type: "paper.version",
    id: VERSION_CID,
    author: A,
    created: "2026-11-10T05:33:00Z",
    prev: "bafyreioldest7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm",
    body: {
      paper: GENESIS,
      n: 3,
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models for the features they use.",
      authors: [
        { did: B, position: 2, name: "Rafael Silva", creditRoles: ["Software", "Validation"] },
        { did: A, position: 1, name: "Mei Chen", creditRoles: ["Conceptualization"] },
      ],
      manifest: MANIFEST_CID,
      licence: "CC-BY-4.0",
      changeNote: "Fixed the proof of Lemma 2.",
      categories: ["cs.AI", "cs.LG"],
    },
    proofs: [],
    ...over,
  };
}

/** The catalog's answer for `GET /v1/papers/{id}`: the latest listed version. */
function catalogPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper: SHORT_ID,
    shortId: SHORT_ID,
    paperCid: GENESIS,
    versionCid: VERSION_CID,
    cid: VERSION_CID,
    n: 3,
    version: 3,
    title: "Sparse Probing of Reward Models",
    abstract: "We probe reward models for the features they use.",
    authors: [
      { did: A, position: 1, creditRoles: ["Conceptualization"] },
      { did: B, position: 2, creditRoles: ["Software", "Validation"] },
    ],
    categories: ["cs.AI", "cs.LG"],
    licence: "CC-BY-4.0",
    status: "preprint",
    notices: [],
    ...over,
  };
}

/** A record id function whose envelopes are already the ones asked for. */
const echoId = async (envelope: unknown): Promise<string> => {
  const id = (envelope as { id?: unknown }).id;
  if (typeof id !== "string") {
    throw new Error("no id");
  }
  return id;
};

/** Loads the paper against stub reads; `envelope`/`catalog` default to a consistent pair. */
function load(
  envelope: Record<string, unknown> = versionEnvelope(),
  catalog: Record<string, unknown> = catalogPayload(),
): Promise<NewVersionPaper> {
  return loadNewVersionPaper(SHORT_ID, {
    fetchPaper: vi.fn().mockResolvedValue(catalog),
    fetchRecord: vi.fn().mockResolvedValue(envelope),
    recordId: echoId,
  });
}

/* -------------------------------------------------------------------------- */
/* The link                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseNewVersionRef", () => {
  it("reads a sch: id, URL-encoded or not", () => {
    expect(parseNewVersionRef("sch%3Aabcd-efgh-ijkl")).toEqual({ id: SHORT_ID });
    expect(parseNewVersionRef(SHORT_ID)).toEqual({ id: SHORT_ID });
  });

  it("accepts a record cid, and drops a /vN: a new version always extends the latest", () => {
    expect(parseNewVersionRef(GENESIS)).toEqual({ id: GENESIS });
    expect(parseNewVersionRef("sch%3Aabcd-efgh-ijkl%2Fv2")).toEqual({ id: SHORT_ID });
  });

  it("refuses what cannot name a paper, before anything is asked of the server", () => {
    expect("error" in parseNewVersionRef("not a paper")).toBe(true);
    expect("error" in parseNewVersionRef("")).toBe(true);
    expect("error" in parseNewVersionRef("sch%3Aabcd-efgh-ijkl%2Ftwo")).toBe(true);
    expect("error" in parseNewVersionRef(`sch%3Aabcd-efgh-ijkl%2Fv2%2Fextra`)).toBe(true);
  });

  it("links to the form with the id encoded", () => {
    expect(newVersionHref(SHORT_ID)).toBe("/submit/new-version/sch%3Aabcd-efgh-ijkl");
  });
});

/* -------------------------------------------------------------------------- */
/* Loading the paper                                                           */
/* -------------------------------------------------------------------------- */

describe("loadNewVersionPaper", () => {
  it("reads the paper, then the record its latest version signed, checked against its id", async () => {
    const fetchPaper = vi.fn().mockResolvedValue(catalogPayload());
    const fetchRecord = vi.fn().mockResolvedValue(versionEnvelope());
    const paper = await loadNewVersionPaper(SHORT_ID, {
      fetchPaper,
      fetchRecord,
      recordId: echoId,
    });

    expect(fetchPaper).toHaveBeenCalledWith(SHORT_ID, undefined);
    expect(fetchRecord).toHaveBeenCalledWith(VERSION_CID, undefined);
    expect(paper).toMatchObject({
      shortId: SHORT_ID,
      paperCid: GENESIS,
      versionCid: VERSION_CID,
      n: 3,
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models for the features they use.",
      categories: ["cs.AI", "cs.LG"],
      licence: "CC-BY-4.0",
      manifest: MANIFEST_CID,
    });
  });

  it("carries the byline as signed — names and roles — in byline order", async () => {
    const paper = await load();
    expect(paper.authors.map((author) => author.did)).toEqual([A, B]);
    expect(paper.authors[1]).toMatchObject({ name: "Rafael Silva", creditRoles: ["Software", "Validation"] });
  });

  it("refuses a record whose id does not match the version the server listed", async () => {
    const forged = versionEnvelope({ id: "bafyreiforged7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm" });
    await expect(load(forged)).rejects.toBeInstanceOf(NewVersionPaperError);
    await expect(load(forged)).rejects.toMatchObject({ code: "mismatch" });
  });

  it("refuses a record that is not a paper.version", async () => {
    const other = versionEnvelope({ type: "manifest" });
    await expect(load(other)).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a catalog answer that names no latest version", async () => {
    await expect(load(versionEnvelope(), catalogPayload({ versionCid: undefined, cid: undefined }))).rejects.toMatchObject(
      { code: "malformed" },
    );
  });

  it("refuses a version whose paper disagrees with the paper asked for", async () => {
    const stranger = versionEnvelope();
    (stranger.body as Record<string, unknown>).paper = "bafyreistranger7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
    await expect(load(stranger)).rejects.toMatchObject({ code: "mismatch" });
  });

  it("refuses a version with no manifest: the new version could not name its files", async () => {
    const bare = versionEnvelope();
    (bare.body as Record<string, unknown>).manifest = null;
    await expect(load(bare)).rejects.toMatchObject({ code: "no-manifest" });
  });
});

describe("newVersionLoadErrorMessage", () => {
  it("says what a missing paper means in words", () => {
    expect(newVersionLoadErrorMessage(new ApiError(404, { status: 404, title: "Not Found" }))).toContain(
      "no listed version",
    );
    expect(newVersionLoadErrorMessage(new NetworkError("http://api"))).toContain("Could not reach");
  });

  it("passes the module's own sentences through", () => {
    expect(newVersionLoadErrorMessage(new NewVersionPaperError("mismatch", "Do not sign anything for it."))).toBe(
      "Do not sign anything for it.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

describe("draftFromPaper", () => {
  it("pre-fills the details from what the latest version signed", async () => {
    const draft = draftFromPaper(await load());
    expect(draft.details).toEqual({
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models for the features they use.",
      categories: ["cs.AI", "cs.LG"],
      licence: "CC-BY-4.0",
    });
    expect(draft.changeNote).toBe("");
  });

  it("falls back to the default licence only when the version named none", async () => {
    const unlicensed = versionEnvelope();
    (unlicensed.body as Record<string, unknown>).licence = "";
    const draft = draftFromPaper(await load(unlicensed));
    expect(draft.details.licence).toBe("CC-BY-4.0");
  });

  it("pre-selects every category the paper has when the version record names none", async () => {
    // Version records signed before categories travelled in the body still
    // describe a paper the catalog files under its signed genesis categories.
    const older = versionEnvelope();
    delete (older.body as Record<string, unknown>).categories;
    const paper = await load(older, catalogPayload({ categories: ["cs.AI", "cs.LG"] }));

    expect(paper.categories).toEqual(["cs.AI", "cs.LG"]);
    expect(draftFromPaper(paper).details.categories).toEqual(["cs.AI", "cs.LG"]);
    expect(
      canSignNewVersion({ ...draftFromPaper(paper), changeNote: "Adds the appendix." }),
    ).toBe(true);
  });

  it("prefers the categories the version itself signed over the catalog's", async () => {
    const paper = await load(
      versionEnvelope(),
      catalogPayload({ categories: ["cs.CR"] }),
    );
    expect(paper.categories).toEqual(["cs.AI", "cs.LG"]);
  });
});

describe("newVersionBlockers", () => {
  const paper = () => load();

  it("requires a change note", async () => {
    const draft = { ...draftFromPaper(await paper()), changeNote: "" };
    expect(newVersionBlockers(draft)).toEqual(["Say what changed in this version."]);
    expect(canSignNewVersion(draft)).toBe(false);
  });

  it("refuses a change note past its limit", async () => {
    const draft = { ...draftFromPaper(await paper()), changeNote: "x".repeat(CHANGE_NOTE_MAX + 1) };
    expect(newVersionBlockers(draft)).toEqual([
      `Shorten the change note to ${CHANGE_NOTE_MAX} characters or fewer.`,
    ]);
  });

  it("passes a complete draft through", async () => {
    const draft = { ...draftFromPaper(await paper()), changeNote: "Adds the appendix." };
    expect(newVersionBlockers(draft)).toEqual([]);
    expect(canSignNewVersion(draft)).toBe(true);
  });

  it("still names the details a signed version cannot carry", async () => {
    const base = await paper();
    const draft = {
      details: { ...draftFromPaper(base).details, title: "", categories: ["not-a-category"] },
      changeNote: "Adds the appendix.",
    };
    expect(newVersionBlockers(draft)[0]).toBe("Add a title to continue.");
  });
});

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

describe("newVersionBody", () => {
  it("signs the next number of the same paper, with the note and the carried byline and manifest", async () => {
    const paper = await load();
    const draft = { ...draftFromPaper(paper), changeNote: "  Adds the appendix.  " };
    expect(newVersionBody(paper, draft)).toEqual({
      paper: GENESIS,
      n: 4,
      title: "Sparse Probing of Reward Models",
      abstract: "We probe reward models for the features they use.",
      authors: [
        { did: A, name: "Mei Chen", creditRoles: ["Conceptualization"], position: 1 },
        { did: B, name: "Rafael Silva", creditRoles: ["Software", "Validation"], position: 2 },
      ],
      manifest: MANIFEST_CID,
      licence: "CC-BY-4.0",
      changeNote: "Adds the appendix.",
      categories: ["cs.AI", "cs.LG"],
    });
  });

  it("renumbers the carried byline tightly, in byline order", () => {
    const entries = recordAuthorEntries([
      { did: B, position: 7, name: null, orcid: null, creditRoles: [] },
      { did: A, position: 4, name: "Mei Chen", orcid: null, creditRoles: ["Software"] },
    ]) as RecordAuthor[];
    expect(entries.map((author) => [author.did, author.position])).toEqual([
      [A, 1],
      [B, 2],
    ]);
  });
});

describe("bylineAsDraft", () => {
  it("marks the author on this device as the submitter", () => {
    const draft = bylineAsDraft(
      [
        { did: A, position: 1, name: "Mei Chen", orcid: null, creditRoles: ["Conceptualization"] },
        { did: B, position: 2, name: null, orcid: null, creditRoles: [] },
      ],
      B,
    );
    expect(draft.map((author) => author.isSubmitter)).toEqual([false, true]);
  });
});

/* -------------------------------------------------------------------------- */
/* Signing                                                                     */
/* -------------------------------------------------------------------------- */

const NEW_VERSION_CID = "bafyreinewversionrecord0000000000000000000000000000";

function signed(did: string, body: Record<string, unknown>, prev: string | null): SignedRecord {
  return {
    v: 1,
    type: NEW_VERSION_RECORD_TYPE,
    id: NEW_VERSION_CID,
    author: did,
    created: "2026-11-16T10:00:00Z",
    prev,
    body,
    proofs: [],
    sig: "c2ln",
  };
}

describe("submitNewVersion", () => {
  it("signs a paper.version whose prev is the latest version, and submits it", async () => {
    const paper = await load();
    const draft = { ...draftFromPaper(paper), changeNote: "Adds the appendix." };
    const sign = vi.fn(async (_type: string, body: Record<string, unknown>, prev: string | null) =>
      signed(A, body, prev),
    );
    const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id, state: "awaiting_consent" }));

    const result = await submitNewVersion({ paper, draft, sign, submit });

    expect(sign).toHaveBeenCalledWith(NEW_VERSION_RECORD_TYPE, expect.objectContaining({ n: 4 }), VERSION_CID);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0][0] as SignedRecord).prev).toBe(VERSION_CID);
    expect(result).toEqual({ versionId: NEW_VERSION_CID, n: 4 });
  });

  it("refuses to send a record whose prev is not the latest version", async () => {
    const paper = await load();
    const draft = { ...draftFromPaper(paper), changeNote: "Adds the appendix." };
    const sign = vi.fn(async (_type: string, body: Record<string, unknown>, _prev: string | null) =>
      signed(A, body, GENESIS),
    );
    const submit = vi.fn();

    await expect(submitNewVersion({ paper, draft, sign, submit })).rejects.toBeInstanceOf(WrongRecordError);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to send a record of another type", async () => {
    const paper = await load();
    const draft = { ...draftFromPaper(paper), changeNote: "Adds the appendix." };
    const sign = vi.fn(async (_type: string, body: Record<string, unknown>, prev: string | null) => {
      const record = signed(A, body, prev);
      return { ...record, type: "paper.genesis" };
    });
    const submit = vi.fn();

    await expect(submitNewVersion({ paper, draft, sign, submit })).rejects.toBeInstanceOf(WrongRecordError);
    expect(submit).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Failures, in words                                                          */
/* -------------------------------------------------------------------------- */

describe("describeNewVersionError", () => {
  it("names a stale prev in words, and says the fix is to load the paper again", () => {
    const failure = describeNewVersionError(
      new ApiError(409, {
        status: 409,
        type: VERSION_OUT_OF_SEQUENCE_TYPE,
        title: "Version out of sequence",
        detail: "version 4 with prev 'bafyrei…' was expected",
      }),
    );
    expect(failure.staleChain).toBe(true);
    expect(failure.message).toContain("Another version of this paper has landed");
  });

  it("still offers the reload on an untyped 409, quoting the server", () => {
    const failure = describeNewVersionError(
      new ApiError(409, { status: 409, title: "Conflict", detail: "version 4 was expected" }),
    );
    expect(failure.staleChain).toBe(true);
    expect(failure.message).toContain("version 4 was expected");
  });

  it("says a dismissed passkey prompt sent nothing", () => {
    const failure = describeNewVersionError(new PasskeyCancelledError());
    expect(failure.message).toContain("nothing was sent");
  });

  it("says a missing key, an ended session and an unreachable server each in their own words", () => {
    expect(describeNewVersionError(new DeviceKeyError("not-found", "no key")).message).toContain("no signing key");
    const expired = describeNewVersionError(new ApiError(401, { status: 401, title: "Unauthorized" }));
    expect(expired.signIn).toBe(true);
    expect(describeNewVersionError(new NetworkError("http://api")).message).toContain("Could not reach");
  });
});
