// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import { PasskeyCancelledError, type SignedRecord } from "../web-auth";
import { NewVersionPage, type NewVersionPageProps } from "./new-version-page";
import { loadNewVersionPaper, type ManifestFile, type NewVersionPaper } from "./new-version";
import type { ConsentReport } from "./consents";
import type { VersionChecks } from "./checks";
import type { ManagerDeps } from "./upload-manager";

afterEach(cleanup);

const A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const STRANGER = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSRPnE";
const SHORT_ID = "sch:abcd-efgh-ijkl";
const GENESIS = "bafyreigenesis7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const VERSION_CID = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const MANIFEST_CID = "bafyreimanifest7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const NEW_VERSION_CID = "bafyreinewversionrecord0000000000000000000000000000";
const NEW_MANIFEST_CID = "bafyreinewmanifest0000000000000000000000000000000";
const PDF_CID = "bafkreipdfone7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const PDF2_CID = "bafkreipdftwo7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const CODE_CID = "bafkreicode7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const TEX_CID = "bafkreitex7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const REVIEW_A = "bafyreireviewa7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const REVIEW_B = "bafyreireviewb7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";

/** The previous version's files, as its signed manifest lists them. */
const MANIFEST_FILES: ManifestFile[] = [
  { path: "paper.pdf", cid: PDF_CID, size: 482113, mediaType: "application/pdf", role: "manuscript" },
  { path: "code/run.py", cid: CODE_CID, size: 1204, mediaType: "text/x-python", role: "code" },
];

/** Two revealed reviews of version 3, as `GET /v1/papers/{id}/reviews` serves them. */
const REVIEWS_LISTING = {
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
    },
    {
      review_cid: REVIEW_B,
      label: "Reviewer B",
      recommendation: "accept",
      revealed_at: "2026-11-13T00:00:00",
      formal_cid: "bafyreiformalb",
      version: 3,
      scores: {},
    },
  ],
};

/** The paper as the loader hands it to the page: version 3 listed, Mei and Rafael on the byline. */
function paperFixture(over: Partial<NewVersionPaper> = {}): NewVersionPaper {
  return {
    shortId: SHORT_ID,
    paperCid: GENESIS,
    versionCid: VERSION_CID,
    n: 3,
    title: "Sparse Probing of Reward Models",
    abstract: "We probe reward models for the features they use.",
    categories: ["cs.AI", "cs.LG"],
    licence: "CC-BY-4.0",
    authors: [
      { did: A, position: 1, name: "Mei Chen", orcid: null, creditRoles: ["Conceptualization"] },
      { did: B, position: 2, name: "Rafael Silva", orcid: null, creditRoles: ["Software", "Validation"] },
    ],
    manifest: MANIFEST_CID,
    files: null,
    reviews: [],
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

/** Loads the fixture for real: the same pipeline the page uses, with stub reads. */
function loader(
  over: Partial<NewVersionPaper> = {},
  bodyOver: Record<string, unknown> = {},
  options: { unlisted?: boolean; authored?: boolean; files?: ManifestFile[]; reviews?: unknown } = {},
) {
  const paper = paperFixture(over);
  const fetchPaper = options.unlisted
    ? vi.fn().mockRejectedValue(new ApiError(404, { status: 404, title: "Not Found" }))
    : vi.fn().mockResolvedValue({
        paper: paper.shortId,
        shortId: paper.shortId,
        paperCid: paper.paperCid,
        versionCid: paper.versionCid,
        n: paper.n,
        version: paper.n,
        title: paper.title,
        categories: paper.categories,
        authors: [],
      });
  // The dashboard names the caller's latest version whatever state it is in.
  // A caller who did not author the paper has no such row.
  const fetchOwnPapers = vi.fn().mockResolvedValue({
    did: A,
    needs_attention: { count: 0, items: [] },
    my_papers:
      options.authored === false
        ? []
        : [
            {
              paper: paper.shortId,
              shortId: paper.shortId,
              paperCid: paper.paperCid,
              title: paper.title,
              status: "held",
              categories: paper.categories,
              latestVersion: paper.n,
              latestVersionCid: paper.versionCid,
              state: "held",
            },
          ],
    my_reviews: [],
  });
  // Without `files` the manifest record is unreadable, so the files read as unknown.
  const fetchReviews = vi.fn().mockResolvedValue(options.reviews ?? { reviews: [] });
  const fetchVersionRecord = vi.fn().mockResolvedValue({
    v: 1,
    type: "paper.version",
    id: paper.versionCid,
    author: A,
    created: "2026-11-10T05:33:00Z",
    prev: GENESIS,
    body: {
      paper: paper.paperCid,
      n: paper.n,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors,
      manifest: paper.manifest,
      licence: paper.licence,
      changeNote: "Fixed the proof of Lemma 2.",
      categories: paper.categories,
      ...bodyOver,
    },
    proofs: [],
  });
  const fetchRecord = vi.fn(async (cid: string) =>
    cid === paper.manifest && options.files !== undefined
      ? {
          v: 1,
          type: "manifest",
          id: paper.manifest,
          author: A,
          created: "2026-11-10T05:30:00Z",
          prev: null,
          body: { files: options.files },
          proofs: [],
        }
      : fetchVersionRecord(),
  );
  return {
    paper,
    loadPaper: vi.fn((id: string, options?: { signal?: AbortSignal }) =>
      loadNewVersionPaper(id, {
        fetchPaper,
        fetchOwnPapers,
        fetchRecord,
        fetchReviews,
        recordId: echoId,
        signal: options?.signal,
      }),
    ),
  };
}

function consentReport(over: Partial<ConsentReport> = {}): ConsentReport {
  return {
    paper: SHORT_ID,
    version: 4,
    versionCid: NEW_VERSION_CID,
    state: "awaiting_consent",
    count: 2,
    waiting: 2,
    signed: 0,
    declined: 0,
    authors: [
      { did: A, position: 1, status: "waiting", consentCid: null },
      { did: B, position: 2, status: "waiting", consentCid: null },
    ],
    ...over,
  };
}

let signedCount = 0;

function signedRecord(
  did: string,
  body: Record<string, unknown>,
  prev: string | null,
  type = "paper.version",
): SignedRecord {
  signedCount += 1;
  const ids: Record<string, string> = {
    "paper.version": NEW_VERSION_CID,
    manifest: NEW_MANIFEST_CID,
    "review.response": `bafyreiresponse${signedCount}`,
  };
  return {
    v: 1,
    type,
    id: ids[type] ?? NEW_VERSION_CID,
    author: did,
    created: "2026-11-16T10:00:00Z",
    prev,
    body,
    proofs: [],
    sig: "c2ln",
  };
}

interface Harness {
  loadPaper: ReturnType<typeof vi.fn>;
  sign: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  fetchConsents: ReturnType<typeof vi.fn>;
  fetchChecks: ReturnType<typeof vi.fn>;
}

function renderForm(
  props: Partial<NewVersionPageProps> = {},
  paper: Partial<NewVersionPaper> = {},
  recordBody: Record<string, unknown> = {},
  loadOptions: { unlisted?: boolean; authored?: boolean; files?: ManifestFile[]; reviews?: unknown } = {},
): Harness {
  const built = loader(paper, recordBody, loadOptions);
  const sign = vi.fn(async (type: string, body: Record<string, unknown>, prev: string | null) =>
    signedRecord(props.submitterDid ?? A, body, prev, type),
  );
  const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id, state: "awaiting_consent" }));
  const respond = vi.fn(async (_cid: string, record: SignedRecord) => ({ id: record.id }));
  const fetchConsents = vi.fn(async () => consentReport());
  // The node has no report yet: the tracker says "Checks pending".
  const fetchChecks = vi.fn(async (): Promise<VersionChecks> => {
    throw new ApiError(404, { status: 404, title: "Not Found" });
  });
  render(
    <NewVersionPage
      paper={SHORT_ID}
      submitterDid={A}
      signedIn
      pollMs={0}
      loadPaper={built.loadPaper}
      sign={sign}
      submit={submit}
      respond={respond}
      fetchConsents={fetchConsents}
      fetchChecks={fetchChecks}
      checksPollMs={0}
      {...props}
    />,
  );
  return { loadPaper: built.loadPaper, sign, submit, respond, fetchConsents, fetchChecks };
}

/** The Details step's Title field, once the paper has loaded. */
const titleField = () => screen.findByLabelText("Title");

/** Walks to the change note: waits for Details, then continues. */
async function toChangeNote(): Promise<void> {
  await titleField();
  fireEvent.click(await screen.findByRole("button", { name: "Continue to the change note" }));
  await screen.findByLabelText(/change note/i);
}

describe("NewVersionPage — loading the paper", () => {
  it("says it is loading first, and never shows a form it has not checked", () => {
    const loadPaper = vi.fn(() => new Promise<NewVersionPaper>(() => undefined));
    renderForm({ loadPaper });
    expect(loadPaper).toHaveBeenCalledWith(SHORT_ID, expect.anything());
    expect(screen.getByRole("heading", { level: 1, name: "Submit a new version" })).toBeTruthy();
    expect(screen.getByText("Loading the paper…")).toBeTruthy();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("refuses a link that cannot name a paper before asking the server anything", () => {
    const loadPaper = vi.fn();
    render(<NewVersionPage paper="not%20a%20paper" loadPaper={loadPaper} />);
    expect(screen.getByRole("alert").textContent).toContain("does not name a paper");
    expect(loadPaper).not.toHaveBeenCalled();
  });

  it("says a failed load in words, with a way to try again", async () => {
    const loadPaper = vi.fn().mockRejectedValue(new ApiError(404, { status: 404, title: "Not Found" }));
    render(<NewVersionPage paper={SHORT_ID} loadPaper={loadPaper} signedIn />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no listed version");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says where the pre-fill comes from and what signing does", async () => {
    renderForm();
    await titleField();
    expect(screen.getByText(/Pre-filled from version 3/)).toBeTruthy();
    expect(screen.getByText(/becomes version 4/)).toBeTruthy();
  });

  it("loads the author's latest version when the paper has no listed version, and signs the next one", async () => {
    const harness = renderForm({}, {}, {}, { unlisted: true });
    const title = (await titleField()) as HTMLInputElement;
    expect(title.value).toBe("Sparse Probing of Reward Models");
    expect(screen.getByText(/Pre-filled from version 3/)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Continue to the change note" }));
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    expect(await screen.findByText("Version 4 is signed and submitted")).toBeTruthy();
    const [type, body, prev] = harness.sign.mock.calls[0];
    expect(type).toBe("paper.version");
    expect(prev).toBe(VERSION_CID);
    expect(body).toMatchObject({ paper: GENESIS, n: 4 });
  });

  it("keeps the not-available state for a paper the caller did not author", async () => {
    renderForm({}, {}, {}, { unlisted: true, authored: false });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no listed version");
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});

describe("NewVersionPage — the pre-filled details", () => {
  it("fills the title, abstract, categories and licence from the latest version", async () => {
    renderForm();
    const title = (await titleField()) as HTMLInputElement;
    expect(title.value).toBe("Sparse Probing of Reward Models");
    expect((screen.getByLabelText("Abstract") as HTMLTextAreaElement).value).toBe(
      "We probe reward models for the features they use.",
    );
    expect(
      screen.getByRole("button", { name: /cs\.AI/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /cs\.LG/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    // Both categories are already chosen, so Details is complete.
    expect(
      screen.getByRole("button", { name: "Continue to the change note" }).getAttribute("disabled"),
    ).toBeNull();
    const checked = screen
      .getAllByRole("radio")
      .filter((radio) => (radio as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect((checked[0] as HTMLInputElement).value).toBe("CC-BY-4.0");
  });

  it("pre-selects every category when an older version record does not name them", async () => {
    // The seeded/demo and pre-categories versions signed no `categories`; the
    // catalog still files the paper under the categories its genesis signed.
    renderForm({}, {}, { categories: undefined });
    await titleField();

    expect(
      screen.getByRole("button", { name: /cs\.AI/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /cs\.LG/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Continue to the change note" }).getAttribute("disabled"),
    ).toBeNull();
  });

  it("edits what will be signed", async () => {
    renderForm();
    const title = (await titleField()) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Sparse Probing of Reward Models, Revised" } });
    expect(title.value).toBe("Sparse Probing of Reward Models, Revised");
  });
});

describe("NewVersionPage — the change note", () => {
  it("requires a change note before the version can be signed", async () => {
    renderForm();
    await toChangeNote();

    const sign = screen.getByRole("button", { name: "Sign and submit version 4" });
    expect(sign.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("Say what changed in this version.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    expect(sign.getAttribute("disabled")).toBeNull();
  });

  it("counts the note's characters", async () => {
    renderForm();
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    expect(screen.getByText(/18 of 500 characters/)).toBeTruthy();
  });

  it("says what is carried over from the previous version, rather than implying files were chosen again", async () => {
    renderForm();
    await toChangeNote();
    const carried = screen.getByRole("region", { name: "Carried over from version 3" });
    expect(carried.textContent).toContain("Mei Chen");
    expect(carried.textContent).toContain("Rafael Silva");
    expect(carried.textContent).toContain("carried over unchanged");
    expect(carried.textContent).toContain("Extends");
  });
});

describe("NewVersionPage — signing", () => {
  it("signs a paper.version with prev set to the latest version, and submits it once", async () => {
    const harness = renderForm();
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    expect(await screen.findByText("Version 4 is signed and submitted")).toBeTruthy();

    expect(harness.sign).toHaveBeenCalledTimes(1);
    const [type, body, prev] = harness.sign.mock.calls[0];
    expect(type).toBe("paper.version");
    expect(prev).toBe(VERSION_CID);
    expect(body).toMatchObject({
      paper: GENESIS,
      n: 4,
      title: "Sparse Probing of Reward Models",
      changeNote: "Adds the appendix.",
      manifest: MANIFEST_CID,
      licence: "CC-BY-4.0",
      categories: ["cs.AI", "cs.LG"],
      authors: [
        expect.objectContaining({ did: A, position: 1 }),
        expect.objectContaining({ did: B, position: 2 }),
      ],
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect((harness.submit.mock.calls[0][0] as SignedRecord).prev).toBe(VERSION_CID);
  });

  it("shows the status tracker of the new version, asking the server about its consents", async () => {
    const harness = renderForm();
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    const tracker = await screen.findByRole("region", { name: "Status tracker" });
    expect(within(tracker).getAllByText(/Co-author consents/).length).toBeGreaterThan(0);
    expect(harness.fetchConsents).toHaveBeenCalledWith(
      { paper: SHORT_ID, version: 4 },
      expect.anything(),
    );
  });

  it("says a dismissed passkey prompt sent nothing, and can be asked again", async () => {
    const harness = renderForm();
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    harness.sign.mockRejectedValueOnce(new PasskeyCancelledError());
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing was sent");
    expect(harness.submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign and submit version 4" }).getAttribute("disabled")).toBeNull();
  });

  it("names a version that landed while the form was open, and loads the paper again keeping the note", async () => {
    const harness = renderForm();
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    harness.submit.mockRejectedValueOnce(
      new ApiError(409, {
        status: 409,
        type: "urn:scholium:problem:version-out-of-sequence",
        title: "Version out of sequence",
        detail: "version 4 with prev 'bafyrei…' was expected",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another version of this paper has landed");
    fireEvent.click(within(alert).getByRole("button", { name: "Load the paper again" }));

    // Back on Details with a fresh pre-fill; the note the author typed survives.
    const title = (await titleField()) as HTMLInputElement;
    expect(title.value).toBe("Sparse Probing of Reward Models");
    expect(harness.loadPaper).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Continue to the change note" }));
    expect((screen.getByLabelText(/change note/i) as HTMLTextAreaElement).value).toBe("Adds the appendix.");
  });
});

describe("NewVersionPage — who is signing", () => {
  it("marks the author on this device in the tracker after signing", async () => {
    const harness = renderForm({ submitterDid: B });
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit version 4" }));

    const tracker = await screen.findByRole("region", { name: "Status tracker" });
    expect(within(tracker).getAllByText("(you)")).toHaveLength(1);
  });

  it("names a key that is not on the byline, without hiding the action", async () => {
    renderForm({ submitterDid: STRANGER });
    await toChangeNote();
    const notice = screen.getByRole("note");
    expect(notice.textContent).toContain("not one of the authors version 3 lists");
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    expect(screen.getByRole("button", { name: "Sign and submit version 4" }).getAttribute("disabled")).toBeNull();
  });

  it("keeps the version unsigned while this device has no key, and says why", async () => {
    renderForm({ submitterDid: null });
    await toChangeNote();
    fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: "Adds the appendix." } });
    const sign = screen.getByRole("button", { name: "Sign and submit version 4" });
    expect(sign.getAttribute("disabled")).not.toBeNull();
    expect(screen.getAllByText(/no signing key/).length).toBeGreaterThan(0);
  });

  it("offers sign-in to an author who is not signed in", async () => {
    renderForm({ signedIn: false });
    await titleField();
    const notice = screen.getByRole("note");
    expect(notice.textContent).toContain("You are not signed in.");
    expect(within(notice).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/signin?next=%2Fsubmit%2Fnew-version%2Fsch%3Aabcd-efgh-ijkl",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* New files and the response to reviewers (PUB-6, REV-5)                      */
/* -------------------------------------------------------------------------- */

/** A File whose reported size is `size`, without allocating that many bytes. */
function makeFile(name: string, size = 1000, type = ""): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** An uploader that finishes at once, filing each file under the cid given for its name. */
function instantUploads(cids: Record<string, string>): ManagerDeps {
  return {
    startUpload: (file, _init, callbacks) => {
      queueMicrotask(() => callbacks.onSuccess({ cid: cids[file.name], url: null }));
      return { stop: vi.fn(async () => undefined) };
    },
    fingerprint: async (file) => cids[(file as File).name],
  };
}

const withFiles = { files: MANIFEST_FILES };
const choosePaper = (files: File[]) =>
  fireEvent.change(screen.getByLabelText("Choose paper files"), { target: { files } });
const chooseExtras = (files: File[]) =>
  fireEvent.change(screen.getByLabelText("Choose code and data files"), { target: { files } });
const filesRegion = () => screen.getByRole("region", { name: "Files" });
const writeNote = (note = "Replaces the PDF.") =>
  fireEvent.change(screen.getByLabelText(/change note/i), { target: { value: note } });
const signButton = () => screen.getByRole("button", { name: "Sign and submit version 4" });

describe("NewVersionPage — files", () => {
  it("lists the files of the previous version, each kept by default, with its size", async () => {
    renderForm({}, {}, {}, withFiles);
    await toChangeNote();

    const region = filesRegion();
    expect(within(region).getByText("paper.pdf")).toBeTruthy();
    expect(within(region).getByText("code/run.py")).toBeTruthy();
    expect(region.textContent).toContain("471 KB");
    expect(within(region).getAllByText("Kept")).toHaveLength(2);
    // Nothing changed, so nothing is promised about a new manifest.
    expect(screen.getByRole("region", { name: "Carried over from version 3" }).textContent).toContain(
      "carried over unchanged",
    );
  });

  it("offers the same two drop zones as /submit, and the same size limits", async () => {
    renderForm({}, {}, {}, withFiles);
    await toChangeNote();
    expect(screen.getByLabelText("Choose paper files")).toBeTruthy();
    expect(screen.getByLabelText("Choose code and data files")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Size limits" })).toBeTruthy();
  });

  it("signs a manifest of the new PDF in place of the old one, then a version that names it", async () => {
    const harness = renderForm({ managerDeps: instantUploads({ "paper.pdf": PDF2_CID }) }, {}, {}, withFiles);
    await toChangeNote();
    choosePaper([makeFile("paper.pdf", 530004, "application/pdf")]);

    expect(await within(filesRegion()).findByText("Replaced by the new upload")).toBeTruthy();
    expect(within(filesRegion()).getByRole("status", { name: "Files in version 4" }).textContent).toContain(
      "1 replaced",
    );
    writeNote();
    fireEvent.click(signButton());
    expect(await screen.findByText("Version 4 is signed and submitted")).toBeTruthy();

    expect(harness.sign.mock.calls.map((call) => call[0])).toEqual(["manifest", "paper.version"]);
    const [, manifestBody, manifestPrev] = harness.sign.mock.calls[0];
    expect(manifestPrev).toBeNull();
    expect(manifestBody).toEqual({
      files: [
        { path: "paper.pdf", cid: PDF2_CID, size: 530004, mediaType: "application/pdf", role: "manuscript" },
        { path: "code/run.py", cid: CODE_CID, size: 1204, mediaType: "text/x-python", role: "code" },
      ],
    });
    expect(harness.sign.mock.calls[1][1]).toMatchObject({ n: 4, manifest: NEW_MANIFEST_CID });
    expect(harness.submit.mock.calls.map((call) => (call[0] as SignedRecord).type)).toEqual([
      "manifest",
      "paper.version",
    ]);
  });

  it("adds a LaTeX source and a code file beside the kept ones", async () => {
    const harness = renderForm(
      { managerDeps: instantUploads({ "paper.tex": TEX_CID }) },
      {},
      {},
      withFiles,
    );
    await toChangeNote();
    choosePaper([makeFile("paper.tex", 9120, "application/x-tex")]);
    expect(await within(filesRegion()).findByText("paper.tex", { selector: ".sw-file__name" })).toBeTruthy();
    writeNote("Adds the LaTeX source.");
    fireEvent.click(signButton());
    await screen.findByText("Version 4 is signed and submitted");

    const files = (harness.sign.mock.calls[0][1] as { files: { path: string; role: string }[] }).files;
    expect(files.map((file) => [file.path, file.role])).toEqual([
      ["paper.pdf", "manuscript"],
      ["code/run.py", "code"],
      ["paper.tex", "source"],
    ]);
  });

  it("removes a file the author drops, and can put it back", async () => {
    const harness = renderForm({}, {}, {}, withFiles);
    await toChangeNote();
    const region = filesRegion();
    fireEvent.click(within(region).getByRole("button", { name: "Remove code/run.py" }));
    expect(within(region).getByText("Removed")).toBeTruthy();
    expect(within(region).getByRole("status", { name: "Files in version 4" }).textContent).toContain("1 removed");

    fireEvent.click(within(region).getByRole("button", { name: "Keep code/run.py" }));
    expect(within(region).queryByText("Removed")).toBeNull();

    fireEvent.click(within(region).getByRole("button", { name: "Remove code/run.py" }));
    writeNote("Drops the script.");
    fireEvent.click(signButton());
    await screen.findByText("Version 4 is signed and submitted");
    const files = (harness.sign.mock.calls[0][1] as { files: { path: string }[] }).files;
    expect(files.map((file) => file.path)).toEqual(["paper.pdf"]);
  });

  it("will not sign once the files no longer hold the paper, and says so", async () => {
    renderForm({}, {}, {}, withFiles);
    await toChangeNote();
    fireEvent.click(within(filesRegion()).getByRole("button", { name: "Remove paper.pdf" }));
    writeNote("Drops the paper.");
    expect(signButton().getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("Keep or add your paper as a PDF or LaTeX source.")).toBeTruthy();
  });

  it("keeps the version unsigned while a new file is still uploading", async () => {
    const callbacksOf: { onSuccess: (done: { cid: string; url: string | null }) => void }[] = [];
    const hashes: ((cid: string) => void)[] = [];
    const managerDeps: ManagerDeps = {
      startUpload: (_file, _init, callbacks) => {
        callbacksOf.push(callbacks);
        return { stop: vi.fn(async () => undefined) };
      },
      fingerprint: () => new Promise<string>((resolve) => hashes.push(resolve)),
    };
    renderForm({ managerDeps }, {}, {}, withFiles);
    await toChangeNote();
    choosePaper([makeFile("paper.pdf", 530004, "application/pdf")]);
    writeNote();

    expect(signButton().getAttribute("disabled")).not.toBeNull();
    expect(screen.getByText("Wait for the uploads and fingerprints to finish.")).toBeTruthy();

    await act(async () => {
      callbacksOf[0].onSuccess({ cid: PDF2_CID, url: null });
      hashes[0](PDF2_CID);
    });
    await waitFor(() => expect(signButton().getAttribute("disabled")).toBeNull());
  });

  it("carries the files over by id, and offers no upload, when the previous list cannot be read", async () => {
    // No `files`: the manifest record is not served, so the list is unknown.
    renderForm();
    await toChangeNote();
    expect(screen.queryByLabelText("Choose paper files")).toBeNull();
    expect(filesRegion().textContent).toContain("could not be listed");
    expect(filesRegion().textContent).toContain("carried over unchanged");
  });

  it("keeps the uploaded files when the author steps back to Details and forward again", async () => {
    renderForm({ managerDeps: instantUploads({ "paper.tex": TEX_CID }) }, {}, {}, withFiles);
    await toChangeNote();
    choosePaper([makeFile("paper.tex", 9120, "application/x-tex")]);
    await within(filesRegion()).findByText("Uploaded");

    fireEvent.click(screen.getByRole("button", { name: "Back to Details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to the change note" }));
    expect(within(filesRegion()).getByText("paper.tex", { selector: ".sw-file__name" })).toBeTruthy();
    expect(within(filesRegion()).getByText("Uploaded")).toBeTruthy();
  });
});

describe("NewVersionPage — the scan of the new files", () => {
  it("asks the node for the new version's automated checks after signing, and says they are pending", async () => {
    const harness = renderForm({ managerDeps: instantUploads({ "paper.pdf": PDF2_CID }) }, {}, {}, withFiles);
    await toChangeNote();
    choosePaper([makeFile("paper.pdf", 530004, "application/pdf")]);
    await within(filesRegion()).findByText("Replaced by the new upload");
    writeNote();
    fireEvent.click(signButton());
    await screen.findByText("Version 4 is signed and submitted");

    const checks = await screen.findByRole("region", { name: "Automated checks" });
    expect(within(checks).getByText("Checks pending")).toBeTruthy();
    expect(harness.fetchChecks).toHaveBeenCalledWith({ paper: SHORT_ID, version: 4 }, expect.anything());
  });

  it("shows the file safety verdict once the node has scanned the new files", async () => {
    const report: VersionChecks = {
      paper: SHORT_ID,
      version: 4,
      versionCid: NEW_VERSION_CID,
      state: "scanning",
      files: [
        { path: "paper.pdf", cid: PDF2_CID, role: "manuscript", status: "passed", failedChecks: [], detail: null },
      ],
      referencesTotal: null,
      referencesUnresolved: null,
      similarityPct: null,
      metadataMatch: null,
      signedTitle: null,
      firstPageTitle: null,
      checkedAt: null,
    };
    const fetchChecks = vi.fn(async () => report);
    renderForm({ fetchChecks });
    await toChangeNote();
    writeNote("Fixes a typo.");
    fireEvent.click(signButton());
    await screen.findByText("Version 4 is signed and submitted");

    const checks = await screen.findByRole("region", { name: "Automated checks" });
    await waitFor(() => expect(within(checks).queryByText("Checks pending")).toBeNull());
    expect(within(checks).getByText(/File safety/i)).toBeTruthy();
  });
});

describe("NewVersionPage — response to reviewers", () => {
  const withReviews = { ...withFiles, reviews: REVIEWS_LISTING };
  const response = (label: string) => screen.getByLabelText(`Your response to ${label}`) as HTMLTextAreaElement;

  it("lists each revealed review of the previous version, with a response box for each", async () => {
    renderForm({}, {}, {}, withReviews);
    await toChangeNote();
    const region = screen.getByRole("region", { name: "Response to reviewers" });
    expect(within(region).getByText("Reviewer A")).toBeTruthy();
    expect(within(region).getByText("Reviewer B")).toBeTruthy();
    expect(within(region).getByText(/Minor revisions/)).toBeTruthy();
    expect(response("Reviewer A")).toBeTruthy();
    expect(response("Reviewer B")).toBeTruthy();
    // The report is there to read, behind a native disclosure.
    expect(within(region).getByText("The proof of Lemma 2 skips a step.")).toBeTruthy();
  });

  it("has no such section when there is no revealed review to answer", async () => {
    renderForm({}, {}, {}, withFiles);
    await toChangeNote();
    expect(screen.queryByRole("region", { name: "Response to reviewers" })).toBeNull();
  });

  it("posts each answer as that review's response, after the version, and says so", async () => {
    const harness = renderForm({}, {}, {}, withReviews);
    await toChangeNote();
    fireEvent.change(response("Reviewer A"), { target: { value: "We added the missing step in Lemma 2." } });
    writeNote("Answers the reviewers.");
    fireEvent.click(signButton());
    expect(await screen.findByText("Version 4 is signed and submitted")).toBeTruthy();

    // Reviewer B's box was left empty: nothing is posted for it.
    expect(harness.sign.mock.calls.map((call) => call[0])).toEqual(["paper.version", "review.response"]);
    expect(harness.sign.mock.calls[1][1]).toEqual({
      review: REVIEW_A,
      items: [{ dimension: "general", reply: "We added the missing step in Lemma 2." }],
    });
    expect(harness.respond).toHaveBeenCalledTimes(1);
    expect(harness.respond.mock.calls[0][0]).toBe(REVIEW_A);
    expect(await screen.findByText("Response to Reviewer A: posted")).toBeTruthy();
  });

  it("keeps the version when a response is refused, names which, and can post it again", async () => {
    const harness = renderForm({}, {}, {}, withReviews);
    harness.respond.mockRejectedValueOnce(new ApiError(403, { status: 403, title: "Forbidden" }));
    await toChangeNote();
    fireEvent.change(response("Reviewer A"), { target: { value: "We added the missing step." } });
    writeNote("Answers the reviewers.");
    fireEvent.click(signButton());

    expect(await screen.findByText("Version 4 is signed and submitted")).toBeTruthy();
    const failed = await screen.findByText(/Response to Reviewer A: not posted/);
    expect(failed.textContent).toContain("may not answer that review");

    fireEvent.click(screen.getByRole("button", { name: "Post the failed responses again" }));
    expect(await screen.findByText("Response to Reviewer A: posted")).toBeTruthy();
    expect(harness.respond).toHaveBeenCalledTimes(2);
    // The version was not signed again.
    expect(harness.submit.mock.calls.filter((call) => (call[0] as SignedRecord).type === "paper.version")).toHaveLength(1);
  });

  it("says how many signatures it will ask for, now that more than the version is signed", async () => {
    renderForm({}, {}, {}, withReviews);
    await toChangeNote();
    writeNote("Answers the reviewers.");
    expect(screen.getByText(/You are signing version 4 of this paper\. This cannot be edited later\.$/)).toBeTruthy();

    fireEvent.change(response("Reviewer A"), { target: { value: "One." } });
    fireEvent.change(response("Reviewer B"), { target: { value: "Two." } });
    expect(
      screen.getByText(/You will confirm 3 signatures: the version and 2 responses\./),
    ).toBeTruthy();
  });

  it("posts no response when the version itself is refused, and keeps what the author wrote", async () => {
    const harness = renderForm({}, {}, {}, withReviews);
    await toChangeNote();
    fireEvent.change(response("Reviewer B"), { target: { value: "Thank you." } });
    writeNote("Answers the reviewers.");
    harness.submit.mockRejectedValueOnce(
      new ApiError(409, {
        status: 409,
        type: "urn:scholium:problem:version-out-of-sequence",
        title: "Version out of sequence",
        detail: "version 4 with prev 'bafyrei…' was expected",
      }),
    );
    fireEvent.click(signButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another version of this paper has landed");
    expect(harness.respond).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "Load the paper again" }));
    await titleField();
    fireEvent.click(screen.getByRole("button", { name: "Continue to the change note" }));
    expect(response("Reviewer B").value).toBe("Thank you.");
  });
});
