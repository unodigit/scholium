# web-auth — passkey-gated device key

Feature 140. Creates a **non-extractable Ed25519 WebCrypto signing key**,
persists it in **IndexedDB**, and requires a **WebAuthn passkey assertion**
before it will sign. The private key never leaves the device: there is no
code path that exports it.

The `/signin` page (feature 141, below) and the `/onboarding` steps
(feature 142) are built on this module; `/recover` follows in a later
`web-auth` feature. Import from `@/features/web-auth`.

## Sign-in page (`/signin`)

`apps/web/src/app/(web-auth)/signin/page.tsx` renders `SignInForm`: one
"Sign in with passkey" button. Clicking it runs `signIn()`:

```text
did = device key's did:key                  (no prompt)
POST /v1/auth/challenge {did}            -> {nonce, did, expires_at}
sig = Ed25519(device key, UTF-8(nonce))     (passkey prompt)
POST /v1/auth/verify {did, nonce, signature} -> {access_token, refresh_token}
```

- `signature` is **unpadded base64url** over the nonce's **UTF-8 bytes**, the
  same encoding record signatures use. Both calls are unauthenticated.
- The token pair is saved to the shared `tokenStore` (`@/lib/api`).
- **New account → `/onboarding`.** The API creates the account on the first
  verify and deliberately never says whether a did already has one, so the
  browser decides: a did is derived from the device key, therefore *a device
  key created by this sign-in is a new account*. With no key on the device,
  `signIn()` first creates it and registers its passkey (that prompt counts as
  the sign-in's passkey check), then runs the exchange above.
- **Returning user → `?next=` or `/`.** The passkey is asked for every time.
  `next` must be a same-site path; `//host`, absolute URLs, backslashes,
  control characters and `/signin` itself are ignored (`safeRedirectPath`).
- **A failed first attempt still ends in `/onboarding`.** The key is stored
  before the network calls, so a retry would otherwise look like a returning
  user. A `localStorage` marker (`scholium.web-auth.new-account`) is written
  when the key is created and consumed by the first sign-in that completes.
  A key created some other way (for example directly via `DeviceKeyManager`)
  has no marker and is treated as a returning account.
- Failures are shown in plain language (`describeSignInError`): dismissed
  passkey prompt, unsupported browser, blocked storage, offline server, a
  rejected sign-in, a malformed reply. Nothing is signed until the key exists,
  and a dismissed prompt stops before any signature leaves the device.

`/onboarding` shows the four first-run steps; see the next section.

## Onboarding page (`/onboarding`)

`apps/web/src/app/(web-auth)/onboarding/page.tsx` renders `OnboardingForm`:
a checklist of the four steps `docs/design.md` §6 fixes, in order —

1. **Create your passkey** — done the moment a device key exists on the
   device (checked locally with `exists()`); otherwise the step links to
   `/signin`.
2. **Link your ORCID iD** — "Link your ORCID iD" calls
   `GET /v1/auth/orcid/start` and sends the whole browser to the returned
   authorize URL (the access token is attached, so the signed `state` binds
   this account's DID). Coming back, the step remembers the attempt, and a
   best-effort `GET /v1/profiles/{did}` flips it to done once the profile
   shows a linked iD — a profile that cannot be read leaves the step at
   "started", never failed.
3. **Pick categories to follow** — chips (`cs.AI`, …) plus a free input,
   saved with `PUT /v1/me/follows/{category}` each. Following is not a
   dependency of onboarding, so a node without the follows routes (404/405/
   501) does not fail the step: the picks are kept on this device
   (`scholium.web-auth.onboarding`) and complete it regardless.
4. **Set recovery guardians** — five DID inputs saved with
   `PUT /v1/me/guardians`. The API's rules (exactly five canonical
   Ed25519 `did:key`s, none repeated, none your own) are checked in the
   browser first, so most mistakes never leave the device; the API's own
   422 problem details — one `errors` entry per fault — map back onto the
   input they name.

**Guardians are required before the first submission**: the API answers
submissions with 403 problem details until they are set, so the page's
"Start reading Scholium" button stays disabled until that step is done,
while a gentle "skip for now" link (design.md: "nagged gently until done")
is always offered.

Progress persists per browser under `scholium.web-auth.onboarding`, so a
reload — or the round-trip to ORCID — keeps the checklist. Behaviour lives
in `useOnboarding` (unit-tested via `renderHook`); `onboarding-form.tsx` is
markup only.

## Recovery page (`/recover`)

`apps/web/src/app/(web-auth)/recover/page.tsx` renders `RecoverForm`, the
lost-device flow from `docs/design.md` §6:

```text
"Lost your device?" → identify by ORCID iD
  → guardians approve → progress "2 of 3 approvals"
  → 72-hour safety window with a cancel link → new passkey
```

- **Identify.** The ORCID iD is normalised exactly as the API does (bare
  `0000-0002-1825-0097`, a pasted `https://orcid.org/…` URL, lowercase check
  digit), so a valid iD never fails in the browser and then succeeds on the
  server. `POST /v1/recovery/requests` is unauthenticated — the account holder
  has no token any more — and carries the `did:key` the account should move
  to. A browser with no device key creates one here (the "new passkey" at the
  end of the flow); an existing key is reused.
- **Progress.** The page shows `n of 3 approvals` (the API's
  `APPROVAL_THRESHOLD`) with a text-labelled meter, the number of notified
  guardians and the request id. It reads
  `GET /v1/recovery/requests/{id}` for the live count. That read route does not
  exist yet: a 404 that is not the request-not-found problem type, 405 or 501
  is treated as "no news", not an error, and the last known progress stays on
  screen behind "Check for approvals".
- **72-hour safety window.** The third approval opens the window
  (`CONTEST_WINDOW`). The page shows its UTC deadline and the time left, and
  explains what opens it while approvals are pending.
- **Cancel.** While the request is pending or contesting, "Cancel this
  recovery" signs the request id with the device key behind a passkey prompt
  and posts the detached signature. Cancelling therefore needs the old key;
  `/recover?request=rec_…` is the link sent to known contacts, and a 401 is
  explained as "open the cancel link on a device that still has your old
  passkey".
- **Remembering.** The request is kept under
  `scholium.web-auth.recovery`, so a reload — or opening the cancel link —
  lands on the progress card instead of the form.

`/signin` offers the way in ("Lost your device?"). Behaviour lives in
`useRecover` (unit-tested via `renderHook`); `recover-form.tsx` is markup only.

## Quick start

```ts
import { DeviceKeyManager } from "@/features/web-auth";

const key = new DeviceKeyManager();

// First run: generates the key (non-extractable), registers a resident
// passkey, writes both CryptoKey objects to IndexedDB.
await key.create({ userName: "mei@example.edu", userDisplayName: "Mei" });

// Account identifier the API knows you by.
const did = await key.didKey(); // "did:key:z6Mk…"

// Sign-in: unlock with the passkey, then sign the API challenge.
const signature = await key.signWithPasskey(nonceBytes);
```

On a later visit:

```ts
if (await key.exists()) {
  await key.unlock();                    // passkey prompt
  const signature = await key.sign(nonce);
}
```

## Signing records

`signRecord(type, body, prev)` turns a payload into a submit-ready envelope:

```ts
import { signRecord } from "@/features/web-auth";

const record = await signRecord("paper.version", { title: "…" }, previousId);
// { v: 1, type, id: "bafyrei…", author: "did:key:z6Mk…",
//   created: "2026-11-14T05:33:00Z", prev: previousId, body, proofs: [],
//   sig: "<unpadded base64url Ed25519>" }
```

- **Author** is the device key's `did:key`; **created** is UTC at second
  precision; **proofs** default to `[]` (pass `{ proofs }` to attach some).
- **`prev`** is required. Pass `null` to start a chain. An empty string is
  rejected so a missing id cannot silently fork a chain.
- **`id`** is computed by `verify-core` (`computeRecordCid`): a CIDv1 over the
  seven content fields, excluding `id` and `sig`.
- **`sig`** is Ed25519 over the **canonical record bytes** (`recordBytes`): the
  DAG-CBOR encoding of the same seven content fields, excluding `id` and `sig`
  — the same bytes the record id hashes over, **not** the binary CID. It is
  encoded as unpadded base64url. A verifier recomputes the id from the
  envelope, checks it equals `id`, then verifies `sig` over those bytes with
  the key named by `author`, which is exactly what the API's `verify_envelope`
  and the shared `record-core` vectors do.
- **One prompt per call.** Every call shows the "Sign and submit" passkey
  prompt, even when the key is still unlocked from an earlier prompt.
- **Validation happens first.** The envelope is built and its id computed
  *before* the prompt, so a malformed record raises `RecordSigningError`
  (`invalid-record`) without asking the user to approve anything. A missing
  device key (`not-found`), a dismissed prompt (`passkey-cancelled`) and a
  failed passkey (`passkey-failed`) are `DeviceKeyError`s.
- `body` and `proofs` are copied, so mutating them afterwards cannot make the
  returned record disagree with its `id` and `sig`.

`verify-core` is loaded on first use; if it cannot load, `signRecord` raises
`RecordSigningError` with code `record-id-failed`. Tests inject
`{ signer, computeRecordCid, recordBytes, now }` instead of touching the real
device key.

## Security model

| Property | How it is enforced |
| --- | --- |
| Private key cannot be exported | `subtle.generateKey({ name: "Ed25519" }, false, …)`; `assertNonExtractablePrivateKey` re-checks `extractable === false` before persisting, after loading and before signing. `subtle.exportKey("pkcs8", …)` rejects with `InvalidAccessError`. |
| No key bytes on disk | IndexedDB stores the `CryptoKey` objects via structured clone. The raw private key is never serialised. |
| Signing needs a human | `sign()` throws `locked` unless a recent WebAuthn assertion validated the stored credential id, the fresh challenge, user presence **and** user verification. |
| Stolen profile is not enough | The passkey assertion requires the authenticator's PIN/biometric (`userVerification: "required"`). |
| No PII in the user handle | A random 32-byte handle is generated; the account name is only shown locally by the browser. |

WebAuthn has no API that cryptographically wraps a WebCrypto key, so the
passkey is an **authorization gate** rather than a key-encryption key. That is
stated plainly in `device-key.ts` and is the same custody model described in
`docs/tech_architect.md` ("WebAuthn passkey unlocks a device-held signing
key").

## API surface

| Export | Purpose |
| --- | --- |
| `DeviceKeyManager` | Lifecycle: `create`, `ensure`, `load`, `unlock`, `sign`, `signWithPasskey`, `verify`, `publicKey`, `didKey`, `reset`, `lock`. |
| `deviceKey` | App-wide manager (IndexedDB + `navigator.credentials`). Safe to import during SSR; nothing touches browser globals until a method runs. |
| `IndexedDbDeviceKeyStorage` | IndexedDB persistence (`scholium.web-auth` → `device-keys`). |
| `MemoryDeviceKeyStorage` | Test / non-persistent storage. |
| `BrowserPasskeyProvider` | `navigator.credentials.create/get` adapter. |
| `didKeyFromEd25519PublicKey` | `did:key:z6Mk…` encoding (base58btc + Ed25519 multicodec). |
| `signRecord` | Build a record envelope, compute its id with `verify-core` and sign it behind a "Sign and submit" passkey prompt. |
| `signIn` | Challenge-response sign-in with the device key (creating it on first run); returns `{ did, isNewAccount, redirectTo, tokens }`. |
| `safeRedirectPath`, `signInDestination` | Same-site `next` handling and the new-account → `/onboarding` rule. |
| `describeSignInError` | One plain-language sentence for any sign-in failure. |
| `ONBOARDING_STEPS` | The four `/onboarding` steps in design order, with title and summary. |
| `startOrcidLink`, `checkOrcidLink` | Begin the ORCID link (authorize URL + state) and best-effort "is it linked yet?" |
| `followCategories` | Save category picks (`PUT /v1/me/follows/{category}`), keeping them on-device when the endpoint is absent. |
| `validateGuardians`, `saveGuardians` | Check (and then save, `PUT /v1/me/guardians`) a five-guardian list; API 422s map onto inputs. |
| `useOnboarding` | React hook driving the page: step states, actions, the guardians gate on finishing. |
| `openRecoveryRequest`, `fetchRecoveryStatus`, `cancelRecoveryRequest` | Open a recovery by ORCID iD, read its approval progress, and cancel it with a passkey-signed request id. |
| `approvalProgressText`, `safetyWindowNote` | The `"2 of 3 approvals"` line and the 72-hour safety-window copy. |
| `useRecover` | React hook behind `/recover`: identify, progress, refresh, cancel, reset. |

All failures are `DeviceKeyError` with a stable `code`
(`unsupported`, `storage-unavailable`, `not-found`, `already-exists`,
`locked`, `passkey-cancelled`, `passkey-failed`, `signing-failed`,
`invalid-key`, `invalid-encoding`). A dismissed passkey sheet raises
`PasskeyCancelledError` (`code: "passkey-cancelled"`).

## Source layout

| File | Contents |
| --- | --- |
| `webcrypto-ed25519.ts` | Non-extractable Ed25519 generation, sign/verify, public-key export. |
| `device-key-storage.ts` | Record shape, IndexedDB and memory stores. |
| `passkey.ts` | WebAuthn registration and assertion validation. |
| `device-key.ts` | Manager that ties storage, crypto and passkeys together. |
| `sign-record.ts` | `signRecord`: envelope building, record id, passkey-gated signature. |
| `signin.ts` | `signIn` flow, new-account marker, `next` sanitising. |
| `signin-messages.ts` | Progress and failure copy for the sign-in page. |
| `use-signin.ts` | React hook: one flow at a time, progress, error, navigation. Plain `.ts` so it is unit-testable (see Tests). |
| `signin-form.tsx` | The `/signin` card (markup only; client component). |
| `onboarding.ts` | Step model, persisted progress, ORCID start, category follows, guardian validation and save. |
| `onboarding-messages.ts` | Copy for the `/onboarding` page, including the guardians nag and `describeOnboardingError`. |
| `use-onboarding.ts` | React hook behind the checklist (step states, actions, finish gate). |
| `onboarding-form.tsx` | The `/onboarding` checklist (markup only; client component). |
| `recover.ts` | ORCID validation, opening a recovery, reading progress, cancelling, the 72-hour window and per-browser memory. |
| `recover-messages.ts` | Copy for the `/recover` page, including `describeRecoveryError`. |
| `use-recover.ts` | React hook behind `/recover` (identify, progress, refresh, cancel). |
| `recover-form.tsx` | The `/recover` card (markup only; client component). |
| `did-key.ts` | Base58btc / `did:key` encoding. |
| `encoding.ts` | base64url, hex and byte helpers. |
| `errors.ts` | Typed errors and cancellation detection. |

## Tests

```bash
npm test --workspace apps/web -- src/features/web-auth
```

The suite uses real Node WebCrypto for key generation and export-refusal
checks, and a small in-memory IndexedDB fake for persistence. The sign-in
tests run the whole flow against a fake API that verifies the Ed25519
signature the way the real one does (key taken from the did, message = nonce
UTF-8 bytes). The onboarding tests drive the same shape of fake API client
(plus `MemoryTokenStorage` for the persisted progress) and canonical
`did:key`s generated exactly the way the API's own tests generate them.

Vitest here cannot transform JSX (`tsconfig.json` sets `jsx: "preserve"`), so
sign-in behaviour lives in `use-signin.ts` and is tested with `renderHook`;
`signin-form.tsx` is markup only.

The page was also exercised once in headless Chromium with a CDP virtual
passkey authenticator against a running API: new account → `/onboarding`,
returning sign-in following `?next=`, and an off-site `next` ignored. That is
not an automated test. Running it from this repo needs the browser to reach the
API on one origin: the API sends no CORS headers (a cross-origin preflight to
`/v1/auth/challenge` is answered `405`), so with the web app and API on
different origins the button ends in "Can't reach Scholium".
