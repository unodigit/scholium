// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import { PasskeyCancelledError, type SignedRecord } from "../web-auth";
import { NewVersionPage, type NewVersionPageProps } from "./new-version-page";
import { loadNewVersionPaper, type NewVersionPaper } from "./new-version";
import type { ConsentReport } from "./consents";

afterEach(cleanup);

const A = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const B = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const STRANGER = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSRPnE";
const SHORT_ID = "sch:abcd-efgh-ijkl";
const GENESIS = "bafyreigenesis7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const VERSION_CID = "bafyreiversion7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const MANIFEST_CID = "bafyreimanifest7tq3k4ab2tz6yq2l5ox3s4ihz3m7wq5q2d5v5xv3wlkm";
const NEW_VERSION_CID = "bafyreinewversionrecord0000000000000000000000000000";

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
  options: { unlisted?: boolean; authored?: boolean } = {},
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
  const fetchRecord = vi.fn().mockResolvedValue({
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
  return {
    paper,
    loadPaper: vi.fn((id: string, options?: { signal?: AbortSignal }) =>
      loadNewVersionPaper(id, {
        fetchPaper,
        fetchOwnPapers,
        fetchRecord,
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

function signedRecord(did: string, body: Record<string, unknown>, prev: string | null): SignedRecord {
  return {
    v: 1,
    type: "paper.version",
    id: NEW_VERSION_CID,
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
  fetchConsents: ReturnType<typeof vi.fn>;
}

function renderForm(
  props: Partial<NewVersionPageProps> = {},
  paper: Partial<NewVersionPaper> = {},
  recordBody: Record<string, unknown> = {},
  loadOptions: { unlisted?: boolean; authored?: boolean } = {},
): Harness {
  const built = loader(paper, recordBody, loadOptions);
  const sign = vi.fn(
    async (_type: string, body: Record<string, unknown>, prev: string | null) =>
      signedRecord(props.submitterDid ?? A, body, prev),
  );
  const submit = vi.fn(async (record: SignedRecord) => ({ id: record.id, state: "awaiting_consent" }));
  const fetchConsents = vi.fn(async () => consentReport());
  render(
    <NewVersionPage
      paper={SHORT_ID}
      submitterDid={A}
      signedIn
      pollMs={0}
      loadPaper={built.loadPaper}
      sign={sign}
      submit={submit}
      fetchConsents={fetchConsents}
      {...props}
    />,
  );
  return { loadPaper: built.loadPaper, sign, submit, fetchConsents };
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
