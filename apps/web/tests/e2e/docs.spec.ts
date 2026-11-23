/**
 * The handbook journeys (`npm run test:e2e`).
 *
 * These run against the shipped system that `playwright.config.ts` starts: a
 * production build of the web app over a seeded node. The chapter pages are
 * statically generated from `docs/handbook/`, so what is checked here is the
 * whole promise of the docs: search finds a chapter section, a chapter shows
 * its summary, its video block, its own screenshots and heading list, links
 * between chapters land on the right anchor, nothing is fetched from YouTube
 * until a reader asks for a video, and the page never scrolls sideways on a
 * phone.
 */

import { expect, test, type Page } from "@playwright/test";

/** The hosts a chapter video may only ever contact after a click. */
const YOUTUBE_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
];

/** True when `hostname` is YouTube or one of its subdomains. */
function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

/** Every request the page makes to YouTube, recorded as it happens. */
function recordYouTubeRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    let hostname: string;
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      return;
    }
    if (isYouTubeHost(hostname)) requests.push(request.url());
  });
  return requests;
}

/**
 * The docs search field. The global nav has a paper search too, so the field
 * is found by its own label, never by "the first search box on the page".
 */
function searchField(page: Page) {
  return page.getByRole("searchbox", { name: "Search the docs" });
}

test.describe("docs", () => {
  test("searching /docs for a phrase finds the chapter section", async ({
    page,
  }) => {
    await page.goto("/docs", { waitUntil: "networkidle" });

    const search = searchField(page);
    await expect(search).toBeVisible();
    await search.fill("passkey");

    // The result points at the section in Chapter 2. (A "Start here" card also
    // links that anchor, as "2", so the result is found by its own name.)
    const result = page.getByRole("link", {
      name: "Sign in with a passkey",
      exact: true,
    });
    await expect(result).toBeVisible();
    await result.click();

    await expect(page).toHaveURL(
      /\/docs\/your-account#sign-in-with-a-passkey$/,
    );
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Sign in with a passkey",
        exact: true,
      }),
    ).toBeInViewport();
  });

  test("a chapter shows its video block, a screenshot and On this page", async ({
    page,
  }) => {
    await page.goto("/docs/your-account", { waitUntil: "networkidle" });

    await expect(
      page.getByRole("heading", { level: 1, name: "Your account" }),
    ).toBeVisible();
    await expect(page.getByText("Chapter 2")).toBeVisible();

    // The video block: the chapter's own poster, held behind a click, and the
    // transcript that makes the chapter usable without playing anything.
    const video = page.locator(".chapter-video");
    await video.scrollIntoViewIfNeeded();
    await expect(video).toBeVisible();
    await expect(video.locator("img")).toHaveAttribute(
      "src",
      /\/docs\/posters\/ch02-your-account\.webp$/,
    );
    await expect(video.getByText("Read the transcript")).toBeVisible();

    // A curated screenshot, found by the alt text written for it.
    const screenshot = page.getByAltText(
      "The sign-in page, with the Sign in with passkey button and the Recover your account link",
    );
    await screenshot.scrollIntoViewIfNeeded();
    await expect(screenshot).toBeVisible();
    await expect(screenshot).toHaveAttribute(
      "src",
      /\/docs\/screenshots\/ch02-passkey-sign-in\.webp$/,
    );

    // "On this page" lists the chapter's sections, including this one.
    const contents = page.getByRole("navigation", { name: "On this page" });
    await expect(
      contents.getByRole("heading", { level: 2, name: "On this page" }),
    ).toBeVisible();
    await expect(
      contents.getByRole("link", {
        name: "Sign in with a passkey",
        exact: true,
      }),
    ).toHaveAttribute("href", "#sign-in-with-a-passkey");
    const trustTiers = contents.getByRole("link", {
      name: "Trust tiers",
      exact: true,
    });
    await expect(trustTiers).toHaveAttribute("href", "#trust-tiers");

    // Scrolling a section into the reading band marks its entry, so the list
    // shows where the reader is.
    await page.evaluate(() => {
      const section = document.getElementById("trust-tiers");
      if (section === null) return;
      const top = section.getBoundingClientRect().top + window.scrollY - 200;
      window.scrollTo(0, top);
    });
    await expect(trustTiers).toHaveAttribute("aria-current", "location");
  });

  test("a cross-chapter link lands on the right anchor", async ({ page }) => {
    await page.goto("/docs/reading-and-finding-papers", {
      waitUntil: "networkidle",
    });

    await page
      .getByRole("link", { name: "exactly how status is worked out" })
      .click();

    await expect(page).toHaveURL(
      /\/docs\/reviewing-a-paper#how-paper-status-is-decided$/,
    );
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "How paper status is decided",
        exact: true,
      }),
    ).toBeInViewport();
  });

  test("browsing the docs never contacts YouTube", async ({ page }) => {
    const youtubeRequests = recordYouTubeRequests(page);

    for (const path of [
      "/docs",
      "/docs/how-scholium-works",
      "/docs/your-account",
      "/docs/reading-and-finding-papers",
    ]) {
      await page.goto(path, { waitUntil: "networkidle" });
    }

    // Reading the transcript is still within the chapter's own page: nothing
    // of the player is embedded until its button is pressed.
    await page.goto("/docs/your-account", { waitUntil: "networkidle" });
    await page.getByText("Read the transcript").click();
    await page.waitForTimeout(1000);

    expect(youtubeRequests).toEqual([]);
  });

  test("a chapter does not scroll sideways on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    for (const path of [
      "/docs",
      "/docs/your-account",
      "/docs/reading-and-finding-papers",
    ]) {
      await page.goto(path, { waitUntil: "networkidle" });

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
    }
  });
});
