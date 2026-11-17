import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { DeviceKeyError, PasskeyCancelledError, type SignedRecord } from "../web-auth";
import { parseReviews } from "../paper-reviews/review";
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
  fileChangeCounts,
  filesUnchanged,
  loadNewVersionPaper,
  newVersionBlockers,
  newVersionBody,
  newVersionHref,
  newVersionLoadErrorMessage,
  noFileChanges,
  parseNewVersionRef,
  recordAuthorEntries,
  resultingFiles,
  submitNewVersion,
  submitReviewResponses,
  type ManifestFile,
  type NewVersionPaper,
} from "./new-version";
import type { SubmitFile } from "./upload-manager";

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

/** The caller's dashboard: their own papers, with the latest version whatever its state. */
function dashboardPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    did: A,
    needs_attention: { count: 0, items: [] },
    my_papers: [
      {
        paper: SHORT_ID,
        shortId: SHORT_ID,
        paperCid: GENESIS,
        paper_cid: GENESIS,
        title: "Sparse Probing of Reward Models",
        status: "held",
        categories: ["cs.AI", "cs.LG"],
        latestVersion: 3,
        latest_version: 3,
        latestVersionCid: VERSION_CID,
        latest_version_cid: VERSION_CID,
        state: "held",
      },
    ],
    my_reviews: [],
    ...over,
  };
}

/** No reviews: keeps the loader off the network, which these tests do not exercise. */
const noReviews = () => vi.fn().mockResolvedValue({ reviews: [] });

/** A record id function whose envelopes are already the ones asked for. */
const echoId = async (envelope: unknown): Promise<string> => {
  const id = (envelope as { id?: unknown }).id;
  if (typeof id !== "string") {
    throw new Error("no id");
  }
  return id;
};

/** The catalog answer for a paper with no *listed* version. */
const notListed = () => new ApiError(404, { status: 404, title: "Not Found" });

/** Loads the paper against stub reads; `envelope`/`catalog` default to a consistent pair. */
function load(
  envelope: Record<string, unknown> = versionEnvelope(),
  catalog: Record<string, unknown> = catalogPayload(),
): Promise<NewVersionPaper> {
  return loadNewVersionPaper(SHORT_ID, {
    fetchPaper: vi.fn().mockResolvedValue(catalog),
    fetchRecord: vi.fn().mockResolvedValue(envelope),
    recordId: echoId,
      fetchReviews: noReviews(),
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
      fetchReviews: noReviews(),
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

  it("loads the author's latest version, listed or not, when the catalog lists none", async () => {
    const fetchPaper = vi.fn().mockRejectedValue(notListed());
    const fetchOwnPapers = vi.fn().mockResolvedValue(dashboardPayload());
    const fetchRecord = vi.fn().mockResolvedValue(versionEnvelope());

    const paper = await loadNewVersionPaper(SHORT_ID, {
      fetchPaper,
      fetchOwnPapers,
      fetchRecord,
      recordId: echoId,
      fetchReviews: noReviews(),
    });

    expect(fetchOwnPapers).toHaveBeenCalledTimes(1);
    expect(fetchRecord).toHaveBeenCalledWith(VERSION_CID, undefined);
    expect(paper).toMatchObject({
      shortId: SHORT_ID,
      paperCid: GENESIS,
      versionCid: VERSION_CID,
      n: 3,
      title: "Sparse Probing of Reward Models",
      categories: ["cs.AI", "cs.LG"],
      manifest: MANIFEST_CID,
    });
  });

  it("keeps the not-available answer when the paper is not one of the caller's", async () => {
    const fetchPaper = vi.fn().mockRejectedValue(notListed());
    const fetchOwnPapers = vi.fn().mockResolvedValue(dashboardPayload({ my_papers: [] }));
    const fetchRecord = vi.fn();

    await expect(
      loadNewVersionPaper(SHORT_ID, { fetchPaper, fetchOwnPapers, fetchRecord, recordId: echoId, fetchReviews: noReviews() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchRecord).not.toHaveBeenCalled();
  });

  it("does not consult the caller's own papers when the catalog lists the paper", async () => {
    const fetchOwnPapers = vi.fn().mockResolvedValue(dashboardPayload());
    const paper = await loadNewVersionPaper(SHORT_ID, {
      fetchPaper: vi.fn().mockResolvedValue(catalogPayload()),
      fetchOwnPapers,
      fetchRecord: vi.fn().mockResolvedValue(versionEnvelope()),
      recordId: echoId,
      fetchReviews: noReviews(),
    });

    expect(paper.versionCid).toBe(VERSION_CID);
    expect(fetchOwnPapers).not.toHaveBeenCalled();
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

/* -------------------------------------------------------------------------- */
/* New files and the response to reviewers (PUB-6, REV-5)                      */
/* -------------------------------------------------------------------------- */

const PDF_CID = "bafkreipdfone7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const CODE_CID = "bafkreicode7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const PDF2_CID = "bafkreipdftwo7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const TEX_CID = "bafkreitex7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const NEW_MANIFEST_CID = "bafyreinewmanifest0000000000000000000000000000000";
const REVIEW_A = "bafyreireviewa7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const REVIEW_B = "bafyreireviewb7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";

const PREVIOUS_FILES: ManifestFile[] = [
  { path: "paper.pdf", cid: PDF_CID, size: 482113, mediaType: "application/pdf", role: "manuscript" },
  { path: "code/run.py", cid: CODE_CID, size: 1204, mediaType: "text/x-python", role: "code" },
];

function uploaded(path: string, cid: string, size: number, role: SubmitFile["role"]): SubmitFile {
  return { id: `f-${path}`, path, size, mediaType: role === "pdf" ? "application/pdf" : "application/x-tex", role, cid };
}

function manifestEnvelope(files: unknown = PREVIOUS_FILES): Record<string, unknown> {
  return {
    v: 1,
    type: "manifest",
    id: MANIFEST_CID,
    author: A,
    created: "2026-11-10T05:30:00Z",
    prev: null,
    body: { files },
    proofs: [],
  };
}

/** The reviews listing as `GET /v1/papers/{id}/reviews` serves it: version 3, two revealed, one sealed, one older. */
function reviewsPayload(): Record<string, unknown> {
  return {
    paper: SHORT_ID,
    version: 3,
    gate_open: true,
    reviews: [
      {
        review_cid: REVIEW_A,
        label: "Reviewer A",
        recommendation: "minor_revisions",
        revealed_at: "2026-11-12T00:00:00",
        formal_cid: "bafyreiformala",
        version: 3,
        report: "The proof of Lemma 2 skips a step.",
        scores: {},
        responses: [],
      },
      {
        review_cid: REVIEW_B,
        label: "Reviewer B",
        recommendation: "accept",
        revealed_at: "2026-11-13T00:00:00",
        formal_cid: "bafyreiformalb",
        version: 3,
        scores: {},
        responses: [],
      },
      // Committed, not revealed yet: nothing to answer.
      { review_cid: "bafyreisealed", label: "Reviewer C", recommendation: null, version: 3, scores: {} },
      // A reviewer who stands on an earlier version of the paper.
      {
        review_cid: "bafyreiolder",
        label: "Reviewer D",
        recommendation: "accept",
        revealed_at: "2026-10-01T00:00:00",
        formal_cid: "bafyreiformald",
        version: 2,
        scores: {},
      },
    ],
  };
}

interface LoadOptions {
  manifest?: Record<string, unknown> | "error";
  reviews?: unknown | "error";
}

/** Loads the paper with the manifest record and the reviews listing stubbed by what they are asked. */
function loadWith(options: LoadOptions = {}): Promise<NewVersionPaper> {
  const fetchRecord = vi.fn(async (cid: string) => {
    if (cid === MANIFEST_CID) {
      if (options.manifest === "error") {
        throw new ApiError(404, { status: 404, title: "Not Found" });
      }
      return options.manifest ?? manifestEnvelope();
    }
    return versionEnvelope();
  });
  const fetchReviews = vi.fn(async () => {
    if (options.reviews === "error") {
      throw new ApiError(404, { status: 404, title: "Not Found" });
    }
    return options.reviews ?? reviewsPayload();
  });
  return loadNewVersionPaper(SHORT_ID, {
    fetchPaper: vi.fn().mockResolvedValue(catalogPayload()),
    fetchRecord,
    fetchReviews,
    recordId: echoId,
  });
}

describe("loadNewVersionPaper — the previous version's files", () => {
  it("reads the manifest record the version names, checked against its id", async () => {
    const paper = await loadWith();
    expect(paper.files).toEqual(PREVIOUS_FILES);
  });

  it("does not trust a manifest whose id is not the one the version names: the files are unknown", async () => {
    const forged = { ...manifestEnvelope(), id: "bafyreiforged7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm" };
    expect((await loadWith({ manifest: forged })).files).toBeNull();
  });

  it("leaves the files unknown rather than failing the form when the manifest cannot be read", async () => {
    const paper = await loadWith({ manifest: "error" });
    expect(paper.files).toBeNull();
    expect(paper.manifest).toBe(MANIFEST_CID);
  });

  it("leaves the files unknown when the record is not a manifest", async () => {
    expect((await loadWith({ manifest: { ...manifestEnvelope(), type: "paper.version" } })).files).toBeNull();
    expect((await loadWith({ manifest: manifestEnvelope([{ path: "paper.pdf" }]) })).files).toBeNull();
  });
});

describe("loadNewVersionPaper — the reviews to answer", () => {
  it("lists each revealed review of the previous version, by label", async () => {
    const paper = await loadWith();
    expect(paper.reviews.map((review) => [review.cid, review.label])).toEqual([
      [REVIEW_A, "Reviewer A"],
      [REVIEW_B, "Reviewer B"],
    ]);
    expect(paper.reviews[0].recommendation).toBe("Minor revisions");
    expect(paper.reviews[0].report).toBe("The proof of Lemma 2 skips a step.");
  });

  it("skips a review that is still sealed and one written against an earlier version", async () => {
    const paper = await loadWith();
    expect(paper.reviews.map((review) => review.cid)).not.toContain("bafyreisealed");
    expect(paper.reviews.map((review) => review.cid)).not.toContain("bafyreiolder");
  });

  it("has no reviews to answer when the listing is unavailable", async () => {
    expect((await loadWith({ reviews: "error" })).reviews).toEqual([]);
  });
});

describe("resultingFiles", () => {
  it("keeps every previous file by default", () => {
    expect(resultingFiles(PREVIOUS_FILES, noFileChanges())).toEqual(PREVIOUS_FILES);
    expect(filesUnchanged(PREVIOUS_FILES, resultingFiles(PREVIOUS_FILES, noFileChanges()))).toBe(true);
  });

  it("drops a removed file", () => {
    const result = resultingFiles(PREVIOUS_FILES, { ...noFileChanges(), removed: ["code/run.py"] });
    expect(result.map((file) => file.path)).toEqual(["paper.pdf"]);
  });

  it("replaces a file in place when an upload has its path, naming the new bytes", () => {
    const result = resultingFiles(PREVIOUS_FILES, {
      ...noFileChanges(),
      added: [uploaded("paper.pdf", PDF2_CID, 530004, "pdf")],
    });
    expect(result.map((file) => [file.path, file.cid, file.size])).toEqual([
      ["paper.pdf", PDF2_CID, 530004],
      ["code/run.py", CODE_CID, 1204],
    ]);
    expect(result[0]).toMatchObject({ role: "manuscript", mediaType: "application/pdf" });
    expect(filesUnchanged(PREVIOUS_FILES, result)).toBe(false);
  });

  it("adds a new path after the kept files, with the manifest's spelling of its role", () => {
    const result = resultingFiles(PREVIOUS_FILES, {
      ...noFileChanges(),
      added: [uploaded("paper.tex", TEX_CID, 9120, "source")],
    });
    expect(result[2]).toEqual({
      path: "paper.tex",
      cid: TEX_CID,
      size: 9120,
      mediaType: "application/x-tex",
      role: "source",
    });
  });

  it("calls a re-upload of the very same bytes under the same path no change", () => {
    const result = resultingFiles(PREVIOUS_FILES, {
      ...noFileChanges(),
      added: [uploaded("paper.pdf", PDF_CID, 482113, "pdf")],
    });
    expect(filesUnchanged(PREVIOUS_FILES, result)).toBe(true);
  });

  it("gives a file with no media type the generic one, because the manifest must name one", () => {
    const file = { ...uploaded("data.bin", TEX_CID, 5, "data"), mediaType: "" };
    const [added] = resultingFiles([], { ...noFileChanges(), added: [file] });
    expect(added).toMatchObject({ mediaType: "application/octet-stream", role: "dataset" });
  });
});

describe("fileChangeCounts", () => {
  it("counts what was kept, replaced, added and removed against the previous files", () => {
    const result = resultingFiles(PREVIOUS_FILES, {
      removed: ["code/run.py"],
      added: [uploaded("paper.pdf", PDF2_CID, 530004, "pdf"), uploaded("paper.tex", TEX_CID, 9120, "source")],
    });
    expect(fileChangeCounts(PREVIOUS_FILES, result)).toEqual({
      kept: 0,
      replaced: 1,
      added: 1,
      removed: 1,
      unchanged: false,
    });
  });

  it("says unchanged when every file was kept", () => {
    expect(fileChangeCounts(PREVIOUS_FILES, PREVIOUS_FILES)).toEqual({
      kept: 2,
      replaced: 0,
      added: 0,
      removed: 0,
      unchanged: true,
    });
  });
});

describe("newVersionBlockers — files and responses", () => {
  it("is not blocked by files that were left alone, even if the old version had no paper file", async () => {
    const paper = await loadWith({ manifest: manifestEnvelope([{ ...PREVIOUS_FILES[1] }]) });
    const draft = { ...draftFromPaper(paper), changeNote: "Adds the appendix." };
    expect(newVersionBlockers(draft)).toEqual([]);
  });

  it("will not sign a version whose changed files no longer hold the paper", async () => {
    const paper = await loadWith();
    const draft = {
      ...draftFromPaper(paper),
      changeNote: "Drops the paper.",
      files: { ...draftFromPaper(paper).files!, removed: ["paper.pdf"] },
    };
    expect(newVersionBlockers(draft)).toEqual(["Keep or add your paper as a PDF or LaTeX source."]);
  });

  it("waits for an upload that is still running", async () => {
    const paper = await loadWith();
    const draft = {
      ...draftFromPaper(paper),
      changeNote: "Adds the appendix.",
      files: { ...draftFromPaper(paper).files!, pending: "Wait for the uploads and fingerprints to finish." },
    };
    expect(newVersionBlockers(draft)).toEqual(["Wait for the uploads and fingerprints to finish."]);
  });
});

describe("newVersionBody — the manifest", () => {
  it("names the manifest it is given instead of the previous version's", async () => {
    const paper = await load();
    const draft = { ...draftFromPaper(paper), changeNote: "Replaces the PDF." };
    const body = newVersionBody(paper, draft, paper.authors, NEW_MANIFEST_CID);
    expect(body.manifest).toBe(NEW_MANIFEST_CID);
  });
});

/** A signer that answers with the type it was asked for and an id of its own per record. */
function signerOf(did = A) {
  let count = 0;
  return vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null): Promise<SignedRecord> => {
    count += 1;
    const ids: Record<string, string> = {
      manifest: NEW_MANIFEST_CID,
      "paper.version": NEW_VERSION_CID,
      "review.response": `bafyreiresponse${count}`,
    };
    return {
      v: 1,
      type,
      id: ids[type] ?? `bafyreiother${count}`,
      author: did,
      created: "2026-11-16T10:00:00Z",
      prev,
      body,
      proofs: [],
      sig: "c2ln",
    };
  });
}

describe("submitNewVersion — new files", () => {
  it("signs a manifest of the kept and new files first, then a version that names it", async () => {
    const paper = await loadWith();
    const base = draftFromPaper(paper);
    const draft = {
      ...base,
      changeNote: "Replaces the PDF and adds the source.",
      files: {
        ...base.files!,
        added: [uploaded("paper.pdf", PDF2_CID, 530004, "pdf"), uploaded("paper.tex", TEX_CID, 9120, "source")],
      },
    };
    const sign = signerOf();
    const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id, state: "accepted" }));

    const result = await submitNewVersion({ paper, draft, sign, submit });

    expect(sign.mock.calls.map((call) => call[0])).toEqual(["manifest", "paper.version"]);
    const [, manifestBody, manifestPrev] = sign.mock.calls[0];
    expect(manifestPrev).toBeNull();
    expect(manifestBody).toEqual({
      files: [
        { path: "paper.pdf", cid: PDF2_CID, size: 530004, mediaType: "application/pdf", role: "manuscript" },
        { path: "code/run.py", cid: CODE_CID, size: 1204, mediaType: "text/x-python", role: "code" },
        { path: "paper.tex", cid: TEX_CID, size: 9120, mediaType: "application/x-tex", role: "source" },
      ],
    });
    // The manifest is on the node before the version that names it.
    expect(submit.mock.calls.map((call) => (call[0] as SignedRecord).type)).toEqual(["manifest", "paper.version"]);
    const [, versionBody, versionPrev] = sign.mock.calls[1];
    expect(versionBody).toMatchObject({ n: 4, manifest: NEW_MANIFEST_CID });
    expect(versionPrev).toBe(VERSION_CID);
    expect(result).toMatchObject({ versionId: NEW_VERSION_CID, n: 4, manifestId: NEW_MANIFEST_CID });
  });

  it("signs no manifest when the files were left alone: the version names the previous one", async () => {
    const paper = await loadWith();
    const draft = { ...draftFromPaper(paper), changeNote: "Fixes a typo." };
    const sign = signerOf();
    const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id }));

    await submitNewVersion({ paper, draft, sign, submit });

    expect(sign.mock.calls.map((call) => call[0])).toEqual(["paper.version"]);
    expect(sign.mock.calls[0][1]).toMatchObject({ manifest: MANIFEST_CID });
  });

  it("sends nothing if the manifest cannot be signed", async () => {
    const paper = await loadWith();
    const base = draftFromPaper(paper);
    const draft = {
      ...base,
      changeNote: "Adds the source.",
      files: { ...base.files!, added: [uploaded("paper.tex", TEX_CID, 9120, "source")] },
    };
    const sign = vi.fn().mockRejectedValue(new PasskeyCancelledError());
    const submit = vi.fn();
    await expect(submitNewVersion({ paper, draft, sign, submit })).rejects.toBeInstanceOf(PasskeyCancelledError);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("submitNewVersion — the response to reviewers", () => {
  const answered = async (responses: Record<string, string>) => {
    const paper = await loadWith();
    return { paper, draft: { ...draftFromPaper(paper), changeNote: "Answers the reviewers.", responses } };
  };

  it("posts one review.response per answered review, after the version, each naming its review", async () => {
    const { paper, draft } = await answered({
      [REVIEW_A]: "  We added the missing step in Lemma 2.  ",
      [REVIEW_B]: "Thank you.",
    });
    const sign = signerOf();
    const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id }));
    const respond = vi.fn(async (_cid: string, record: SignedRecord) => ({ id: record.id }));

    const result = await submitNewVersion({ paper, draft, sign, submit, respond });

    expect(sign.mock.calls.map((call) => call[0])).toEqual(["paper.version", "review.response", "review.response"]);
    const [, body, prev] = sign.mock.calls[1];
    expect(prev).toBeNull();
    expect(body).toEqual({
      review: REVIEW_A,
      items: [{ dimension: "general", reply: "We added the missing step in Lemma 2." }],
    });
    expect(respond.mock.calls.map((call) => call[0])).toEqual([REVIEW_A, REVIEW_B]);
    expect(result.responses).toEqual([
      { reviewCid: REVIEW_A, ok: true },
      { reviewCid: REVIEW_B, ok: true },
    ]);
    // The records of a version are not the reviews' responses.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("posts nothing for a review whose box was left empty", async () => {
    const { paper, draft } = await answered({ [REVIEW_A]: "   ", [REVIEW_B]: "Thank you." });
    const respond = vi.fn(async (_cid: string, record: SignedRecord) => ({ id: record.id }));
    const result = await submitNewVersion({
      paper,
      draft,
      sign: signerOf(),
      submit: vi.fn(async (record: SignedRecord) => ({ id: record.id })),
      respond,
    });
    expect(respond.mock.calls.map((call) => call[0])).toEqual([REVIEW_B]);
    expect(result.responses).toEqual([{ reviewCid: REVIEW_B, ok: true }]);
  });

  it("leaves `responses` out of the result when there was nothing to post", async () => {
    const { paper, draft } = await answered({});
    const result = await submitNewVersion({
      paper,
      draft,
      sign: signerOf(),
      submit: vi.fn(async (record: SignedRecord) => ({ id: record.id })),
      respond: vi.fn(),
    });
    expect(result.responses).toBeUndefined();
  });

  it("does not answer reviews of a version that was refused: nothing the author said is published", async () => {
    const { paper, draft } = await answered({ [REVIEW_A]: "Thank you." });
    const sign = signerOf();
    const submit = vi.fn().mockRejectedValue(
      new ApiError(409, { status: 409, type: VERSION_OUT_OF_SEQUENCE_TYPE, title: "Version out of sequence" }),
    );
    const respond = vi.fn();
    await expect(submitNewVersion({ paper, draft, sign, submit, respond })).rejects.toBeInstanceOf(ApiError);
    expect(respond).not.toHaveBeenCalled();
    expect(sign.mock.calls.map((call) => call[0])).toEqual(["paper.version"]);
  });

  it("keeps the version when one response is refused, and says which one", async () => {
    const { paper, draft } = await answered({ [REVIEW_A]: "Thank you.", [REVIEW_B]: "Thanks too." });
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(403, { status: 403, title: "Forbidden" }))
      .mockResolvedValueOnce({ id: "x" });
    const result = await submitNewVersion({
      paper,
      draft,
      sign: signerOf(),
      submit: vi.fn(async (record: SignedRecord) => ({ id: record.id })),
      respond,
    });
    expect(result.versionId).toBe(NEW_VERSION_CID);
    expect(result.responses?.[0]).toMatchObject({ reviewCid: REVIEW_A, ok: false });
    expect(result.responses?.[0].error).toContain("may not answer");
    expect(result.responses?.[1]).toEqual({ reviewCid: REVIEW_B, ok: true });
  });

  it("can post just the responses that failed, later", async () => {
    const sign = signerOf();
    const respond = vi.fn(async (_cid: string, record: SignedRecord) => ({ id: record.id }));
    const outcomes = await submitReviewResponses({ responses: { [REVIEW_A]: "Thank you." }, sign, respond });
    expect(outcomes).toEqual([{ reviewCid: REVIEW_A, ok: true }]);
    expect(sign).toHaveBeenCalledWith("review.response", expect.objectContaining({ review: REVIEW_A }), null);
  });

  it("stops asking for passkeys once the author dismisses one, and reports the rest as not posted", async () => {
    const sign = vi.fn().mockRejectedValue(new PasskeyCancelledError());
    const respond = vi.fn();
    const outcomes = await submitReviewResponses({
      responses: { [REVIEW_A]: "One.", [REVIEW_B]: "Two." },
      sign,
      respond,
    });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
    expect(outcomes.map((outcome) => [outcome.reviewCid, outcome.ok])).toEqual([
      [REVIEW_A, false],
      [REVIEW_B, false],
    ]);
  });
});

describe("the response as the reviews tab reads it", () => {
  it("is keyed by the `general` dimension, which the tab reads as a reply under the review", () => {
    // The API stores a response as `{dimension: reply}` and the listing serves
    // that map under the review's `replies`; the tab turns each key into an
    // item. (The listing's `responses` entries are parsed wrongly by
    // paper-reviews/review.ts — outside this task's files, reported to the
    // operator — so this pins only the key this form signs.)
    const listing = parseReviews({
      reviews: [
        {
          review_cid: REVIEW_A,
          label: "Reviewer A",
          recommendation: "minor_revisions",
          replies: { general: "We added the missing step." },
        },
      ],
    });
    expect(listing.reviews[0].replies).toHaveLength(1);
    expect(listing.reviews[0].replies[0].items).toEqual([
      { dimension: "general", label: "General", text: "We added the missing step." },
    ]);
  });
});
