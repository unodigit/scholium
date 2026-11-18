import { expect, test } from "@playwright/test";

const META_AGENT_TITLE = "Can a Meta-Agent Choose the Safer Branch?";

interface SeededPaper {
  shortId: string;
  title: string;
}

async function seededPaper(request: any, title: string): Promise<SeededPaper> {
  const response = await request.get(`${process.env.E2E_API_URL}/v1/papers`);
  expect(response.ok()).toBe(true);
  const { items } = (await response.json()) as { items: SeededPaper[] };
  const paper = items.find((item) => item.title === title);
  if (!paper) {
    throw new Error(`the seeded paper ${JSON.stringify(title)} is not on the node`);
  }
  return paper;
}

async function visit(page: any, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
}

test.describe("verify manifest loop", () => {
  test("opens /verify with a seeded version and requests the manifest at most once", async ({ page, request }) => {
    const paper = await seededPaper(request, META_AGENT_TITLE);
    const versionId = `${paper.shortId}/v1`;

    const manifestRequests: string[] = [];
    page.on("request", (req: any) => {
      if (req.url().includes("/manifest")) manifestRequests.push(req.url());
    });

    await page.goto(`/verify?id=${encodeURIComponent(versionId)}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    expect(manifestRequests.length).toBeLessThanOrEqual(1);

    // Fetch the version's main.pdf bytes, then drop them and expect a match.
    const manifestRes = await request.get(
      `${process.env.E2E_API_URL}/v1/papers/${encodeURIComponent(paper.shortId)}/v/1/manifest`,
    );
    expect(manifestRes.ok()).toBe(true);
    const manifest = (await manifestRes.json()) as { files: { path: string; cid: string }[] };
    const mainFile = manifest.files.find((f) => f.path === "main.pdf") ?? manifest.files[0];
    const contentRes = await request.get(`${process.env.E2E_API_URL}/v1/content/${mainFile.cid}`);
    expect(contentRes.ok()).toBe(true);
    const mainBuffer = await contentRes.body();

    await page.setInputFiles('input[type="file"]', {
      name: "main.pdf",
      mimeType: "application/pdf",
      buffer: mainBuffer,
    });
    await expect(page.locator(".vp-verdict")).toHaveAttribute("data-kind", "match", { timeout: 15000 });

    // An unrelated file must be reported as a mismatch.
    await page.setInputFiles('input[type="file"]', {
      name: "unrelated.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this is not what the authors signed"),
    });
    await expect(page.locator(".vp-verdict")).toHaveAttribute("data-kind", "mismatch", { timeout: 15000 });
  });

  test("no API path is requested more than 5 times within 3s of load", async ({ page, request }) => {
    const paper = await seededPaper(request, META_AGENT_TITLE);
    const paperId = paper.shortId.replace(/^sch:/i, "");

    const routes = [
      "/",
      `/p/${paperId}`,
      `/reviews/${paperId}`,
      `/discussion/${paperId}`,
      `/proof/${paperId}`,
      "/verify",
      "/network",
      "/search?q=reward",
      "/c/cs.AI",
    ];

    for (const route of routes) {
      const counts = new Map<string, number>();
      const listener = (req: any) => {
        const url = req.url();
        if (!url.includes("/v1/")) return;
        const path = new URL(url).pathname;
        counts.set(path, (counts.get(path) ?? 0) + 1);
      };
      page.on("request", listener);

      await page.goto(route, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);

      page.off("request", listener);

      const max = Math.max(0, ...counts.values());
      expect(max, `route ${route}: ${JSON.stringify([...counts.entries()])}`).toBeLessThanOrEqual(5);
    }
  });
});
