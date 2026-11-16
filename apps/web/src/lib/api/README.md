# `@/lib/api` — Scholium API client

One typed entry point for talking to the Scholium API (feature 131).

- Targets `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).
- Relative paths are prefixed with `/v1` (`/records` → `/v1/records`).
- Attaches the in-memory bearer access token.
- On a `401`, refreshes once via `POST /v1/auth/refresh` (the browser sends the
  HttpOnly refresh cookie), then replays the request. Concurrent 401s share a
  single refresh.
- Turns `application/problem+json` bodies into `ApiError` instances carrying
  the full RFC 9457 `problem` object, `status`, `detail`, `instance` and
  `fieldErrors` (the 422 `errors` array).

## Usage

```ts
import { api, apiClient, ApiError, tokenStore } from "@/lib/api";

// After sign-in (the API sets the refresh token as an HttpOnly cookie):
tokenStore.set({ accessToken });

// On page load, turn the cookie back into an access token:
await apiClient.refresh();

const paper = await api.get<Paper>(`/papers/${id}`);

try {
  await api.post("/records", envelope);
} catch (error) {
  if (error instanceof ApiError) {
    if (error.isValidationError) {
      showFieldErrors(error.fieldErrors); // [{ field, message }]
    } else if (error.isRateLimited) {
      retryIn(error.retryAfter);
    } else {
      toast(error.title, error.detail);
    }
  }
}
```

Other helpers: `apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`,
`apiFetch`, or construct an isolated client with `createApiClient({ baseUrl })`.

## Options worth knowing

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `NEXT_PUBLIC_API_URL` | API origin |
| `apiPrefix` | `/v1` | Prefix for relative paths; `""` disables it |
| `tokenStore` | shared in-memory store | Where the access token is read/written |
| `refreshPath` | `/v1/auth/refresh` | Token rotation endpoint |
| `retryOnUnauthorized` | `true` | Refresh + replay once on a 401 |

Per request: `{ auth: false }` for public calls, `{ prefix: false }` for
unversioned routes such as `/healthz`, `{ query: {...} }`, `{ parse: "text" }`.

## Token storage

`tokenStore` keeps `{ accessToken, tokenType, expiresAt }` **in memory only**.
Nothing is written to `localStorage`/`sessionStorage`, where any injected script
could read it, so a reload starts signed out until `apiClient.refresh()` trades
the refresh cookie for a new access token.

The refresh token is never stored by this client. The API issues it as an
`HttpOnly`, `SameSite=Strict` cookie (`Secure` except on `http://localhost`)
scoped to `/v1/auth/refresh`; the refresh call is a bodiless `POST` with
`credentials: "include"`, and a `refreshToken` passed to `tokenStore.set` is
ignored. Older builds persisted the pair under `scholium.auth.tokens`; that key
is deleted on load (`purgeLegacyPersistedTokens`).

Use `setTokens`, `getTokens`, `clearTokens`, `isAuthenticated` and
`tokenStore.subscribe(fn)` for auth UI. An unrecoverable 401 dispatches a
`scholium:unauthorized` window event and calls the client's `onUnauthorized`
hook.

## Tests

`npx vitest run src/lib/api` (from `apps/web`)
