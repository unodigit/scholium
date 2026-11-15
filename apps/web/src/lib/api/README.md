# `@/lib/api` — Scholium API client

One typed entry point for talking to the Scholium API (feature 131).

- Targets `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).
- Relative paths are prefixed with `/v1` (`/records` → `/v1/records`).
- Attaches the stored bearer access token.
- On a `401`, refreshes once via `POST /v1/auth/refresh`, then replays the
  request. Concurrent 401s share a single refresh.
- Turns `application/problem+json` bodies into `ApiError` instances carrying
  the full RFC 9457 `problem` object, `status`, `detail`, `instance` and
  `fieldErrors` (the 422 `errors` array).

## Usage

```ts
import { api, ApiError, tokenStore } from "@/lib/api";

// After sign-in:
tokenStore.set({ accessToken, refreshToken });

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
| `tokenStore` | shared browser store | Where tokens are read/written |
| `refreshPath` | `/v1/auth/refresh` | Token rotation endpoint |
| `retryOnUnauthorized` | `true` | Refresh + replay once on a 401 |

Per request: `{ auth: false }` for public calls, `{ prefix: false }` for
unversioned routes such as `/healthz`, `{ query: {...} }`, `{ parse: "text" }`.

## Token storage

`tokenStore` persists `{ accessToken, refreshToken, tokenType, expiresAt }` in
`localStorage` under `scholium.auth.tokens` and falls back to an in-memory store
during server rendering. Use `setTokens`, `getTokens`, `clearTokens`,
`isAuthenticated` and `tokenStore.subscribe(fn)` for auth UI. An unrecoverable
401 dispatches a `scholium:unauthorized` window event and calls the client's
`onUnauthorized` hook.

## Tests

`pnpm exec vitest run src/lib/api`
