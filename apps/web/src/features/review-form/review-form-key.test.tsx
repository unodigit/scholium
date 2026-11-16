// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewCommitResult } from "./commit";
import { parseMyReviews, type LoadMyReviews } from "./my-reviews";
import { PBKDF2_MIN_ITERATIONS } from "./passphrase-box";
import {
  COMMIT_LABEL,
  ReviewForm,
  SEALED_ELSEWHERE_HEADLINE,
  SEALED_ELSEWHERE_TEXT,
} from "./review-form";
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

  it("keeps the Commit form when the reviewer has no sealed review of this paper", async () => {
    const loadOwnReviews = dashboard(
      mine({ shortId: OTHER_PAPER }),
      mine({ state: "revealed", sealed: false, revealed: true }),
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

  it("is not shown, and the API not asked, when this browser has the sealed review", async () => {
    saveSealedReview(SEALED);
    const loadOwnReviews = dashboard(mine());

    renderForm({ loadOwnReviews });

    expect(await screen.findByRole("heading", { name: "Your review is sealed" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: SEALED_ELSEWHERE_HEADLINE })).toBeNull();
    expect(loadOwnReviews).not.toHaveBeenCalled();
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
