/**
 * Fixtures and helpers for the role journeys (`roles.spec.ts`).
 *
 * The role journeys need to act as the people `seed-demo` created — the
 * moderator, the reviewers and the authors — not only as a brand-new account.
 * A device key is generated inside the browser and marked non-extractable, so
 * a person's key cannot be handed from one browser profile to another. The
 * demo keys file is the one place their seeds are written down (`seed-demo`
 * keeps it beside the database), so a fixture here builds the same device key
 * the browser would have built: it imports the account's Ed25519 seed as a
 * non-extractable `CryptoKey`, stores it in the app's own IndexedDB record,
 * and registers the passkey that unlocks it with the virtual authenticator.
 * Everything after that is the real sign-in, passkey prompt and record
 * signature — the app cannot tell this profile from one a person set up.
 *
 * The test's own context gets one virtual authenticator (the `authenticator`
 * fixture). A journey that must be two people at once (an endorser looking at
 * a newcomer's profile, two reviewers committing on one paper) opens a second
 * context and calls {@link addVirtualAuthenticator} for it.
 *
 * Nothing here is a test-only API route: the papers, consents, decisions and
 * endorsements are made through the UI (or, where one person must vouch for a
 * new account before it can act, by signing the same public `endorsement`
 * record `journeys.spec.ts` signs). The data comes from the existing
 * `seed-demo`.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  expect,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";

// --- Wiring from playwright.config.ts ---------------------------------------

export function fromConfig(
  name: "E2E_API_URL" | "E2E_API_DIR" | "E2E_DEMO_KEYS" | "E2E_WEB_URL",
): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: run these journeys through playwright.config.ts (npm run test:e2e)`,
    );
  }
  return value;
}

// --- The demo cast -----------------------------------------------------------

/** One account `seed-demo` wrote into the keys file. */
export interface DemoAccount {
  readonly name: string;
  readonly role: string;
  readonly did: string;
  /** The 32-byte Ed25519 seed as 64 hex characters. */
  readonly seed: string;
}

let cachedAccounts: Record<string, DemoAccount> | null = null;

/** The demo accounts, slug → account, read from the keys file `seed-demo` wrote. */
export function demoAccounts(): Record<string, DemoAccount> {
  if (cachedAccounts !== null) return cachedAccounts;
  const payload = JSON.parse(readFileSync(fromConfig("E2E_DEMO_KEYS"), "utf8")) as {
    accounts?: Record<string, DemoAccount>;
  };
  if (payload.accounts === undefined) {
    throw new Error(`the demo keys file ${fromConfig("E2E_DEMO_KEYS")} has no accounts`);
  }
  cachedAccounts = payload.accounts;
  return cachedAccounts;
}

/** The slug of the seeded moderator (`Priya Nair`, tier 4). */
export const MODERATOR = "priya";
/** The two seeded reviewers who did not write the papers (tier 3). */
export const REVIEWER_A = "solheim";
export const REVIEWER_B = "keller";
/** Seeded authors; all have a signed consent on their own paper's versions. */
export const AUTHOR = "mei";
export const AUTHOR_RAFAEL = "rafael";
export const AUTHOR_LENA = "lena";
/** The reviewer whose endorsement makes a new account an author (tier 3). */
export const ENDORSER = "okafor";

// --- Names of the seeded papers ---------------------------------------------

export const META_AGENT = {
  title: "Can a Meta-Agent Choose the Safer Branch?",
  authors: ["Mei Zhang", "Rafael Silva", "Lena Haddad"],
};

// --- Encoding helpers --------------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc-decode a did:key's multibase payload. */
export function base58Decode(text: string): Uint8Array {
  let value = 0n;
  for (const character of text) {
    const digit = BASE58.indexOf(character);
    if (digit === -1) throw new Error(`not base58: ${JSON.stringify(text)}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Leading '1's are leading zero bytes.
  for (const character of text) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** The raw 32-byte Ed25519 public key inside a `did:key:z…` (multicodec 0xed01). */
export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error(`not a did:key: ${did}`);
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`the did does not carry an Ed25519 public key: ${did}`);
  }
  return decoded.slice(2);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function cpRng(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

// --- The virtual authenticator ----------------------------------------------

/** A virtual authenticator plus the CDP session that can add credentials to it. */
export interface Authenticator {
  readonly authenticatorId: string;
  readonly cdp: CDPSession;
}

/**
 * Put a platform authenticator on `page`'s browser: resident credentials,
 * user verification, always present — the same profile `journeys.spec.ts`
 * uses, exposed here so a journey can also add a credential by hand.
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<Authenticator> {
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
  return { authenticatorId, cdp };
}

/** Remove the authenticator; safe to call once. */
export async function removeVirtualAuthenticator(auth: Authenticator): Promise<void> {
  await auth.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: auth.authenticatorId,
  });
  await auth.cdp.send("WebAuthn.disable");
}

/** The test's own context, with a virtual authenticator available. */
export const test = base.extend<{ authenticator: Authenticator }>({
  authenticator: [
    async ({ context, page }, use) => {
      const auth = await addVirtualAuthenticator(context, page);
      await use(auth);
      await removeVirtualAuthenticator(auth);
    },
    { auto: false },
  ],
});

export { expect };

/** A separate browser profile for a second person in the same journey. */
export interface RoleContext {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly authenticator: Authenticator;
}

/**
 * A second browser profile (its own IndexedDB, cookies and authenticator), for
 * a journey that needs two people at once. The caller closes it.
 */
export async function newRoleContext(browser: Browser): Promise<RoleContext> {
  const context = await browser.newContext({ baseURL: fromConfig("E2E_WEB_URL") });
  const page = await context.newPage();
  const authenticator = await addVirtualAuthenticator(context, page);
  return { context, page, authenticator };
}

// --- Being a seeded person in the browser -----------------------------------

/** Install a seeded account's device key into the browser profile. */
interface InstalledKey {
  readonly seedHex: string;
  readonly publicKeyHex: string;
  readonly credentialId: string;
  readonly userId: string;
  readonly rpId: string;
}

/**
 * Import the account's seed as the non-extractable device key, in the same
 * IndexedDB record the app writes, with the passkey the authenticator holds.
 */
async function installDeviceKey(installed: InstalledKey): Promise<void> {
  const bytes = (text: string): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(text.length / 2);
    for (let index = 0; index < out.length; index += 1) {
      out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  };
  // RFC 8410 PKCS#8 for a raw Ed25519 seed: 302e020100300506032b657004220420 || seed.
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
    0x04, 0x20,
  ]);
  const seed = bytes(installed.seedHex);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytes(installed.publicKeyHex),
    { name: "Ed25519" },
    true,
    ["verify"],
  );

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("scholium.web-auth", 1);
    request.onupgradeneeded = () => {
      const opened = request.result;
      if (!opened.objectStoreNames.contains("device-keys")) {
        opened.createObjectStore("device-keys", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("device-keys", "readwrite");
    transaction.objectStore("device-keys").put({
      id: "primary",
      version: 1,
      privateKey,
      publicKey,
      credentialId: installed.credentialId,
      userId: installed.userId,
      createdAt: Date.now(),
      rpId: installed.rpId,
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

/** Where a sign-in should land afterwards. */
export interface SignInOptions {
  /** A same-site path to return to, as `/signin?next=…` would take it. */
  readonly next?: string;
}

/** A signed-in seeded person: who they are and the token the node issued. */
export interface SignedIn {
  readonly did: string;
  readonly accessToken: string;
}

/**
 * Sign in as the seeded account `slug` in `page`.
 *
 * The profile is given the account's device key and a passkey the virtual
 * authenticator answers, so the app runs its normal returning-user flow: ask
 * for a challenge, unlock the key behind the passkey, sign and verify.
 */
export async function signInAs(
  page: Page,
  authenticator: Authenticator,
  slug: string,
  options: SignInOptions = {},
): Promise<SignedIn> {
  const account = demoAccounts()[slug];
  if (account === undefined) {
    throw new Error(`the demo keys file has no account ${JSON.stringify(slug)}`);
  }
  if (!authenticator.authenticatorId) {
    throw new Error("the virtual authenticator is missing");
  }

  // CDP's `binary` fields are standard base64; the app's stored record and the
  // WebAuthn API speak unpadded base64url. They name the same bytes.
  const credentialBytes = cpRng().slice(0, 16);
  const userHandleBytes = cpRng();
  const credentialId = base64url(credentialBytes);
  const userId = base64url(userHandleBytes);
  // The passkey only unlocks the device key; the app never verifies the
  // assertion's signature. Chromium's virtual authenticator wants a key type
  // it can sign with (P-256), so that is what it gets.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const passkeyKey = privateKey.export({ type: "pkcs8", format: "der" });

  await authenticator.cdp.send("WebAuthn.addCredential", {
    authenticatorId: authenticator.authenticatorId,
    credential: {
      credentialId: Buffer.from(credentialBytes).toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      // The app never checks the passkey's signature: the passkey unlocks the
      // device key, and the device key is what signs. Any valid key will do.
      privateKey: Buffer.from(passkeyKey).toString("base64"),
      userHandle: Buffer.from(userHandleBytes).toString("base64"),
      signCount: 0,
    },
  });

  const signInPath =
    options.next === undefined
      ? "/signin"
      : `/signin?next=${encodeURIComponent(options.next)}`;
  await page.goto(signInPath, { waitUntil: "networkidle" });
  await page.evaluate(installDeviceKey, {
    seedHex: account.seed,
    publicKeyHex: hex(publicKeyFromDid(account.did)),
    credentialId,
    userId,
    rpId: "localhost",
  });

  const challenge = page.waitForRequest((request) =>
    request.url().endsWith("/v1/auth/challenge"),
  );
  const verified = page.waitForResponse((response) =>
    response.url().endsWith("/v1/auth/verify"),
  );
  await page.getByRole("button", { name: "Sign in with passkey" }).click();

  const { did } = (await challenge).postDataJSON() as { did: string };
  expect(did).toBe(account.did);
  const issued = await verified;
  expect(issued.status()).toBe(200);
  const { access_token: accessToken } = (await issued.json()) as {
    access_token: string;
  };
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), {
    timeout: 30_000,
  });
  return { did, accessToken };
}

/**
 * A brand-new account on the test's own profile: the first sign-in creates the
 * device key and registers its passkey, exactly as a person's would.
 */
export async function createAccount(
  page: Page,
  options: SignInOptions = {},
): Promise<SignedIn> {
  const signInPath =
    options.next === undefined
      ? "/signin"
      : `/signin?next=${encodeURIComponent(options.next)}`;
  await page.goto(signInPath, { waitUntil: "networkidle" });

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
  const { access_token: accessToken } = (await issued.json()) as {
    access_token: string;
  };
  await expect(page).toHaveURL(/\/onboarding$/);
  return { did, accessToken };
}

// --- Operator commands ------------------------------------------------------

/**
 * The seeded reviewer (Dr. Tunde Okafor) signs an `endorsement` for `did` in
 * `category` and posts it. His key is in the demo keys file, so this is the
 * record a reviewer would sign with their own device, sent by the operator.
 */
const ENDORSE = `
import json, sys
from datetime import datetime, timezone

import httpx
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature, sign_record

keys_file, api, endorsee, category = sys.argv[1:5]
with open(keys_file, encoding="utf-8") as handle:
    key = SigningKey(bytes.fromhex(json.load(handle)["accounts"]["okafor"]["seed"]))
did = did_key_from_signing_key(key)
with httpx.Client(base_url=api, timeout=30) as http:
    nonce = http.post("/v1/auth/challenge", json={"did": did}).json()["nonce"]
    signature = encode_signature(key.sign(nonce.encode("utf-8")).signature)
    verified = http.post("/v1/auth/verify", json={"did": did, "nonce": nonce, "signature": signature})
    verified.raise_for_status()
    record = sign_record(
        {
            "v": 1,
            "type": "endorsement",
            "author": did,
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {"endorsee": endorsee, "category": category, "statement": "Endorsed for the role journeys."},
            "proofs": [],
        },
        key,
    )
    posted = http.post(
        "/v1/records", json=record, headers={"Authorization": "Bearer " + verified.json()["access_token"]}
    )
    if posted.status_code != 201:
        sys.exit("the node refused the endorsement: %s %s" % (posted.status_code, posted.text))
`;

/** A seeded reviewer endorses `did`; the account becomes an Author (tier 2). */
export function endorse(did: string, category: string): void {
  execFileSync(
    "uv",
    [
      "run",
      "--all-packages",
      "python",
      "-c",
      ENDORSE,
      fromConfig("E2E_DEMO_KEYS"),
      fromConfig("E2E_API_URL"),
      did,
      category,
    ],
    { cwd: fromConfig("E2E_API_DIR"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// --- Reading the node --------------------------------------------------------

/** One paper as `GET /v1/papers` lists it. */
export interface SeededPaper {
  readonly shortId: string;
  readonly title: string;
  readonly versionCid: string;
  readonly authors: { did: string }[];
}

/** The listed paper with this title, as the node's catalog returns it. */
export async function listedPaper(
  request: APIRequestContext,
  title: string,
): Promise<SeededPaper> {
  const response = await request.get(`${fromConfig("E2E_API_URL")}/v1/papers?limit=100`);
  expect(response.ok()).toBe(true);
  const { items } = (await response.json()) as { items: SeededPaper[] };
  const paper = items.find((item) => item.title === title);
  if (!paper) {
    throw new Error(`the paper ${JSON.stringify(title)} is not listed on this node`);
  }
  return paper;
}

/** Open a page and wait until it has hydrated and restored the session. */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "networkidle" });
}

/** A one-page PDF with real text on it, built by hand so no fixture file is needed. */
export function pdfWithText(lines: string[]): Buffer {
  const escape = (text: string) => text.replace(/[\\()]/g, "\\$&");
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// --- Steps shared by more than one journey -----------------------------------

/** Record a POSTed signed record's type and cid, as the submit forms send them. */
export interface PostedRecord {
  readonly type: string;
  readonly id: string;
}

/** Collect every signed record the page POSTs from now on. */
export function collectPostedRecords(page: Page): PostedRecord[] {
  const posted: PostedRecord[] = [];
  page.on("response", (response) => {
    if (
      response.request().method() !== "POST" ||
      !response.url().endsWith("/v1/records") ||
      response.status() !== 201
    ) {
      return;
    }
    try {
      const body = response.request().postDataJSON() as {
        type?: unknown;
        id?: unknown;
      };
      if (typeof body.type === "string" && typeof body.id === "string") {
        posted.push({ type: body.type, id: body.id });
      }
    } catch {
      // A POST whose body this listener cannot read is simply not collected.
    }
  });
  return posted;
}

/** The cid of the first record of `type` this page POSTed, or `null`. */
export function cidOf(posted: readonly PostedRecord[], type: string): string | null {
  return posted.find((record) => record.type === type)?.id ?? null;
}

/**
 * Publish the next version of a listed paper as the seeded author `slug`,
 * through the app's New version form. Returns the version record's cid; the
 * version still needs every listed author's consent before it is moderated.
 */
export async function postNewVersion(
  page: Page,
  shortId: string,
  changeNote: string,
  categoryId: string,
): Promise<string> {
  await page.goto(`/submit/new-version/${shortId}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Submit a new version" }),
  ).toBeVisible();

  // The seeded version records carry no `categories` body field, so the
  // pre-filled Details step starts with none chosen; a new version needs one.
  const category = page.getByRole("button", {
    name: new RegExp(`^${categoryId.replace(/\./g, "\\.")}\\b`),
  });
  await expect(category).toBeVisible();
  if ((await category.getAttribute("aria-pressed")) !== "true") {
    await category.click();
  }

  const next = page.getByRole("button", { name: /^Continue to the change note$/ });
  await expect(next).toBeEnabled();
  await next.click();

  await page.locator("#nv-change-note").fill(changeNote);
  const posted = collectPostedRecords(page);
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/records") &&
      response.request().method() === "POST" &&
      (response.request().postDataJSON() as { type?: string }).type === "paper.version",
  );
  await page.getByRole("button", { name: /^Sign and submit version \d+$/ }).click();
  expect((await accepted).status()).toBe(201);
  await expect(
    page.getByRole("heading", { name: /^Version \d+ is signed and submitted$/ }),
  ).toBeVisible();

  const versionCid = cidOf(posted, "paper.version");
  if (versionCid === null) {
    throw new Error("the new version's record cid was not observed");
  }
  return versionCid;
}

/** Fill the six-dimension rubric, confidence and recommendation with `marker` text. */
export async function fillRubric(page: Page, marker: string): Promise<void> {
  const dimensions: Array<[string, number]> = [
    ["Soundness of method", 4],
    ["Evidence for claims", 4],
    ["Reproducibility", 3],
    ["Novelty", 4],
    ["Clarity", 5],
    ["Limitations & ethics", 4],
  ];
  for (const [label, score] of dimensions) {
    const group = page.getByRole("group", { name: label });
    await group.getByRole("radio", { name: `${score} of 5` }).check();
    await group.getByRole("textbox").fill(`${marker}: ${label.toLowerCase()}.`);
  }
  await page
    .getByRole("group", { name: "Confidence" })
    .getByRole("radio", { name: "High" })
    .check();
  await page
    .getByRole("group", { name: "Recommendation" })
    .getByRole("radio", { name: "Minor revisions" })
    .check();
}

/**
 * Open a moderation-queue row and wait for it to appear: consent and the scan
 * run in the background, so a version joins the queue a moment after the last
 * author signs.
 */
export async function openQueueRow(
  page: Page,
  target: { readonly title?: string; readonly versionCid?: string },
): Promise<void> {
  const link =
    target.versionCid !== undefined
      ? page.locator(`a[href="/mod/${target.versionCid}"]`)
      : page.getByRole("link", { name: target.title ?? "" });

  await expect(async () => {
    await page.goto("/mod", { waitUntil: "networkidle" });
    await expect(link).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000, intervals: [2_000, 3_000, 5_000] });

  await link.click();
}

/** The moderator's decision form, filled with a listing decision. */
export async function listPaper(
  page: Page,
  reason: string,
  clause = "MOD-01",
): Promise<number> {
  await expect(
    page.getByRole("heading", { name: "Moderation decision", level: 1 }),
  ).toBeVisible();
  await page.getByLabel(/^Action/).selectOption("list");
  await page.getByLabel(/^Policy clause/).selectOption(clause);
  await page.getByLabel(/^Reason shown to the author/).fill(reason);
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/moderation/decisions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign decision" }).click();
  const response = await accepted;
  await expect(
    page.getByRole("heading", { name: "Decision published" }),
  ).toBeVisible();
  return response.status();
}

/** The moderator's decision form, filled with a hold decision. */
export async function holdPaper(
  page: Page,
  reason: string,
  clause = "MOD-02",
): Promise<number> {
  await expect(
    page.getByRole("heading", { name: "Moderation decision", level: 1 }),
  ).toBeVisible();
  await page.getByLabel(/^Action/).selectOption("hold");
  await page.getByLabel(/^Policy clause/).selectOption(clause);
  await page.getByLabel(/^Reason shown to the author/).fill(reason);
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/moderation/decisions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign decision" }).click();
  const response = await accepted;
  await expect(
    page.getByRole("heading", { name: "Decision published" }),
  ).toBeVisible();
  return response.status();
}

/** Sign the consent page the signed-in author is looking at. */
export async function acceptConsent(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Review and sign", level: 1 }),
  ).toBeVisible();
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/v1/records") &&
      response.request().method() === "POST" &&
      (response.request().postDataJSON() as { type?: string }).type === "coauthor.consent",
  );
  await page.getByRole("button", { name: "Accept authorship" }).click();
  expect((await accepted).status()).toBe(201);
  await expect(
    page.getByText("You accepted authorship of this version."),
  ).toBeVisible();
}

/** Sign the consent page for `versionCid` as the seeded account `slug`. */
export async function signConsentAs(
  page: Page,
  authenticator: Authenticator,
  slug: string,
  versionCid: string,
): Promise<void> {
  await signInAs(page, authenticator, slug, { next: `/consent/${versionCid}` });
  await acceptConsent(page);
}
