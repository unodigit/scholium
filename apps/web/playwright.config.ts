import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys: `npm run test:e2e` (never part of `npm test`).
 *
 * Playwright's `webServer` boots the whole system for the run:
 *
 * 1. the API (`python -m app`) with the ORCID/arXiv mocks and the fake AI
 *    provider on, against a throw-away SQLite database that `seed-demo` fills
 *    first (three papers, a moderator, reviewers and authors);
 * 2. the web app as a production build (`next build && next start`) pointed at
 *    that API.
 *
 * Prerequisites: `npm install`, `uv` on PATH, and the browser Playwright pins:
 * `npx playwright install chromium`.
 *
 * Ports: `E2E_WEB_PORT` (default 3100) and `E2E_API_PORT` (default 8100).
 * Nothing is reused between runs: a port that is already taken fails the run
 * rather than testing whatever happens to be listening there.
 */

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);

// A small SMTP sink (`tests/e2e/mail-sink.mjs`) stands in for the recipient's
// mail server, so a journey can read the branded email the node actually
// sends. It listens for SMTP and, on a second port, for the HTTP calls the
// journeys use to read and clear the mailbox.
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 8125);
const MAIL_HTTP_PORT = Number(process.env.E2E_MAIL_HTTP_PORT ?? 8126);

// Both sides are `localhost` on purpose. The refresh token is a
// `SameSite=Strict` cookie set by the API, and the browser only keeps (and
// sends) it when the API and the web app are the same *site*; `localhost` and
// `127.0.0.1` are different sites, so an API on one and a page on the other
// would never hold a session. Browsers also only offer passkeys to a hostname,
// not to an IP address.
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

// Readiness is probed on the loopback address the servers bind to.
const WEB_READY_URL = `http://127.0.0.1:${WEB_PORT}/`;
const API_READY_URL = `http://127.0.0.1:${API_PORT}/healthz`;
const MAIL_READY_URL = `http://127.0.0.1:${MAIL_HTTP_PORT}/health`;
/** The mailbox the journeys read; also where the API delivers its mail. */
const MAIL_URL = `http://127.0.0.1:${MAIL_HTTP_PORT}`;

/** Wiped and recreated by the API command at the start of every run. */
const DATA_DIR = join(tmpdir(), `scholium-e2e-${API_PORT}`);

const API_DIR = fileURLToPath(new URL("../api", import.meta.url));

// What the journeys need to know about the system under test. The config is
// evaluated before the workers start, and again inside each of them, so these
// are set the same way every time.
process.env.E2E_WEB_URL = WEB_URL;
process.env.E2E_API_URL = API_URL;
process.env.E2E_API_DIR = API_DIR;
process.env.E2E_DEMO_KEYS = join(DATA_DIR, "demo-keys.json");
process.env.E2E_MAIL_URL = MAIL_URL;

const UV = "uv run --all-packages python";

const apiCommand = [
  'rm -rf "$E2E_DATA_DIR"',
  'mkdir -p "$E2E_DATA_DIR"',
  `${UV} -m app.modules.admin seed-demo --keys-file "$E2E_DATA_DIR/demo-keys.json"`,
  `exec ${UV} -m app`,
].join(" && ");

export default defineConfig({
  testDir: "./tests/e2e",
  // Kept out of the repository tree, like the database.
  outputDir: join(tmpdir(), `scholium-e2e-results-${API_PORT}`),
  // The journeys share one node (and its rate limits); run them one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The recipient's mail server. It must be up before the API sends
      // anything, and it is started with the rest of the system.
      name: "mail",
      command: "node tests/e2e/mail-sink.mjs",
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      url: MAIL_READY_URL,
      reuseExistingServer: false,
      timeout: 30_000,
      stderr: "pipe",
      env: {
        E2E_SMTP_PORT: String(SMTP_PORT),
        E2E_MAIL_HTTP_PORT: String(MAIL_HTTP_PORT),
      },
    },
    {
      name: "api",
      command: apiCommand,
      cwd: API_DIR,
      url: API_READY_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stderr: "pipe",
      env: {
        E2E_DATA_DIR: DATA_DIR,
        HOST: "127.0.0.1",
        PORT: String(API_PORT),
        DATABASE_URL: `sqlite:///${join(DATA_DIR, "scholium.db")}`,
        CONTENT_DIR: join(DATA_DIR, "content"),
        NODE_KEY_PATH: join(DATA_DIR, "node.key"),
        JWT_SECRET: "scholium-e2e-jwt-secret-not-for-production",
        WEB_ORIGINS: WEB_URL,
        // Every notification goes to the sink, where a journey can read the
        // exact message a member's mail client would receive.
        SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}`,
        SCHOLIUM_ENV: "dev",
        ORCID_MOCK: "1",
        ARXIV_MOCK: "1",
        AI_PROVIDER: "fake",
        JOBS_EAGER: "1",
      },
    },
    {
      name: "web",
      // `NEXT_PUBLIC_API_URL` is inlined into the client bundle (and the CSP)
      // by `next build`, so it has to be set for the build, not only the start.
      command: `npm run build && npm run start -- --port ${WEB_PORT} --hostname 127.0.0.1`,
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      url: WEB_READY_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_API_URL: API_URL,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
