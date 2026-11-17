/**
 * Session journeys (`npm run test:e2e`).
 *
 * These are the reload / full-page-navigation complements to `journeys.spec.ts`.
 * The access token lives in memory only; the HttpOnly refresh cookie is what
 * lets a page load restore it.  Every journey here therefore crosses a real
 * page load and then checks that the user is *still* signed in:
 *
 * - reload `/me`,
 * - come back from ORCID (a whole-page redirect to another origin and back),
 * - follow a moderation-queue row (a plain `<a href>`, not a soft navigation),
 * - sign out from the global nav and stay signed out.
 *
 * The same production build, virtual passkey and seeded node as
 * `journeys.spec.ts` are used; see `playwright.config.ts`.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import { expect, test as base, type Page } from "@playwright/test";

/** The seeded paper that is waiting in the moderation queue. */
const QUEUED_TITLE = "A Perpetual-Motion Optimizer That Needs No Gradient";

/**
 * The shape of a valid ORCID iD. The mock consent screen generates a fresh one
 * for every sign-in (so two newcomers never try to link the same iD), which is
 * why the journey reads the offered value instead of naming a constant.
 */
const ORCID_SHAPE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

// --- Wiring from playwright.config.ts ---------------------------------------

function fromConfig(name: "E2E_API_URL" | "E2E_API_DIR" | "E2E_DEMO_KEYS"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: run these journeys through playwright.config.ts (npm run test:e2e)`,
    );
  }
  return value;
}

// --- Fixtures ----------------------------------------------------------------

const test = base.extend<{ passkeys: void }>({
  /**
   * A virtual authenticator on the page: a platform passkey that has a
   * resident credential, verifies the user and is always "touched".
   */
  passkeys: [
    async ({ context, page }, use) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await use();
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await cdp.send("WebAuthn.disable");
    },
    { auto: false },
  ],
});

// --- Helpers -----------------------------------------------------------------

/**
 * Open a page and wait until it has hydrated, so the session bootstrap has
 * finished and the first click lands on a live handler.
 */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
}

/**
 * Press "Sign in with passkey" on `/signin`.  Resolves with the DID as the
 * challenge request named it (the device key's did:key), once verify answered.
 */
async function signInWithPasskey(page: Page): Promise<{ did: string }> {
  const challenge = page.waitForRequest((request) =>
    request.url().endsWith("/v1/auth/challenge"),
  );
  const verified = page.waitForResponse((response) =>
    response.url().endsWith("/v1/auth/verify"),
  );
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  const { did } = (await challenge).postDataJSON() as { did: string };
  const issued = await verified;
  expect(issued.status()).toBe(200);
  return { did };
}

/** A first sign-in on this device creates the passkey and the account. */
async function createAccount(page: Page): Promise<string> {
  await visit(page, "/signin");
  const { did } = await signInWithPasskey(page);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  return did;
}

/**
 * Make the account a moderator the way an operator would.  The CLI writes to
 * the same throw-away SQLite database the API server is using; the next
 * refresh issues a token carrying the new tier.
 */
function setTier(did: string, tier: string): void {
  const dataDir = dirname(fromConfig("E2E_DEMO_KEYS"));
  execFileSync(
    "uv",
    ["run", "--all-packages", "python", "-m", "app.modules.admin", "set-tier", did, tier],
    {
      cwd: fromConfig("E2E_API_DIR"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: `sqlite:///${join(dataDir, "scholium.db")}`,
      },
    },
  );
}

// --- Journeys ----------------------------------------------------------------

test.describe("the session survives a page load", () => {
  test("reloading /me keeps the member signed in", async ({ page, passkeys }) => {
    void passkeys;
    await createAccount(page);

    await visit(page, "/me");
    await expect(page.getByRole("heading", { name: "Me", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Me", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);
  });

  test("ORCID linking completes after the full-page return", async ({ page, passkeys }) => {
    void passkeys;
    await createAccount(page);

    // ORCID is a real full-page navigation away from the app.  With
    // `ORCID_MOCK=1` the API serves a stand-in consent screen for the test iD;
    // approving it redirects back with a `mock-<orcid>` code and the signed
    // state the API issued to this session.
    await page.getByRole("button", { name: "Link your ORCID iD" }).click();
    await expect(page.getByRole("heading", { name: "Scholium wants to sign you in" })).toBeVisible();
    // Accept the iD the mock generated for this sign-in.
    const offeredOrcid = await page.getByLabel("ORCID iD").inputValue();
    expect(offeredOrcid).toMatch(ORCID_SHAPE);

    await page.getByRole("button", { name: "Authorize" }).click();

    await expect(page).toHaveURL(/\/onboarding\/orcid\?/);
    await expect(page.getByRole("heading", { name: "ORCID iD linked" })).toBeVisible();
    await expect(page.getByText(offeredOrcid, { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue setting up" })).toBeVisible();

    // Coming back from the other origin must not cost the session: the
    // checklist is still signed in, and skipping it keeps the member signed in
    // on /me.
    await page.getByRole("link", { name: "Continue setting up" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.getByRole("link", { name: "Skip for now" }).click();
    await expect(page).toHaveURL(/\/$/);

    await visit(page, "/me");
    await expect(page.getByRole("heading", { name: "Me", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);
  });

  test("coming back from ORCID without linking, then skipping, keeps the session", async ({
    page,
    passkeys,
  }) => {
    void passkeys;
    await createAccount(page);

    // The reported journey: go to the ORCID step, come back without linking,
    // then skip onboarding. The full-page round trip must not cost the
    // session, and /me must still be the member's dashboard.
    await page.getByRole("button", { name: "Link your ORCID iD" }).click();
    await expect(page.getByRole("heading", { name: "Scholium wants to sign you in" })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();

    await expect(page).toHaveURL(/\/onboarding\/orcid\?/);
    await expect(
      page.getByRole("heading", { name: "We couldn't link your ORCID iD" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to setup" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);

    await page.getByRole("link", { name: "Skip for now" }).click();
    await expect(page).toHaveURL(/\/$/);

    await visit(page, "/me");
    await expect(page.getByRole("heading", { name: "Me", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);
  });

  test("a moderator follows a queue row and stays signed in", async ({ page, passkeys }) => {
    void passkeys;
    const did = await createAccount(page);
    setTier(did, "moderator");

    // The page load refreshes the access token with the new tier.
    await visit(page, "/mod");
    const queue = page.getByRole("region", { name: "Moderation queue" });
    await expect(queue).toBeVisible();

    // The title is a plain <a href> — a full document load.
    await queue.getByRole("link", { name: QUEUED_TITLE }).click();
    await expect(page).toHaveURL(/\/mod\/.+/);
    await expect(
      page.getByRole("heading", { name: "Moderation decision", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "Moderation decision", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toHaveCount(0);
  });

  test("a member signs out from the global nav and stays signed out", async ({
    page,
    passkeys,
  }) => {
    void passkeys;
    await createAccount(page);

    await visit(page, "/me");
    await expect(page.getByRole("heading", { name: "Me", level: 1 })).toBeVisible();

    const revoked = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/auth/logout") &&
        response.request().method() === "POST",
    );
    await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();

    expect((await revoked).status()).toBe(204);
    await expect(page).toHaveURL(/\/$/);

    // A later page load must not restore the session: the server revoked the
    // refresh token and the browser dropped the cookie.  A protected page
    // sends the signed-out visitor to sign-in rather than offering actions
    // that would 401.
    await visit(page, "/me");
    await expect(page).toHaveURL(/\/signin\?next=%2Fme$/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  });
});
