# web-auth — passkey-gated device key

Feature 140. Creates a **non-extractable Ed25519 WebCrypto signing key**,
persists it in **IndexedDB**, and requires a **WebAuthn passkey assertion**
before it will sign. The private key never leaves the device: there is no
code path that exports it.

Later `web-auth` features build the `/signin`, `/onboarding` and `/recover`
pages on top of this module. Import from `@/features/web-auth`.

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
| `did-key.ts` | Base58btc / `did:key` encoding. |
| `encoding.ts` | base64url, hex and byte helpers. |
| `errors.ts` | Typed errors and cancellation detection. |

## Tests

```bash
cd apps/web && pnpm exec vitest run src/features/web-auth
```

The suite uses real Node WebCrypto for key generation and export-refusal
checks, and a small in-memory IndexedDB fake for persistence. Browser
behavior (actual passkey sheets, actual IndexedDB) still needs the Playwright
journey for `/signin`.
