/**
 * Role journeys (`npm run test:e2e`).
 *
 * The other two specs cover reading, discussion, submitting, `/me` and the
 * session across page loads. These are the *roles*: the moderator deciding on
 * a paper, two reviewers committing and revealing, the author publishing a new
 * version while a reviewer updates, an endorsement and the two author actions
 * that answer a decision (a correction notice and an appeal).
 *
 * Everything runs against the real system — the API with its mocks on, the
 * seeded database, the production build — and every signed record is signed in
 * the browser behind a passkey prompt. The seeded people sign in with their
 * own keys from the demo keys file (`roles-fixtures.ts` builds their device key
 * from the seed the way the browser would have); a newcomer signs in for the
 * first time and gets a key the ordinary way.
 *
 * The journeys build on one another (a paper must be listed before it can be
 * reviewed), so the file runs serially. Nothing here decides on the seeded
 * papers that other specs read: `session.spec.ts` still expects the
 * perpetual-motion paper in the moderation queue.
 */

import {
  AUTHOR,
  AUTHOR_LENA,
  AUTHOR_RAFAEL,
  ENDORSER,
  META_AGENT,
  MODERATOR,
  REVIEWER_A,
  REVIEWER_B,
  acceptConsent,
  cidOf,
  collectPostedRecords,
  createAccount,
  endorse,
  expect,
  fillRubric,
  fromConfig,
  holdPaper,
  listedPaper,
  listPaper,
  newRoleContext,
  openQueueRow,
  pdfWithText,
  postNewVersion,
  signConsentAs,
  signInAs,
  test,
  visit,
  type RoleContext,
} from "./roles-fixtures";

test.describe.configure({ mode: "serial" });

/** What the author/consent journey made, and the next journeys read. */
interface SubmittedPaper {
  readonly title: string;
  readonly versionCid: string;
  shortId?: string;
}

let submitted: SubmittedPaper;

/**
 * The new author's browser profile stays open for the whole file: their device
 * key was created in it by the first sign-in and cannot be copied out, and the
 * later "new version" journey is the same person.
 */
let authorContext: RoleContext | null = null;

/** cid of the first reviewer's revealed review, for the update journey. */
let firstReview: string;

test.afterAll(async () => {
  await authorContext?.context.close();
});

test.describe("the roles", () => {
  test("an endorsed author submits a paper and signs its consent", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const title = `Role journeys preprint ${Date.now()}`;
    authorContext = await newRoleContext(browser);
    const { page, authenticator } = authorContext;

    // A new account is a Reader; a reviewer's endorsement makes it an Author,
    // which is what submitting in cs.AI needs.
    const { did } = await createAccount(page);
    endorse(did, "cs.AI");

    await visit(page, "/submit");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "paper.pdf",
      mimeType: "application/pdf",
      buffer: pdfWithText([title, "A manuscript for the role journeys."]),
    });
    await expect(page.getByText("1 of 1 file uploaded")).toBeVisible();
    await page.getByRole("button", { name: "Continue to Details" }).click();

    await page.getByLabel("Title", { exact: true }).fill(title);
    await page
      .getByLabel("Abstract", { exact: true })
      .fill("A preprint submitted by the role journeys to be read and decided on.");
    await page.getByRole("button", { name: /^cs\.AI/ }).first().click();
    await page.getByRole("button", { name: /^Continue to Authors/ }).click();
    await page.getByRole("button", { name: /^Conceptualization/ }).click();
    await page.getByRole("button", { name: /^Continue to Checks/ }).click();
    await page.getByRole("button", { name: /^Continue to Sign/ }).click();

    // The genesis, manifest and version are each signed behind a passkey.
    const posted = collectPostedRecords(page);
    await page.getByRole("button", { name: "Sign and submit" }).click();

    const tracker = page.getByRole("region", { name: "Status tracker" });
    await expect(tracker).toBeVisible();
    await expect(
      tracker.getByRole("list", { name: "Co-author consents" }),
    ).toBeVisible();

    const versionCid = cidOf(posted, "paper.version");
    if (versionCid === null) {
      throw new Error("the version record cid was not observed");
    }
    expect(cidOf(posted, "paper.genesis")).not.toBeNull();

    // The submitter is a listed author, so the version waits for their own
    // signed consent before it can be scanned and moderated.  A page load
    // restores the session from the refresh cookie.
    await visit(page, `/consent/${versionCid}`);
    await acceptConsent(page);

    submitted = { title, versionCid };
  });

  test("a moderator reads the queue's paper beside the decision form and lists it", async ({
    page,
    authenticator,
    request,
  }) => {
    test.setTimeout(180_000);
    await signInAs(page, authenticator, MODERATOR, { next: "/mod" });
    await openQueueRow(page, { versionCid: submitted.versionCid });

    await expect(
      page.getByRole("heading", { name: "Moderation decision", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: submitted.title }),
    ).toBeVisible();

    // The paper itself: the PDF drawn by the paper page's viewer, and the
    // extracted text, both fetched with the moderator's token.
    await expect(
      page.getByRole("heading", { name: "PDF", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: /^Page 1 of / })).toBeVisible({
      timeout: 30_000,
    });
    const text = page.getByRole("region", { name: "Text of this version" });
    await expect(text).toContainText("A manuscript for the role journeys.");

    // Beside them, the decision form.
    await expect(
      page.getByRole("heading", { name: "Record your decision" }),
    ).toBeVisible();

    const status = await listPaper(
      page,
      "In scope and correctly filed: a conventional preprint for the role journeys.",
    );
    expect(status).toBe(201);
    await expect(
      page.getByRole("heading", { name: "Decision published" }),
    ).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "Listed" })).toBeVisible();

    const paper = await listedPaper(request, submitted.title);
    submitted = { ...submitted, shortId: paper.shortId };
  });

  test("two reviewers commit and reveal; the second reveal opens the reports", async ({
    page,
    authenticator,
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const paper = await listedPaper(request, submitted.title);

    // The first reviewer commits and then asks to reveal.  One committed
    // review is not enough: the form says so and signs nothing.
    await signInAs(page, authenticator, REVIEWER_A, {
      next: `/review/${paper.shortId}`,
    });
    await expect(
      page.getByRole("heading", { name: `Reviewing: ${paper.title} · v1` }),
    ).toBeVisible();
    await fillRubric(page, "First reviewer");
    const firstCommit = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/reviews/commit") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Commit review" }).click();
    expect((await firstCommit).status()).toBe(201);
    await expect(
      page.getByRole("heading", { name: "Your review is sealed" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Reveal review" }).click();
    await expect(
      page.getByText(/The report gate is still closed for this version/),
    ).toBeVisible();

    // The second reviewer, in their own browser profile, commits the review
    // that opens the gate — then reveals.
    const second = await newRoleContext(browser);
    try {
      await signInAs(second.page, second.authenticator, REVIEWER_B, {
        next: `/review/${paper.shortId}`,
      });
      await expect(
        second.page.getByRole("heading", {
          name: `Reviewing: ${paper.title} · v1`,
        }),
      ).toBeVisible();
      await fillRubric(second.page, "Second reviewer");
      const secondCommit = second.page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/reviews/commit") &&
          response.request().method() === "POST",
      );
      await second.page.getByRole("button", { name: "Commit review" }).click();
      expect((await secondCommit).status()).toBe(201);
      await expect(
        second.page.getByRole("heading", { name: "Your review is sealed" }),
      ).toBeVisible();

      const reveal = second.page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/reviews/reveal") &&
          response.request().method() === "POST",
      );
      await second.page.getByRole("button", { name: "Reveal review" }).click();
      expect((await reveal).status()).toBe(201);
      await expect(
        second.page.getByRole("heading", { name: "Your review is revealed" }),
      ).toBeVisible();
    } finally {
      await second.context.close();
    }

    // Now that the gate is open, the first reviewer can reveal too.  Both
    // reports are public after this.
    const firstReveal = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/reviews/reveal") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Reveal review" }).click();
    const revealed = await firstReveal;
    expect(revealed.status()).toBe(201);
    const revealedRecord = (await revealed.json()) as { id?: string };
    if (revealedRecord.id === undefined) {
      throw new Error("the reveal response did not name its record");
    }
    firstReview = revealedRecord.id;
    await expect(
      page.getByRole("heading", { name: "Your review is revealed" }),
    ).toBeVisible();

    // With two committed reviews the gate is open: both reviews are listed
    // and their rubric scores are public.
    await visit(page, `/reviews/${paper.shortId}`);
    await expect(page.getByText(/Version 1 · 2 reviews/)).toBeVisible();
    await expect(
      page.getByText(
        "Report bodies stay sealed until two reviews are committed on this version",
      ),
    ).toHaveCount(0);
    await expect(page.locator(".pr-card")).toHaveCount(2);
    await expect(page.getByText("Minor revisions")).toHaveCount(2);
  });

  test("the author posts a new version and the reviewer updates their review", async ({
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    if (authorContext === null || submitted.shortId === undefined) {
      throw new Error("the submitted paper's journeys did not run");
    }
    const paper = { shortId: submitted.shortId, title: submitted.title };

    // The submitter — the same browser profile that started the paper — posts
    // v2 through the New version form.
    const author = authorContext;
    const v2 = await postNewVersion(
      author.page,
      paper.shortId,
      "Answers the first review and adds the missing baseline.",
      "cs.AI",
    );
    // The submitter is the paper's only author, so their consent is the last.
    await visit(author.page, `/consent/${v2}`);
    await acceptConsent(author.page);

    // A moderator lists v2, so it becomes the version the catalog resolves.
    const moderator = await newRoleContext(browser);
    try {
      await signInAs(moderator.page, moderator.authenticator, MODERATOR, {
        next: "/mod",
      });
      await openQueueRow(moderator.page, { versionCid: v2 });
      expect(
        await listPaper(
          moderator.page,
          "The revision stays in scope and answers the earlier review.",
        ),
      ).toBe(201);
      await expect(
        moderator.page.getByRole("definition").filter({ hasText: "Listed" }),
      ).toBeVisible();
    } finally {
      await moderator.context.close();
    }

    // The reviewer's earlier, revealed review is still on v1.  The Update
    // action opens the form prefilled with it and posts a review.formal whose
    // `prev` names it and whose `target` is v2.
    const reviewer = await newRoleContext(browser);
    try {
      await signInAs(reviewer.page, reviewer.authenticator, REVIEWER_A, {
        next: `/review/${paper.shortId}?prev=${encodeURIComponent(firstReview)}`,
      });
      await expect(
        reviewer.page.getByRole("heading", {
          name: `Reviewing: ${paper.title} · v2`,
        }),
      ).toBeVisible();

      // The form arrives prefilled from the earlier review before it is used.
      const firstJustification = reviewer.page
        .locator("fieldset[data-dimension] textarea")
        .first();
      await expect(firstJustification).not.toHaveValue("");
      await reviewer.page
        .getByRole("group", { name: "Recommendation" })
        .getByRole("radio", { name: "Fundamentally flawed" })
        .check();

      const sent = reviewer.page.waitForResponse(
        (response) =>
          response.url().endsWith("/v1/reviews/reveal") &&
          response.request().method() === "POST",
      );
      await reviewer.page.getByRole("button", { name: "Update review" }).click();
      const answer = await sent;
      expect(answer.status()).toBe(201);
      const body = answer.request().postDataJSON() as {
        prev?: string;
        body?: { target?: string };
      };
      expect(body.prev).toBe(firstReview);
      expect(body.body?.target).toBe(v2);

      // The listing as of v2 carries the revised review, with both revisions
      // in its history.
      await visit(reviewer.page, `/reviews/${paper.shortId}`);
      await expect(reviewer.page.getByText("Fundamentally flawed")).toBeVisible();
    } finally {
      await reviewer.context.close();
    }

    const revised = await request.get(
      `${fromConfig("E2E_API_URL")}/v1/papers/${encodeURIComponent(paper.shortId)}/reviews`,
    );
    expect(revised.ok()).toBe(true);
    const data = (await revised.json()) as {
      reviews: { history?: unknown[]; recommendation?: string; version?: number }[];
    };
    // v2's listing carries the updated review and, marked with the version it
    // targets, the second reviewer's v1 review that was not updated.
    expect(data.reviews).toHaveLength(2);
    const updated = data.reviews.filter((review) => review.version === 2);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.history).toHaveLength(2);
    expect(updated[0]?.recommendation).toBe("fundamentally_flawed");
    expect(data.reviews.filter((review) => review.version === 1)).toHaveLength(1);
  });

  test("a member endorses a newcomer and the newcomer's tier changes", async ({
    page,
    authenticator,
    browser,
  }) => {
    // The newcomer is a second person in their own browser profile: a brand-new
    // account, which the node starts at tier 0.
    const newcomer = await newRoleContext(browser);
    let newcomerDid: string;
    try {
      const created = await createAccount(newcomer.page);
      newcomerDid = created.did;
    } finally {
      await newcomer.context.close();
    }

    // The endorser is a seeded tier-3 reviewer (Dr. Tunde Okafor).  His profile
    // offers the category picker (tier 3 may endorse) and the endorsement is
    // signed with his passkey.
    await signInAs(page, authenticator, ENDORSER);
    await visit(page, `/u/${encodeURIComponent(newcomerDid)}`);

    const profile = page.locator(".pp-fact").filter({ hasText: /^Tier/ }).locator("dd");
    await expect(profile).toHaveText("0");

    const section = page.getByRole("region", { name: "Endorse" });
    await expect(section).toBeVisible();
    await section.getByLabel("Category").selectOption("cs.AI");
    const endorsed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/records") &&
        response.request().method() === "POST" &&
        (response.request().postDataJSON() as { type?: string }).type ===
          "endorsement",
    );
    await section.getByRole("button", { name: "Endorse", exact: true }).click();
    expect((await endorsed).status()).toBe(201);

    await expect(
      page.getByRole("button", { name: "✓ Endorsed in cs.AI" }),
    ).toBeVisible();
    // The page reads the profile back, and the tier the endorsement granted
    // is what it shows.
    await expect(profile).toHaveText("2");
  });

  test("an author issues a correction notice and the banner appears", async ({
    page,
    authenticator,
    request,
  }) => {
    test.setTimeout(120_000);
    const meta = await listedPaper(request, META_AGENT.title);
    await signInAs(page, authenticator, AUTHOR, { next: `/p/${meta.shortId}` });

    const authorActions = page.getByRole("group", { name: "Author actions" });
    await expect(authorActions).toBeVisible();
    await authorActions.getByRole("button", { name: "Issue notice" }).click();

    const dialog = page.getByRole("dialog", { name: "Issue a notice" });
    await expect(dialog).toBeVisible();
    const reason = `Section 2's figure axis was mislabelled (${Date.now()}).`;
    await dialog.getByLabel("Reason").fill(reason);
    const posted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/records") &&
        response.request().method() === "POST" &&
        (response.request().postDataJSON() as { type?: string }).type ===
          "correction",
    );
    await dialog.getByRole("button", { name: "Sign and issue" }).click();
    expect((await posted).status()).toBe(201);
    await expect(
      dialog.getByRole("heading", { name: "Your correction is on record" }),
    ).toBeVisible();

    // A correction travels with every version, so a plain page load shows it.
    await page.reload({ waitUntil: "networkidle" });
    const banner = page.locator('.sch-decision[data-kind="corrected"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Corrected");
    await expect(banner).toContainText(reason);
  });

  test("an author files an appeal on a held paper", async ({
    page,
    authenticator,
    browser,
    request,
  }) => {
    test.setTimeout(240_000);
    const meta = await listedPaper(request, META_AGENT.title);

    // Mei publishes v2 (all three authors consent), and a moderator holds it.
    const author = await newRoleContext(browser);
    let held: string;
    try {
      await signInAs(author.page, author.authenticator, AUTHOR, {
        next: `/submit/new-version/${meta.shortId}`,
      });
      held = await postNewVersion(
        author.page,
        meta.shortId,
        "Revises the evaluation framework after the first review.",
        "cs.AI",
      );
      await visit(author.page, `/consent/${held}`);
      await acceptConsent(author.page);
    } finally {
      await author.context.close();
    }

    for (const slug of [AUTHOR_RAFAEL, AUTHOR_LENA]) {
      const coauthor = await newRoleContext(browser);
      try {
        await signConsentAs(coauthor.page, coauthor.authenticator, slug, held);
      } finally {
        await coauthor.context.close();
      }
    }

    const moderator = await newRoleContext(browser);
    try {
      await signInAs(moderator.page, moderator.authenticator, MODERATOR, {
        next: "/mod",
      });
      await openQueueRow(moderator.page, { versionCid: held });
      expect(
        await holdPaper(
          moderator.page,
          "The revision needs a fuller account of the adversarial baseline.",
        ),
      ).toBe(201);
      await expect(
        moderator.page.getByRole("definition").filter({ hasText: "Held" }),
      ).toBeVisible();
    } finally {
      await moderator.context.close();
    }

    // The held version is not listed, so the paper still resolves to v1: its
    // author can open the paper and answer the decision.
    await signInAs(page, authenticator, AUTHOR, { next: `/p/${meta.shortId}` });
    const authorActions = page.getByRole("group", { name: "Author actions" });
    await expect(authorActions).toBeVisible();

    // The action is offered only once the paper's public records show a hold
    // that has not been appealed.
    const appeal = authorActions.getByRole("button", { name: "File an appeal" });
    await expect(appeal).toBeVisible({ timeout: 30_000 });
    await appeal.click();

    const dialog = page.getByRole("dialog", {
      name: "Appeal the moderation decision",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("held this paper from listing");

    const grounds = `The baseline is described in Section 2 (${Date.now()}).`;
    await dialog.getByLabel("Grounds for appeal").fill(grounds);
    const filed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/appeals") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Sign and file appeal" }).click();
    expect((await filed).status()).toBe(201);
    await expect(
      dialog.getByRole("heading", { name: "Your appeal is filed" }),
    ).toBeVisible();
  });
});
