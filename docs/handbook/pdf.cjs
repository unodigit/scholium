// Print the handbook's print page to PDF with Playwright's Chromium.
// Called by build.py --pdf; usage: node docs/handbook/pdf.cjs <print.html> <out.pdf>
// Needs network access for the web fonts and the Mermaid diagram renderer.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

async function main() {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    throw new Error("usage: node pdf.cjs <print.html> <out.pdf>");
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve(src)).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const diagrams = await page.locator("pre.mermaid").count();
    await page.waitForFunction(
      (n) => document.querySelectorAll("pre.mermaid svg").length === n,
      diagrams,
      { timeout: 30_000 },
    );
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: out,
      preferCSSPageSize: true,
      printBackground: true,
      outline: true,
      tagged: true,
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
