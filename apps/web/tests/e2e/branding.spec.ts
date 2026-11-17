/**
 * Brand journeys (`npm run test:e2e`).
 *
 * The deliverable of the branding work is what a person and a crawler see:
 * the delivered icon in the tab and on a home screen, the lockup in the
 * header and on the entry screens, the fallback screens, a share card for a
 * paper, and a branded notification email. Every check here runs against the
 * shipped system — the production build of the web app and `python -m app`,
 * both started by `playwright.config.ts` over a seeded node — rather than a
 * test-only assembly, so a missing wiring step (a stale icon copy, a layout
 * that does not compose, a manifest Next never links) fails the run.
 *
 * Two facts drive the shapes below:
 *
 * - The delivered files in `docs/brand` are the source of truth. The favicon,
 *   the Apple touch icon, the SVG and the PNG renditions are compared byte for
 *   byte with what the running server returns, so the check is about what
 *   ships, not about what the repository is expected to contain.
 * - The notification email travels the real path: the API hands it to SMTP
 *   and the sink in `mail-sink.mjs` captures exactly the message a mail client
 *   would receive, HTML alternative included.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import {
  MODERATOR,
  createAccount,
  expect,
  fromConfig,
  newRoleContext,
  signInAs,
  test,
} from "./roles-fixtures";

// --- What the seed puts on the node -----------------------------------------

/** A listed paper from `seed-demo`; its share card draws a real title. */
const META_AGENT_TITLE = "Can a Meta-Agent Choose the Safer Branch?";
/** Waiting in the moderation queue: its title must never reach a share card. */
const UNLISTED_TITLE = "A Perpetual-Motion Optimizer That Needs No Gradient";

const BRAND_TAGLINE = "Signed, open preprints and peer review";

// --- The delivered brand assets ---------------------------------------------

/** Read a delivered file from `docs/brand`, the source of truth. */
function delivered(name: string): Buffer {
  return readFileSync(
    fileURLToPath(new URL(`../../../../docs/brand/${name}`, import.meta.url)),
  );
}

/** Width and height from a PNG's IHDR chunk (bytes 16–23). */
function pngSize(buffer: Buffer): { width: number; height: number } {
  const signature = buffer.subarray(0, 8).toString("hex");
  expect(signature, "not a PNG").toBe("89504e470d0a1a0a");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Assert `response` is the 1200x630 PNG the share cards are drawn at. */
async function expectShareCard(response: APIResponse): Promise<Buffer> {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  const body = await response.body();
  expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
  return body;
}

/** The mailbox the config points the API's `SMTP_URL` at. */
function mailUrl(): string {
  const value = process.env.E2E_MAIL_URL;
  if (!value) {
    throw new Error(
      "E2E_MAIL_URL is not set: run these journeys through playwright.config.ts (npm run test:e2e)",
    );
  }
  return value;
}

// --- Reading a captured MIME message ----------------------------------------

interface CapturedMail {
  readonly from: string;
  readonly to: string[];
  readonly raw: string;
}

interface MimePart {
  readonly headers: Map<string, string>;
  readonly body: string;
}

/** Split a message (or a part) into its unfolded headers and its body. */
function headerBlock(raw: string): MimePart {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  return { headers, body };
}

/** Undo whatever transfer encoding a part carries; the template writes ASCII. */
function decodeBody(part: MimePart): string {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(part.body.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (encoding === "quoted-printable") {
    return part.body
      .replace(/=\r\n/g, "")
      .replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }
  return part.body;
}

/** The parts of a `multipart/alternative` message, decoded. */
function alternatives(raw: string): MimePart[] {
  const message = headerBlock(raw);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(
    message.headers.get("content-type") ?? "",
  )?.[1];
  if (!boundary) {
    return [{ ...message, body: decodeBody(message) }];
  }

  const parts: MimePart[] = [];
  for (const section of message.body.split(`--${boundary}`).slice(1)) {
    if (section.startsWith("--")) {
      break;
    }
    const part = headerBlock(section.replace(/^\r\n/, ""));
    if (part.headers.size === 0) {
      continue;
    }
    parts.push({ ...part, body: decodeBody(part) });
  }
  return parts;
}

/** The captured messages addressed to `address`, oldest first. */
async function mailTo(
  request: APIRequestContext,
  address: string,
): Promise<CapturedMail[]> {
  const response = await request.get(
    `${mailUrl()}/messages?to=${encodeURIComponent(address)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as CapturedMail[];
}

// --- The delivered favicon set ----------------------------------------------

test.describe("the delivered icon set", () => {
  test("the tab, bookmark and home-screen icons are the delivered files", async ({
    request,
  }) => {
    const svg = await request.get("/icon.svg");
    expect(svg.status()).toBe(200);
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    expect((await svg.body()).equals(delivered("scholium-favicon.svg"))).toBe(true);

    const ico = await request.get("/favicon.ico");
    expect(ico.status()).toBe(200);
    expect((await ico.body()).equals(delivered("favicon.ico"))).toBe(true);

    const apple = await request.get("/apple-icon.png");
    expect(apple.status()).toBe(200);
    expect(apple.headers()["content-type"]).toBe("image/png");
    expect((await apple.body()).equals(delivered("apple-touch-icon.png"))).toBe(true);
  });

  test("the web manifest names the app and points at the brand PNGs", async ({
    request,
  }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/manifest+json");

    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      description: string;
      start_url: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };

    expect(manifest).toMatchObject({
      name: "Scholium",
      short_name: "scholium",
      description: BRAND_TAGLINE,
      start_url: "/",
      display: "standalone",
      background_color: "#FBFAF7",
      theme_color: "#2F4BA0",
    });

    const purposes = new Map<string, string | undefined>();
    for (const icon of manifest.icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()["content-type"], icon.src).toBe("image/png");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(await iconResponse.body()), icon.src).toEqual({ width, height });
      purposes.set(icon.src, icon.purpose);
    }
    expect([...purposes.keys()]).toEqual([
      "/brand/icon-192.png",
      "/brand/icon-512.png",
      "/brand/icon-maskable-512.png",
    ]);
    expect(purposes.get("/brand/icon-maskable-512.png")).toBe("maskable");
  });

  test("every page links the icons and the manifest, and names itself once", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // The root template composes the page name exactly once ("Home · Scholium",
    // never "Home · Scholium · Scholium").
    await expect(page).toHaveTitle("Home · Scholium");

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      "href",
      /\/icon\.svg/,
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      /\/apple-icon\.png/,
    );
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
    await expect(
      page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]'),
    ).toHaveAttribute("content", "#FBFAF7");
    await expect(
      page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]'),
    ).toHaveAttribute("content", "#14151A");
  });
});

// --- The lockup in the global navigation ------------------------------------

test.describe("the brand lockup in the navigation", () => {
  test("the desktop header shows the logo link, not a bare wordmark", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const home = page.getByRole("link", { name: "Scholium home" });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("href", "/");

    // The lockup is the glyph (accent page, text lines, margin note, bracket)
    // plus the lowercase serif wordmark.
    await expect(home.locator(".sch-brand-logo")).toBeVisible();
    await expect(home.locator('.sch-brand-logo svg[data-variant="glyph"]')).toBeVisible();
    await expect(home.locator(".sch-brand-logo__wordmark")).toHaveText("scholium");

    // Keyboard focus draws the 2px accent ring the brand spec asks for.
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          const ring =
            active === null ? null : getComputedStyle(active as Element);
          return {
            className: active instanceof HTMLElement ? active.className : "",
            width: ring?.outlineWidth ?? "",
            style: ring?.outlineStyle ?? "",
            color: ring?.outlineColor ?? "",
          };
        }),
      )
      .toMatchObject({ className: "gn-brand", width: "2px", style: "solid" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.activeElement as Element).outlineColor,
        ),
      )
      .toBe("rgb(47, 75, 160)");
  });

  test("phone widths show the tile mark in the bottom bar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "networkidle" });

    // The header (and its wordmark) is for `sm` and up; the bottom bar is for
    // phones and its Home tab carries the tile where the wordmark cannot fit.
    // The classes are asserted as well as the bar, because Tailwind's scanner
    // skips a checkout under a .gitignored path (see src/styles/README.md), so
    // a worktree build has the markup but not the utilities.
    await expect(page.locator(".gn-header")).toHaveClass(/(?:^|\s)hidden(?:\s|$)/);
    await expect(page.locator(".gn-header")).toHaveClass(/(?:^|\s)sm:flex(?:\s|$)/);
    await expect(page.locator(".gn-tabbar")).toHaveClass(/(?:^|\s)flex(?:\s|$)/);
    await expect(page.locator(".gn-tabbar")).toHaveClass(/(?:^|\s)sm:hidden(?:\s|$)/);

    const bar = page.getByRole("navigation", { name: "Primary" });
    await expect(bar).toBeVisible();
    const tile = bar.locator(".gn-tab-brand");
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute("data-variant", "tile");
    await expect(tile).toHaveCSS("height", "24px");
  });
});

// --- The branded entry and fallback screens ---------------------------------

test.describe("the branded entry and fallback screens", () => {
  test("the sign-in screen shows the lockup and the tagline", async ({ page }) => {
    await page.goto("/signin", { waitUntil: "networkidle" });

    await expect(page).toHaveTitle("Sign in · Scholium");
    const brand = page.locator(".wa-brand");
    await expect(brand).toBeVisible();
    await expect(brand.getByRole("img", { name: "Scholium" })).toBeVisible();
    await expect(brand.locator(".sch-brand-logo__wordmark")).toHaveText("scholium");
    await expect(brand.locator(".sch-brand-logo")).toHaveCSS("height", "48px");
    await expect(page.locator(".wa-tagline")).toHaveText(BRAND_TAGLINE);
  });

  test("dark mode re-themes the lockup from the design tokens", async ({ page }) => {
    const colours = () =>
      page.evaluate(() => {
        const pageBlock = document.querySelector(
          ".sch-brand-logo__mark svg rect",
        ) as SVGRectElement | null;
        const wordmark = document.querySelector(
          ".sch-brand-logo__wordmark",
        ) as HTMLElement | null;
        return {
          accent: pageBlock === null ? "" : getComputedStyle(pageBlock).fill,
          ink: wordmark === null ? "" : getComputedStyle(wordmark).color,
        };
      });

    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/signin", { waitUntil: "networkidle" });
    expect(await colours()).toEqual({
      accent: "rgb(47, 75, 160)",
      ink: "rgb(27, 29, 34)",
    });

    await page.emulateMedia({ colorScheme: "dark" });
    expect(await colours()).toEqual({
      accent: "rgb(143, 166, 240)",
      ink: "rgb(236, 235, 230)",
    });
  });

  test("an unknown address renders the branded not-found screen", async ({ page }) => {
    await page.goto(`/no-such-page-${Date.now()}`, { waitUntil: "networkidle" });

    await expect(page).toHaveTitle("Scholium");
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page." }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: "Scholium" })).toBeVisible();

    const home = page.getByRole("link", { name: "Home", exact: true });
    await expect(home).toBeVisible();
    await expect(page.getByRole("link", { name: "Search" })).toBeVisible();

    await home.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page).toHaveTitle("Home · Scholium");
  });
});

// --- The social share cards -------------------------------------------------

test.describe("the branded share cards", () => {
  test("the site card is a 1200x630 PNG linked from the page metadata", async ({
    page,
    request,
  }) => {
    const siteCard = await expectShareCard(await request.get("/opengraph-image"));
    expect(siteCard.length).toBeGreaterThan(1_000);
    await expectShareCard(await request.get("/twitter-image"));

    await page.goto("/", { waitUntil: "networkidle" });
    const image = page.locator('meta[property="og:image"]');
    await expect(image).toHaveAttribute("content", /\/opengraph-image/);
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
      "content",
      "1200",
    );
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute(
      "content",
      "630",
    );
    await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute(
      "content",
      "image/png",
    );
    // `<meta>` carries its value in an attribute: the card names the wordmark
    // and the tagline so a screen reader and a crawler read the same sentence.
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
      "content",
      `scholium: ${BRAND_TAGLINE}`,
    );
  });

  test("a listed paper gets a card with its own title", async ({ page, request }) => {
    const catalog = await request.get(`${fromConfig("E2E_API_URL")}/v1/papers?limit=100`);
    expect(catalog.ok()).toBe(true);
    const { items } = (await catalog.json()) as {
      items: { shortId: string; title: string }[];
    };
    const paper = items.find((item) => item.title === META_AGENT_TITLE);
    expect(paper, `no listed paper titled ${META_AGENT_TITLE}`).toBeDefined();

    const siteCard = await (await request.get("/opengraph-image")).body();
    const paperCard = await expectShareCard(
      await request.get(`/p/${paper!.shortId}/opengraph-image`),
    );
    // The title, authors and sch: id are drawn, so this is not the site card.
    expect(paperCard.equals(siteCard)).toBe(false);

    // The paper page advertises that card. Next hashes the metadata file's
    // name inside the route group, so the advertised address is not the plain
    // one; both must draw the same card.
    await page.goto(`/p/${paper!.shortId}`, { waitUntil: "networkidle" });
    await expect(page).toHaveTitle(new RegExp(`^${escapeRegExp(paper!.title)}`));
    const advertised = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content");
    const advertisedPath = new URL(advertised ?? "").pathname;
    expect(advertisedPath).toContain("/p/");
    expect(advertisedPath).toContain("/opengraph-image");
    const advertisedCard = await expectShareCard(await request.get(advertisedPath));
    expect(advertisedCard.equals(paperCard)).toBe(true);
  });

  test("an unlisted paper's card is the site card, so its title cannot leak", async ({
    browser,
    request,
  }) => {
    // Only a moderator can see the queue, and the card must not need one.
    const moderator = await newRoleContext(browser);
    let shortId: string | null = null;
    try {
      const { accessToken } = await signInAs(
        moderator.page,
        moderator.authenticator,
        MODERATOR,
      );
      const queue = await moderator.page.request.get(
        `${fromConfig("E2E_API_URL")}/v1/moderation/queue`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      expect(queue.ok(), await queue.text()).toBe(true);
      const entries = (await queue.json()) as { title: string; short_id: string | null }[];
      const unlisted = entries.find((entry) => entry.title === UNLISTED_TITLE);
      expect(unlisted, `the queued paper ${UNLISTED_TITLE} is missing`).toBeDefined();
      shortId = unlisted!.short_id;
      expect(shortId, "the queued paper has no short id to address its card").not.toBeNull();
    } finally {
      await moderator.context.close();
    }

    const siteCard = await (await request.get("/opengraph-image")).body();
    const unlistedCard = await expectShareCard(
      await request.get(`/p/${shortId!}/opengraph-image`),
    );
    expect(unlistedCard.equals(siteCard)).toBe(true);

    // The same fallback answers a paper the node does not know at all.
    const unknown = await expectShareCard(
      await request.get(`/p/sch:unknown-0000-0000/opengraph-image`),
    );
    expect(unknown.equals(siteCard)).toBe(true);
  });
});

// --- The branded notification email -----------------------------------------

test.describe("the branded notification email", () => {
  test("saving a profile sends the branded HTML and the unchanged plain text", async ({
    page,
    authenticator,
    request,
  }) => {
    const address = `brand-journey-${Date.now()}@example.org`;
    const { did } = await createAccount(page);

    await page.getByLabel("Display name").fill("Brand Journey");
    await page.getByLabel("Affiliation (optional)").fill("Scholium E2E");
    await page.getByLabel("Email", { exact: true }).fill(address);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(
      page.getByText("Saved as Brand Journey.", { exact: false }),
    ).toBeVisible();

    // The API sends the verification mail while handling the save.
    await expect
      .poll(async () => (await mailTo(request, address)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const [mail] = await mailTo(request, address);
    expect(mail.to).toContain(address);
    expect(mail.raw).toContain("Subject: [Scholium] email.verify");

    const parts = alternatives(mail.raw);
    const plain = parts.find((part) =>
      (part.headers.get("content-type") ?? "").startsWith("text/plain"),
    );
    const html = parts.find((part) =>
      (part.headers.get("content-type") ?? "").startsWith("text/html"),
    );
    expect(plain, "the plain-text part is missing").toBeDefined();
    expect(html, "the HTML alternative is missing").toBeDefined();

    // The plain text is the body notifications have always carried.
    expect(plain!.body).toContain(`Notification for ${did}`);
    expect(plain!.body).toContain("Kind: email.verify");
    expect(plain!.body).toContain("Open: http://localhost:3100/verify-email?did=");

    // The HTML alternative is the branded one: paper, a white card, the lockup
    // whose icon is the delivered PNG on the web origin, an accent button and
    // the settings footer.
    const markup = html!.body;
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<table");
    expect(markup).toContain('alt="Scholium"');
    expect(markup).toContain('src="http://localhost:3100/brand/icon-192.png"');
    expect(markup).toContain("scholium");
    expect(markup).toContain("max-width:600px");
    expect(markup).toContain("#FBFAF7");
    expect(markup).toContain("#1B1D22");
    expect(markup).toContain("#2F4BA0");
    expect(markup).toContain('href="http://localhost:3100/verify-email?did=');
    expect(markup).toContain('href="http://localhost:3100/me#notifications"');

    // The logo the email points at is served by the shipped web app.
    const icon = await request.get("http://localhost:3100/brand/icon-192.png");
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toBe("image/png");
    expect(pngSize(await icon.body())).toEqual({ width: 192, height: 192 });
  });
});

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
