/**
 * Homepage journeys (`npm run test:e2e`).
 *
 * The homepage is the public front door at `/`: a prerendered page with its own
 * navigation bar, its animations, its structured data and the crawler surfaces
 * beside it (`robots.txt`, `sitemap.xml`, `llms.txt`). Every check here runs
 * against the shipped system (the production build of the web app and
 * `python -m app` over a seeded node, both started by `playwright.config.ts`),
 * because the things that go wrong are the ones a unit test cannot see: a
 * stylesheet that never loads, an animation that is armed and never released, a
 * request the page makes that it should not.
 *
 * Two facts shape the helpers below:
 *
 * - Playwright's `toBeVisible` ignores `opacity` and `transform`, and the
 *   homepage hides its animated pieces with exactly those (under
 *   `html[data-home-js]`). "Visible" in these journeys therefore also means
 *   painted: full opacity, and not still translated behind its mask.
 * - The page is prerendered, so its server HTML is what a crawler and a visitor
 *   without JavaScript get. Those journeys read the first response itself.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { META_AGENT, fromConfig, listedPaper, visit } from "./roles-fixtures";

// --- What the seed puts on the node, and what the page says ------------------

const CALIBRATION_TITLE = "Reward Model Calibration Under Distribution Shift";
/** Waiting in the moderation queue, so it must not be on the feed. */
const UNLISTED_TITLE = "A Perpetual-Motion Optimizer That Needs No Gradient";

const HEADLINE = ["The preprint, signed.", "The review, open.", "The record, kept."];

/** The HTML document for `/` must stay under this many bytes, uncompressed. */
const HTML_BUDGET_BYTES = 150 * 1024;

// --- Helpers -----------------------------------------------------------------

/** What a reader sees of an element: its own opacity times that of every ancestor. */
function paintedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  });
}

/** True when the element is not moved by a transform (none, or the identity). */
function isUntransformed(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).isIdentity);
}

/**
 * The element is fully painted and in place: opaque, untransformed and visible.
 * Polls, because the entrance animations take a second or two to finish.
 */
async function expectPainted(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(() => paintedOpacity(locator), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => isUntransformed(locator), { timeout: 10_000 }).toBe(true);
}

/** The JSON-LD blocks in the document, parsed. */
async function jsonLdBlocks(page: Page): Promise<Record<string, unknown>[]> {
  const texts = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
  return texts.map((text) => JSON.parse(text) as Record<string, unknown>);
}

/** Every `@graph` node of one document, or the document itself when it has none. */
function graphOf(block: Record<string, unknown>): Record<string, unknown>[] {
  return (block["@graph"] as Record<string, unknown>[] | undefined) ?? [block];
}

/** Every string in a JSON value. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

/** The FAQ as a reader sees it: each question with its answer. */
function visibleFaq(page: Page): Promise<{ question: string; answer: string }[]> {
  return page.locator("#faq .faq details").evaluateAll((entries) =>
    entries.map((entry) => ({
      question: entry.querySelector("summary h3")?.textContent?.trim() ?? "",
      answer: entry.querySelector(".ans p")?.textContent?.trim() ?? "",
    })),
  );
}

// --- The headline, the calls to action and the way to the feed ---------------

test.describe("the homepage at /", () => {
  test("displays the headline lines and both calls to action", async ({ page }) => {
    await visit(page, "/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("h1 .line")).toHaveText(HEADLINE);
    // Painted, not merely in the markup: the lines rise from behind a mask.
    for (const line of await page.locator("h1 .line > span").all()) await expectPainted(line);

    const hero = page.locator("#top");
    const submit = hero.getByRole("link", { name: "Submit a paper" });
    const browse = hero.getByRole("link", { name: "Browse papers" });
    await expect(submit).toHaveAttribute("href", "/submit");
    await expect(browse).toHaveAttribute("href", "/papers");
    await expectPainted(submit);
    await expectPainted(browse);
  });

  test("shows the home bar and no global navigation or mobile tab bar", async ({ page }) => {
    await visit(page, "/");

    const bar = page.locator("header#nav");
    await expect(bar.getByRole("link", { name: "Scholium, back to top" })).toHaveAttribute(
      "href",
      "#top",
    );
    // Signed out: the server's actions, which the browser swaps only once it has a session.
    await expect(bar.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    await expect(bar.getByRole("link", { name: "Submit a paper" })).toHaveAttribute("href", "/submit");
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(page.locator(".gn-brand, .gn-tabbar-spacer")).toHaveCount(0);
    await expect(page.locator("main#main")).toHaveCount(1);
  });

  test("following Browse papers lands on /papers with the seeded papers listed", async ({ page }) => {
    await visit(page, "/");

    await page.locator("#top").getByRole("link", { name: "Browse papers" }).click();

    await expect(page).toHaveURL(/\/papers$/);
    await expect(page.getByRole("link", { name: META_AGENT.title })).toBeVisible();
    await expect(page.getByRole("link", { name: CALIBRATION_TITLE })).toBeVisible();
    await expect(page.getByRole("link", { name: UNLISTED_TITLE })).toHaveCount(0);
  });

  test("/?tab=reviewed redirects to /papers?tab=reviewed", async ({ page, request }) => {
    const permanent = await request.get("/?tab=reviewed", { maxRedirects: 0 });
    expect(permanent.status()).toBe(308);
    expect(permanent.headers().location).toBe("/papers?tab=reviewed");

    await page.goto("/?tab=reviewed");
    await expect(page).toHaveURL(/\/papers\?tab=reviewed$/);

    // The other legacy feed parameters follow the same road; a bare `/` stays.
    for (const query of ["category=cs.AI", "sort=recently_reviewed"]) {
      const response = await request.get(`/?${query}`, { maxRedirects: 0 });
      expect(response.status(), query).toBe(308);
      expect(response.headers().location, query).toBe(`/papers?${query}`);
    }
    expect((await request.get("/", { maxRedirects: 0 })).status()).toBe(200);
  });
});

// --- The interactive pieces --------------------------------------------------

test.describe("the interactive sections", () => {
  test('"Change one byte in v2" flips the verdict to failed, and "Restore v2" flips it back', async ({
    page,
  }) => {
    await visit(page, "/");
    const demo = page.locator("#chain");
    await demo.scrollIntoViewIfNeeded();
    const verified = demo.getByText("Verified. History intact", { exact: false });
    const failed = demo.getByText("Verification failed", { exact: false });

    await expect(verified).toBeVisible();
    await expect(failed).toBeHidden();

    await demo.getByRole("button", { name: "Change one byte in v2" }).click();

    await expect(failed).toBeVisible();
    await expect(verified).toBeHidden();
    await expect(demo).toHaveAttribute("data-state", "bad");
    await expect(demo.getByRole("button", { name: "Restore v2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await demo.getByRole("button", { name: "Restore v2" }).click();

    await expect(verified).toBeVisible();
    await expect(failed).toBeHidden();
    await expect(demo).toHaveAttribute("data-state", "ok");
    await expect(demo.getByRole("button", { name: "Change one byte in v2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("the role tabs switch panels with the arrow keys, and Home and End", async ({ page }) => {
    await visit(page, "/");
    const tablist = page.getByRole("tablist", { name: "Choose your role" });
    await tablist.scrollIntoViewIfNeeded();
    const tab = (name: string) => tablist.getByRole("tab", { name });
    const panel = (id: string) => page.locator(`#panel-${id}`);
    const ids = ["authors", "reviewers", "readers", "libraries"] as const;
    const names = { authors: "Authors", reviewers: "Reviewers", readers: "Readers", libraries: "Libraries" };

    /** Exactly one tab is selected, focused and in the tab order; only its panel shows. */
    async function expectSelected(id: (typeof ids)[number]) {
      for (const other of ids) {
        const selected = other === id;
        await expect(tab(names[other])).toHaveAttribute("aria-selected", String(selected));
        await expect(tab(names[other])).toHaveAttribute("tabindex", selected ? "0" : "-1");
        if (selected) await expect(panel(other)).toBeVisible();
        else await expect(panel(other)).toBeHidden();
      }
      await expect(tab(names[id])).toBeFocused();
    }

    await tab("Authors").focus();
    await expectSelected("authors");

    for (const next of ["reviewers", "readers", "libraries"] as const) {
      await page.keyboard.press("ArrowRight");
      await expectSelected(next);
    }
    await page.keyboard.press("ArrowRight"); // wraps to the first
    await expectSelected("authors");
    await page.keyboard.press("ArrowLeft"); // and back to the last
    await expectSelected("libraries");
    await page.keyboard.press("Home");
    await expectSelected("authors");
    await page.keyboard.press("End");
    await expectSelected("libraries");
  });

  test("an FAQ question opens to show its answer", async ({ page }) => {
    await visit(page, "/");
    const entry = page.locator("#faq .faq details", {
      has: page.getByRole("heading", { name: "Is Scholium free?" }),
    });
    await entry.scrollIntoViewIfNeeded();
    const answer = entry.locator(".ans");
    const text = "There is no token, no paywall and no submission fee.";

    await expect(entry).not.toHaveAttribute("open", /.*/);
    await expect(answer).toBeHidden();

    await entry.locator("summary").click();

    await expect(entry).toHaveAttribute("open", "");
    await expect(answer).toBeVisible();
    await expect(answer).toContainText(text);

    // It is a native disclosure: the keyboard works without any script of ours.
    const second = page.locator("#faq .faq details", {
      has: page.getByRole("heading", { name: "What does the name mean?" }),
    });
    await second.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(second).toHaveAttribute("open", "");
    await expect(second.locator(".ans")).toBeVisible();
  });
});

// --- Structured data ---------------------------------------------------------

test.describe("structured data", () => {
  test("the page's JSON-LD parses and contains FAQPage and WebSite", async ({ page }) => {
    await visit(page, "/");

    const blocks = await jsonLdBlocks(page);
    expect(blocks).toHaveLength(1);
    const graph = graphOf(blocks[0]!);
    const types = graph.map((node) => node["@type"]);

    expect(types).toEqual(
      expect.arrayContaining(["Organization", "WebSite", "WebPage", "WebApplication", "DefinedTerm", "FAQPage"]),
    );
    const website = graph.find((node) => node["@type"] === "WebSite")!;
    expect(website.alternateName).toBe("Scholium Network");

    // The FAQPage is the FAQ a visitor reads, question for question.
    const faq = graph.find((node) => node["@type"] === "FAQPage")!;
    const published = (
      faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[]
    ).map((entry) => ({ question: entry.name, answer: entry.acceptedAnswer.text }));
    expect(published).toEqual(await visibleFaq(page));
    expect(published).toHaveLength(11);
  });

  test("every URL in it, and the canonical link, is on the one site origin", async ({ page }) => {
    await visit(page, "/");

    const [block] = await jsonLdBlocks(page);
    const origins = new Set(
      allStrings(graphOf(block!))
        .filter((value) => /^https?:\/\//.test(value))
        .map((value) => new URL(value).origin),
    );
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");

    expect(origins.size).toBe(1);
    expect(new URL(canonical!).href).toBe(`${[...origins][0]}/`);
    await expect(page).toHaveTitle("Scholium — signed, open preprints and peer review");
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/opengraph-image/,
    );
  });
});

// --- Motion and scripting preferences ----------------------------------------

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("every hero line is visible at once", async ({ page }) => {
    await visit(page, "/");

    // The animations are armed (the layout's script ran) and still nothing waits.
    await expect(page.locator("html")).toHaveAttribute("data-home-js", "");
    const lines = page.locator("h1 .line > span");
    await expect(lines).toHaveCount(3);
    for (const line of await lines.all()) {
      await expect(line).toBeVisible();
      expect(await paintedOpacity(line)).toBe(1);
      expect(await isUntransformed(line)).toBe(true);
      // Nothing is still moving: no animation on it lasts longer than a blink.
      const longest = await line.evaluate((element) =>
        Math.max(0, ...element.getAnimations().map((a) => Number(a.effect?.getComputedTiming().duration ?? 0))),
      );
      expect(longest).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("when motion is allowed", () => {
  test("the headline lines rise on a full-length animation", async ({ page }) => {
    await visit(page, "/");

    const longest = await page.locator("h1 .line > span").first().evaluate((element) =>
      Math.max(0, ...element.getAnimations().map((a) => Number(a.effect?.getComputedTiming().duration ?? 0))),
    );
    expect(longest).toBeGreaterThan(500);
  });

  test("every block that is revealed on scroll is revealed once it is read", async ({ page }) => {
    await visit(page, "/");

    // Walk down the page so each block crosses the viewport, as a reader would.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let top = 0; top <= height; top += 300) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), top);
      await page.waitForTimeout(50);
    }

    const stuck = await page
      .locator(".reveal, .demo, .rubric, .ai-panel, .term, .steps, .chips, .glyph-big")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => !node.classList.contains("in"))
          .map((node) => `${node.closest("section")?.id || node.tagName}.${node.className}`),
      );
    expect(stuck).toEqual([]);
  });
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the hero, the statement and all four role panels are visible", async ({ page }) => {
    await page.goto("/");

    // The layout's script never ran, so no animation is armed.
    await expect(page.locator("html")).not.toHaveAttribute("data-home-js", /.*/);

    await expect(page.locator("h1 .line")).toHaveText(HEADLINE);
    for (const line of await page.locator("h1 .line > span").all()) await expectPainted(line);
    for (const cta of ["Submit a paper", "Browse papers"]) {
      await expectPainted(page.locator("#top").getByRole("link", { name: cta }));
    }

    const statement = page.getByText("Today, the scientific record lives in someone's database.");
    await expect(statement).toBeVisible();
    expect(await paintedOpacity(statement)).toBe(1);
    // Fully inked, in the page's text colour: not the pale start of the ink-in effect.
    expect(await statement.evaluate((node) => getComputedStyle(node).color)).toBe(
      await page.locator("body").evaluate((node) => getComputedStyle(node).color),
    );

    for (const id of ["authors", "reviewers", "readers", "libraries"]) {
      const panel = page.locator(`#panel-${id}`);
      await expect(panel, id).toBeVisible();
      await expect(panel.getByRole("heading", { level: 3 })).toBeVisible();
      expect(await paintedOpacity(panel), id).toBe(1);
    }
  });

  test("reveal blocks, the chain demo and the FAQ answers are all readable", async ({ page }) => {
    await page.goto("/");

    for (const selector of ["#review .tile.wide", "#ai .ai-panel", "#verify .term", "#how .steps", ".final .wrap"]) {
      const block = page.locator(selector).first();
      await expect(block, selector).toBeVisible();
      expect(await paintedOpacity(block), selector).toBe(1);
    }
    await expect(page.locator("#chain .v-ok")).toBeVisible();
    // The answers are in the markup; they open with the native disclosure.
    expect(await page.locator("#faq .ans p").count()).toBe(11);
  });
});

// --- The crawler surfaces ----------------------------------------------------

test.describe("the crawler surfaces", () => {
  test("/robots.txt, /sitemap.xml and /llms.txt answer 200 with their media types", async ({
    request,
  }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(robots.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(await robots.text()).toMatch(/User-Agent: \*/i);

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    expect(sitemap.headers()["content-type"]).toMatch(/xml/);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("<urlset");
    expect(sitemapBody).toMatch(/<loc>[^<]*\/papers<\/loc>/);

    const llms = await request.get("/llms.txt");
    expect(llms.status()).toBe(200);
    expect(llms.headers()["content-type"]).toMatch(/^text\/plain/);
    expect((await llms.text()).startsWith("# Scholium")).toBe(true);
  });

  test("the sitemap lists exactly the papers in the public catalog", async ({ request }) => {
    const paper = await listedPaper(request, META_AGENT.title);
    const catalog = await request.get(`${fromConfig("E2E_API_URL")}/v1/papers?limit=100`);
    const { items } = (await catalog.json()) as { items: { shortId: string }[] };
    // `/p/{id}`, the id without its `sch:` prefix.
    const pathOf = (shortId: string) => `/p/${encodeURIComponent(shortId.replace(/^sch:/, ""))}`;

    const body = await (await request.get("/sitemap.xml")).text();
    const listed = [...body.matchAll(/<loc>[^<]*(\/p\/[^<]+)<\/loc>/g)].map((match) => match[1]!);

    // The paper waiting in moderation is not in the catalog, so it is not here either.
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect([...listed].sort()).toEqual(items.map((item) => pathOf(item.shortId)).sort());
    expect(listed).toContain(pathOf(paper.shortId));
  });

  test("a seeded listed paper's page carries citation_title and a ScholarlyArticle block", async ({
    page,
    request,
  }) => {
    const paper = await listedPaper(request, META_AGENT.title);

    await visit(page, `/p/${paper.shortId}`);

    await expect(page.locator('meta[name="citation_title"]')).toHaveAttribute(
      "content",
      META_AGENT.title,
    );
    const articles = (await jsonLdBlocks(page)).flatMap(graphOf).filter(
      (node) => node["@type"] === "ScholarlyArticle",
    );
    expect(articles).toHaveLength(1);
    expect(articles[0]!.headline).toBe(META_AGENT.title);
  });
});

// --- Layout and load budget --------------------------------------------------

test.describe("on a 375 px phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the page has no horizontal scroll", async ({ page }) => {
    await visit(page, "/");

    const overflow = await page.evaluate(() => {
      window.scrollTo({ left: 200, top: 0, behavior: "instant" });
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrolledTo: window.scrollX,
      };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.scrolledTo).toBe(0);
  });

  test("the logo keeps its proportions and the bar's action stays on screen", async ({ page }) => {
    await visit(page, "/");

    const mark = await page.locator("header#nav .sch-brand-logo__mark").boundingBox();
    const action = await page.locator("header#nav").getByRole("link", { name: "Submit a paper" }).boundingBox();

    // The delivered mark is 27 x 28 at this size; it must not be squeezed.
    expect(mark!.width).toBeGreaterThan(20);
    expect(mark!.height).toBeGreaterThan(20);
    expect(action!.x + action!.width).toBeLessThanOrEqual(375);
  });
});

test.describe("the glass bar", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`keeps 4.5:1 for its links over any content beneath it (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await visit(page, "/");
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" }));
      await expect(page.locator("header#nav")).toHaveClass(/scrolled/);

      // The bar's tint, laid over the worst content that can scroll beneath it
      // (the extremes: pure black, pure white), against the colour of each link.
      const worst = await page.evaluate(() => {
        type Rgba = { r: number; g: number; b: number; a: number };
        const parse = (value: string): Rgba => {
          const numbers = (value.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
          const scale = value.startsWith("color(") ? 255 : 1;
          return { r: numbers[0]! * scale, g: numbers[1]! * scale, b: numbers[2]! * scale, a: numbers[3] ?? 1 };
        };
        const flatten = (top: Rgba, under: number): Rgba => ({
          r: top.r * top.a + under * (1 - top.a),
          g: top.g * top.a + under * (1 - top.a),
          b: top.b * top.a + under * (1 - top.a),
          a: 1,
        });
        const luminance = ({ r, g, b }: Rgba) => {
          const channel = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const contrast = (a: Rgba, b: Rgba) => {
          const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (hi! + 0.05) / (lo! + 0.05);
        };
        const tint = parse(getComputedStyle(document.querySelector("#nav")!, "::before").backgroundColor);
        const results: { link: string; ratio: number }[] = [];
        for (const link of document.querySelectorAll<HTMLElement>(".nav-links a, .nav-signin")) {
          const text = parse(getComputedStyle(link).color);
          for (const under of [0, 255]) {
            results.push({ link: link.textContent ?? "", ratio: contrast(text, flatten(tint, under)) });
          }
        }
        return { tintAlpha: tint.a, results };
      });

      expect(worst.results.length).toBeGreaterThanOrEqual(12);
      for (const { link, ratio } of worst.results) {
        expect(ratio, `${link} over the worst content`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

test.describe("the load budget", () => {
  test("the HTML for / is under 150 KB and has the h1 in the first response", async ({ request }) => {
    const response = await request.get("/", { headers: { "accept-encoding": "identity" } });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^text\/html/);
    const html = await response.text();
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(HTML_BUDGET_BYTES);
    // The headline is in the markup the server sent, not drawn by a script.
    expect(html).toMatch(/<h1[\s>]/);
    for (const line of HEADLINE) expect(html.replace(/<[^>]+>/g, "")).toContain(line.replace(/\.$/, ""));
  });

  test("the page requests nothing from any other origin", async ({ page }) => {
    const origin = new URL(fromConfig("E2E_WEB_URL")).origin;
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

    await visit(page, "/");

    const foreign = requested.filter((url) => {
      if (url.startsWith("data:") || url.startsWith("blob:")) return false;
      return new URL(url).origin !== origin;
    });
    expect(requested.length).toBeGreaterThan(5);
    expect(foreign).toEqual([]);
  });
});
