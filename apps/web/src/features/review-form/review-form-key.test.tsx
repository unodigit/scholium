// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnonymityNotice } from "./anonymity-notice";
import type { ReviewCommitResult } from "./commit";
import { parseConflictReport } from "./conflict";
import { ConflictCheck } from "./conflict-check";
import { SIGN_WITH_NAME_LABEL } from "./identity";
import { reviewHref } from "./links";
import { parseMyReviews, type LoadMyReviews } from "./my-reviews";
import { PBKDF2_MIN_ITERATIONS } from "./passphrase-box";
import type { UpdateReview } from "./reveal";
import {
  COMMIT_LABEL,
  ReviewForm,
  SEALED_ELSEWHERE_HEADLINE,
  SEALED_ELSEWHERE_TEXT,
  UPDATE_LABEL,
} from "./review-form";
import { ReviewSessionProvider } from "./review-session";
import {
  buildReviewKeyFile,
  decryptReviewKeyFile,
  encryptReviewKeyFile,
  forgetReviewKey,
  loadReviewKey,
  reviewKeyFromSeed,
  saveReviewKey,
  DOWNLOAD_REVIEW_KEY_LABEL,
  IMPORT_REVIEW_KEY_LABEL,
} from "./review-key";
import {
  CONFIRM_PASSPHRASE_LABEL,
  DECRYPT_AND_IMPORT_LABEL,
  ENCRYPT_AND_DOWNLOAD_LABEL,
  PASSPHRASE_LABEL,
  REVIEW_KEY_FILE_LABEL,
  reviewKeyFilename,
  type KeyFileSeams,
} from "./review-key-panels";
import { RUBRIC_DIMENSIONS, emptyDraft, withDimension, type ReviewDraft } from "./rubric";
import {
  loadSealedReview,
  saveSealedReview,
  type SealedReview,
} from "./sealed-review";

/**
 * The review key as a reviewer lives with it: a file encrypted with a
 * passphrase to carry it to another browser, a seed that never rests in
 * `localStorage`, and — in a browser that has nothing to reveal with — a card
 * that says why there is no Commit form and offers the import.
 */

const PAPER = "sch:6sel-2dio-orm6";
const OTHER_PAPER = "sch:k3f9-q2xz-7mwd";
const PASSPHRASE = "correct horse battery staple";
const SEED = new Uint8Array(32).fill(7);
const KEY = reviewKeyFromSeed(SEED);
const SEED_BASE64 = Buffer.from(SEED).toString("base64");

/** Faster key derivation (never below the minimum) for the tests. */
const FAST_SEAMS: KeyFileSeams = { passphrase: { iterations: PBKDF2_MIN_ITERATIONS } };

const SEALED: SealedReview = {
  paperId: PAPER,
  versionCid: "bafyversion",
  reviewCid: "bafycommitted",
  revealAt: "2026-12-14T00:00:00.000Z",
  commitment: "a1b2c3",
  revealBody: {
    target: "bafyversion",
    scores: Object.fromEntries(
      RUBRIC_DIMENSIONS.map(({ id }) => [
        id,
        { score: 3, justification: `A private justification of ${id}.` },
      ]),
    ),
    confidence: "high",
    recommendation: "sound_as_is",
    aiAssisted: false,
  },
};

afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await forgetReviewKey(PAPER);
  await forgetReviewKey(OTHER_PAPER);
  vi.unstubAllGlobals();
});

/** What the dashboard says of the signed-in reviewer's reviews. */
function dashboard(...rows: Array<Record<string, unknown>>): LoadMyReviews {
  return vi.fn(async () => parseMyReviews({ my_reviews: rows }));
}

function mine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_cid: "bafycommitted",
    shortId: PAPER,
    state: "sealed",
    sealed: true,
    revealed: false,
    version: 1,
    version_cid: "bafyversion",
    ...overrides,
  };
}

function completeDraft(): ReviewDraft {
  return RUBRIC_DIMENSIONS.reduce(
    (current, { id }) => withDimension(current, id, { score: 3, justification: "Fine." }),
    { ...emptyDraft(), confidence: "high", recommendation: "sound_as_is" } as ReviewDraft,
  );
}

/** A conflict check that came back clear on every row. */
function clearConflictReport() {
  return parseConflictReport({
    paper: PAPER,
    clear: true,
    checks: [
      { id: "not_author", label: "Not an author", status: "pass", passed: true },
      {
        id: "no_recent_coauthorship",
        label: "No recent co-authorship",
        status: "pass",
        passed: true,
      },
      {
        id: "different_institution",
        label: "Different institution",
        status: "pass",
        passed: true,
      },
    ],
  });
}

function renderForm(extra: Record<string, unknown> = {}) {
  return render(
    <ReviewForm
      paperId={PAPER}
      versionCid="bafyversion"
      signedIn
      keyFile={FAST_SEAMS}
      {...extra}
    />,
  );
}

async function keyFileText(sealed = SEALED, passphrase = PASSPHRASE): Promise<string> {
  return encryptReviewKeyFile(sealed, KEY, passphrase, FAST_SEAMS.passphrase);
}

function chooseFile(text: string, name = "scholium-review-key.json"): void {
  const input = screen.getByLabelText(REVIEW_KEY_FILE_LABEL);
  const file = new File([text], name, { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
}

async function importWith(text: string, passphrase: string): Promise<void> {
  chooseFile(text);
  const panel = await screen.findByRole("form", { name: IMPORT_REVIEW_KEY_LABEL });
  fireEvent.change(within(panel).getByLabelText(PASSPHRASE_LABEL), {
    target: { value: passphrase },
  });
  fireEvent.click(within(panel).getByRole("button", { name: DECRYPT_AND_IMPORT_LABEL }));
}

// --------------------------------------------------------------------------- //
// A sealed review the API knows of and this browser does not
// --------------------------------------------------------------------------- //

describe("a sealed review by this reviewer that this browser cannot reveal", () => {
  it("shows the sealed-review card, not a Commit form, and offers the import", async () => {
    const loadOwnReviews = dashboard(mine());

    renderForm({ loadOwnReviews });

    const card = await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });
    expect(card).toBeTruthy();
    expect(screen.getByText("Review of v1 · Sealed")).toBeTruthy();
    expect(screen.getByText(SEALED_ELSEWHERE_TEXT)).toBeTruthy();
    expect(screen.getByRole("button", { name: IMPORT_REVIEW_KEY_LABEL })).toBeTruthy();
    // A commit would be refused (409), so there is nothing to commit with.
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
    expect(screen.queryByRole("form", { name: "Your review" })).toBeNull();
    expect(loadOwnReviews).toHaveBeenCalledTimes(1);
  });

  it("matches the paper however its id is spelled", async () => {
    renderForm({
      paperId: "k3f9-q2xz-7mwd",
      loadOwnReviews: dashboard(mine({ shortId: "sch:K3F9-Q2XZ-7MWD" })),
    });

    expect(await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeTruthy();
  });

  it("keeps the Commit form when the reviewer has no review of this paper", async () => {
    const loadOwnReviews = dashboard(
      mine({ shortId: OTHER_PAPER }),
      mine({ shortId: OTHER_PAPER, state: "revealed", sealed: false, revealed: true }),
    );

    renderForm({ loadOwnReviews });

    await waitFor(() => expect(loadOwnReviews).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeNull();
  });

  it("keeps the Commit form when the dashboard cannot be read", async () => {
    const loadOwnReviews: LoadMyReviews = vi.fn(async () => {
      throw new Error("offline");
    });

    renderForm({ loadOwnReviews });

    await waitFor(() => expect(loadOwnReviews).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeNull();
  });

  it("keeps the sealed card when this browser has the sealed review and the API agrees", async () => {
    saveSealedReview(SEALED);
    const loadOwnReviews = dashboard(mine());

    renderForm({ loadOwnReviews });

    expect(await screen.findByRole("heading", { name: "Your review is sealed" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeNull();
    // The server is now asked even when a local copy exists: only the API can
    // say whether that copy was revealed elsewhere since it was stored.
    await waitFor(() => expect(loadOwnReviews).toHaveBeenCalled());
  });

  it("is not asked for when nobody is signed in", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewForm paperId={PAPER} versionCid="bafyversion" signedIn={false} />);

    expect(await screen.findByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not asked for when the form updates a revealed review", async () => {
    const loadOwnReviews = dashboard(mine());

    renderForm({ loadOwnReviews, prev: "bafyformal" });

    expect(await screen.findByRole("button", { name: "Update review" })).toBeTruthy();
    expect(loadOwnReviews).not.toHaveBeenCalled();
  });

  it("restores the sealed review from the key file, so it can be revealed here", async () => {
    renderForm({ loadOwnReviews: dashboard(mine()) });
    await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });

    await importWith(await keyFileText(), PASSPHRASE);

    expect(await screen.findByRole("heading", { name: "Your review is sealed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal review" })).toBeTruthy();
    // Kept on this device the way a commit keeps it.
    expect(loadSealedReview(PAPER)).toEqual(SEALED);
    expect((await loadReviewKey(PAPER))?.did).toBe(KEY.did);
  });

  it("does not restore anything under the wrong passphrase", async () => {
    renderForm({ loadOwnReviews: dashboard(mine()) });
    await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });

    await importWith(await keyFileText(), "not the passphrase");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/does not open this file/);
    expect(screen.getByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeTruthy();
    expect(loadSealedReview(PAPER)).toBeNull();
    expect(await loadReviewKey(PAPER)).toBeNull();
  });

  it("turns away the plaintext file an earlier version wrote", async () => {
    renderForm({ loadOwnReviews: dashboard(mine()) });
    await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });

    await importWith(JSON.stringify(buildReviewKeyFile(SEALED, KEY)), PASSPHRASE);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not an encrypted review key file/);
    expect(loadSealedReview(PAPER)).toBeNull();
  });

  it("turns away a key file for another paper", async () => {
    renderForm({ loadOwnReviews: dashboard(mine()) });
    await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });

    await importWith(await keyFileText({ ...SEALED, paperId: OTHER_PAPER }), PASSPHRASE);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/different paper/);
    expect(loadSealedReview(OTHER_PAPER)).toBeNull();
    expect(await loadReviewKey(OTHER_PAPER)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// A revealed review the API knows of and this browser cannot act on
// --------------------------------------------------------------------------- //

describe("a revealed review by this reviewer that this browser does not hold", () => {
  function revealedMine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return mine({
      state: "revealed",
      sealed: false,
      revealed: true,
      version: 1,
      version_cid: "bafyv1",
      recommendation: "minor_revisions",
      confidence: 3,
      scores: { soundness: { score: 3, justification: "Sound enough." } },
      revealedAt: "2026-12-01T00:00:00",
      ...overrides,
    });
  }

  function listing(overrides: Record<string, unknown> = {}) {
    return vi.fn(async () => ({
      reviewCid: "bafycommitted",
      formalCid: "bafyformal2",
      version: 2,
      recommendation: "minor_revisions",
      confidence: "high",
      scores: { soundness: { score: 4, justification: "Still sound." } },
      report: "The updated report.",
      revealedAt: "2026-12-02T00:00:00",
      gateOpen: true,
      ...overrides,
    }));
  }

  it("shows the revealed review read-only, never a blank Commit form", async () => {
    const loadOwnReview = listing();

    renderForm({
      loadOwnReviews: dashboard(revealedMine()),
      loadOwnReview,
      latestVersion: 2,
    });

    expect(
      await screen.findByRole("heading", { name: "You already reviewed this paper" }),
    ).toBeTruthy();
    // No dead-end Commit form: a second review would be refused.
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
    expect(screen.queryByRole("form", { name: "Your review" })).toBeNull();
    // What the reviewer wrote, as the listing now serves it (the listing read
    // resolves after the dashboard one, so wait for its content).
    expect(await screen.findByText("4 of 5")).toBeTruthy();
    expect(await screen.findByText("The updated report.")).toBeTruthy();
    expect(await screen.findByText(/Review of v2/)).toBeTruthy();
    expect(screen.getByText("Minor revisions")).toBeTruthy();
    expect(loadOwnReview).toHaveBeenCalledWith(PAPER, "bafycommitted");
  });

  it("offers an update against the newest version without asking for the key first", async () => {
    renderForm({
      loadOwnReviews: dashboard(revealedMine()),
      loadOwnReview: listing({ version: 1, formalCid: "bafyformal1" }),
      latestVersion: 2,
    });

    await screen.findByRole("heading", { name: "You already reviewed this paper" });

    const link = await screen.findByRole("link", { name: "Update for v2" });
    expect(link.getAttribute("href")).toBe(
      `${reviewHref(PAPER)}?prev=bafyformal1`,
    );
    // The update derives the review key when it signs; only a reveal needs a
    // key file, so the card must not tell the reviewer to import one.
    expect(
      screen.queryByRole("button", { name: IMPORT_REVIEW_KEY_LABEL }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
  });

  it("does not offer an update when the reviewer already stands on the newest version", async () => {
    renderForm({
      loadOwnReviews: dashboard(revealedMine()),
      loadOwnReview: listing({ version: 2 }),
      latestVersion: 2,
    });

    await screen.findByRole("heading", { name: "You already reviewed this paper" });
    // Wait for the listing's version, so "no update link" is a real answer
    // and not just the state before the listing read resolves.
    await screen.findByText(/Review of v2/);

    expect(screen.queryByRole("link", { name: /Update for v/ })).toBeNull();
  });

  it("lets the server's revealed status win over a stale sealed copy on this device", async () => {
    // The reviewer imported the sealed review after it had been revealed
    // elsewhere (or a reveal in another tab left the copy behind). The local
    // entry is now stale: it must not put the page back into the sealed state.
    saveSealedReview(SEALED);

    renderForm({
      loadOwnReviews: dashboard(revealedMine()),
      loadOwnReview: listing({ version: 1, formalCid: "bafyformal1" }),
      latestVersion: 2,
    });

    expect(
      await screen.findByRole("heading", { name: "You already reviewed this paper" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your review is sealed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal review" })).toBeNull();
    // The stale entry is forgotten, so a reload cannot fall back into it.
    expect(loadSealedReview(PAPER)).toBeNull();
  });

  it("opens the update form after a key was imported for an already-revealed review", async () => {
    // Import-after-reveal leaves the sealed copy on the device; the update page
    // must not treat it as something still waiting to be revealed.
    saveSealedReview(SEALED);
    const update = vi.fn<UpdateReview>(async () => ({
      revealCid: "bafyreveal2",
      reviewCid: "bafycommitted",
      body: {},
      record: {
        v: 1,
        type: "review.formal",
        id: "bafyreveal2",
        author: "did:key:z6Mkreview",
        created: "2026-12-01T00:00:00Z",
        prev: "bafyformal",
        body: {},
        proofs: [],
        sig: "sig",
      },
    }));

    renderForm({ prev: "bafyformal", update, initialDraft: completeDraft() });

    expect(screen.queryByRole("heading", { name: "Your review is sealed" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: UPDATE_LABEL }));

    await screen.findByRole("heading", { name: "Your review is updated" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not offer a key import on the update form, so it can never fall back to a sealed card", async () => {
    // Sweep 7, journey 13: importing the key from the update form switched the
    // page to "Your review is sealed" with a Reveal the node refuses.
    renderForm({ prev: "bafyformal", initialDraft: completeDraft() });

    expect(await screen.findByRole("button", { name: UPDATE_LABEL })).toBeTruthy();
    expect(screen.queryByLabelText(REVIEW_KEY_FILE_LABEL)).toBeNull();
    expect(screen.queryByRole("form", { name: IMPORT_REVIEW_KEY_LABEL })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your review is sealed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal review" })).toBeNull();
  });

  it("offers no identity choice beside the revealed card, where no form uses it", async () => {
    render(
      <ReviewSessionProvider>
        <AnonymityNotice />
        <ReviewForm
          paperId={PAPER}
          versionCid="bafyversion"
          signedIn
          loadOwnReviews={dashboard(revealedMine())}
          loadOwnReview={listing()}
          latestVersion={2}
        />
      </ReviewSessionProvider>,
    );

    await screen.findByRole("heading", { name: "You already reviewed this paper" });
    // The form tells the session it is gone from an effect, so the notice drops
    // its identity choice a render after the heading appears.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull(),
    );
  });

  it("words the clear conflict check for a reviewer who already has a review", async () => {
    const report = clearConflictReport();

    render(
      <ReviewSessionProvider>
        <ConflictCheck paperId={PAPER} initial={report} signedIn />
        <ReviewForm
          paperId={PAPER}
          versionCid="bafyversion"
          signedIn
          loadOwnReviews={dashboard(revealedMine())}
          loadOwnReview={listing()}
          latestVersion={2}
        />
      </ReviewSessionProvider>,
    );

    await screen.findByRole("heading", { name: "You already reviewed this paper" });
    // The form tells the session about the review from an effect, so the
    // conflict check rewords itself a render after the heading appears.
    expect(
      await screen.findByText("No conflicts found. You already reviewed this paper."),
    ).toBeTruthy();
    expect(screen.queryByText(/You can review this paper/)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Beside the sealed cards: no form, so no identity choice and no invitation
// --------------------------------------------------------------------------- //

describe("the page beside a sealed review card", () => {
  /** The notice, the conflict check and the form, sharing one session as the page does. */
  function renderPage(extra: Record<string, unknown> = {}) {
    return render(
      <ReviewSessionProvider>
        <AnonymityNotice />
        <ConflictCheck paperId={PAPER} initial={clearConflictReport()} signedIn />
        <ReviewForm paperId={PAPER} versionCid="bafyversion" signedIn {...extra} />
      </ReviewSessionProvider>,
    );
  }

  it("offers the identity choice only while the Commit form is there", async () => {
    // The API answers late, so the Commit form is on the page first.
    renderPage({ loadOwnReviews: dashboard() });
    expect(screen.getByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeTruthy();

    // With no review of this reviewer's, the form stays and so does the choice.
    await waitFor(() => expect(screen.getByRole("button", { name: COMMIT_LABEL })).toBeTruthy());
    expect(screen.getByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeTruthy();
    expect(screen.getByText("No conflicts found. You can review this paper.")).toBeTruthy();
  });

  it("drops the identity choice and the invitation beside the sealed-elsewhere card", async () => {
    renderPage({ loadOwnReviews: dashboard(mine()) });

    await screen.findByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE });

    // No form here will seal that choice into a commit, and a second review
    // cannot be committed, so the page neither offers one nor invites one.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: COMMIT_LABEL })).toBeNull();
    expect(
      screen.getByText("No conflicts found. You already reviewed this paper."),
    ).toBeTruthy();
    expect(screen.queryByText(/You can review this paper/)).toBeNull();
  });

  it("drops the identity choice and the invitation beside the sealed card of this device", async () => {
    saveSealedReview(SEALED);

    renderPage({ loadOwnReviews: dashboard(mine()) });

    await screen.findByRole("heading", { name: "Your review is sealed" });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: SIGN_WITH_NAME_LABEL })).toBeNull(),
    );
    expect(
      screen.getByText("No conflicts found. You already reviewed this paper."),
    ).toBeTruthy();
    expect(screen.queryByText(/You can review this paper/)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Importing before writing, from the Commit form
// --------------------------------------------------------------------------- //

describe("importing a review key from the Commit form", () => {
  it("asks for the passphrase of the file chosen, and then shows the sealed review", async () => {
    renderForm();

    chooseFile(await keyFileText(), "my-key.json");
    const panel = await screen.findByRole("form", { name: IMPORT_REVIEW_KEY_LABEL });
    expect(within(panel).getByText(/my-key\.json is encrypted/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText(PASSPHRASE_LABEL), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(within(panel).getByRole("button", { name: DECRYPT_AND_IMPORT_LABEL }));

    expect(await screen.findByRole("heading", { name: "Your review is sealed" })).toBeTruthy();
  });

  it("changes nothing when the import is cancelled", async () => {
    renderForm();

    chooseFile(await keyFileText());
    const panel = await screen.findByRole("form", { name: IMPORT_REVIEW_KEY_LABEL });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("form", { name: IMPORT_REVIEW_KEY_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: COMMIT_LABEL })).toBeTruthy();
    expect(loadSealedReview(PAPER)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Downloading
// --------------------------------------------------------------------------- //

describe("downloading the review key from the sealed card", () => {
  async function sealedCardWithKey(download: (name: string, text: string) => void) {
    saveSealedReview(SEALED);
    await saveReviewKey(PAPER, KEY);
    renderForm({ keyFile: { ...FAST_SEAMS, download } });
    return screen.findByRole("button", { name: DOWNLOAD_REVIEW_KEY_LABEL });
  }

  async function choosePassphrase(passphrase: string, confirmation = passphrase) {
    fireEvent.click(await screen.findByRole("button", { name: DOWNLOAD_REVIEW_KEY_LABEL }));
    const panel = await screen.findByRole("form", { name: DOWNLOAD_REVIEW_KEY_LABEL });
    fireEvent.change(within(panel).getByLabelText(PASSPHRASE_LABEL), {
      target: { value: passphrase },
    });
    fireEvent.change(within(panel).getByLabelText(CONFIRM_PASSPHRASE_LABEL), {
      target: { value: confirmation },
    });
    fireEvent.click(within(panel).getByRole("button", { name: ENCRYPT_AND_DOWNLOAD_LABEL }));
    return panel;
  }

  it("asks for a passphrase and hands over an encrypted file", async () => {
    const download = vi.fn();
    await sealedCardWithKey(download);

    await choosePassphrase(PASSPHRASE);

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, text] = download.mock.calls[0] as [string, string];
    expect(filename).toBe(reviewKeyFilename(PAPER));
    expect(filename).not.toMatch(/[:/]/);

    // The file is the encrypted envelope: nothing of the review in the clear.
    const envelope = JSON.parse(text);
    expect(envelope.kdf).toMatchObject({ name: "PBKDF2", hash: "SHA-256" });
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(310_000);
    expect(envelope.cipher.name).toBe("AES-GCM");
    expect(text).not.toContain(SEED_BASE64);
    expect(text).not.toContain("private justification");
    expect(text).not.toContain("seed");

    // And it opens, with the passphrase, to this review and this key.
    const opened = await decryptReviewKeyFile(text, PASSPHRASE, FAST_SEAMS.passphrase);
    expect(opened.sealed).toEqual(SEALED);
    expect(opened.key.did).toBe(KEY.did);

    expect(await screen.findByText(/The review key file was saved/)).toBeTruthy();
  });

  it("does not write a file when the two passphrases differ", async () => {
    const download = vi.fn();
    await sealedCardWithKey(download);

    await choosePassphrase(PASSPHRASE, "a different one");

    expect((await screen.findByRole("alert")).textContent).toMatch(/not the same/);
    expect(download).not.toHaveBeenCalled();
  });

  it("does not write a file under a short passphrase", async () => {
    const download = vi.fn();
    await sealedCardWithKey(download);

    await choosePassphrase("short");

    expect((await screen.findByRole("alert")).textContent).toMatch(/at least 8 characters/);
    expect(download).not.toHaveBeenCalled();
  });

  it("is not offered where this browser has no review key to write", async () => {
    saveSealedReview(SEALED);
    renderForm();

    await screen.findByRole("heading", { name: "Your review is sealed" });
    // No key here: it says so and offers the import, not an empty download.
    expect(
      await screen.findByText(/no local secret is available on this device/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: DOWNLOAD_REVIEW_KEY_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: IMPORT_REVIEW_KEY_LABEL })).toBeTruthy();
  });
});

// --------------------------------------------------------------------------- //
// The seed does not rest in localStorage
// --------------------------------------------------------------------------- //

describe("what a commit leaves in localStorage", () => {
  it("is not the review key's seed", async () => {
    const result: ReviewCommitResult = {
      reviewCid: SEALED.reviewCid,
      revealAt: SEALED.revealAt,
      revealBody: SEALED.revealBody,
      record: {
        v: 1,
        type: "review.commit",
        id: SEALED.reviewCid,
        author: KEY.did,
        created: "2026-11-23T00:00:00Z",
        prev: null,
        body: {},
        proofs: [],
        sig: "sig",
      },
      body: {
        target: SEALED.versionCid,
        commitment: SEALED.commitment,
        nullifier: "11",
        reviewKey: KEY.did,
      },
      key: KEY,
    } as unknown as ReviewCommitResult;
    const commit = vi.fn(async () => result);

    renderForm({ initialDraft: completeDraft(), commit });
    fireEvent.click(screen.getByRole("button", { name: COMMIT_LABEL }));
    await screen.findByRole("heading", { name: "Your review is sealed" });

    // The key is kept (so the card can offer the download) ...
    expect((await loadReviewKey(PAPER))?.did).toBe(KEY.did);
    expect(
      await screen.findByRole("button", { name: DOWNLOAD_REVIEW_KEY_LABEL }),
    ).toBeTruthy();
    // ... and no entry anywhere in localStorage holds the seed.
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index) as string;
      expect(name).not.toMatch(/review-key/);
      expect(window.localStorage.getItem(name)).not.toContain(SEED_BASE64);
    }
  });
});
