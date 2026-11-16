// @vitest-environment node
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  ApiClient,
  ApiError,
  MemoryTokenStorage,
  NetworkError,
  TokenStore,
  isTokenExpired,
  resolveApiBaseUrl,
  tokensFromResponse,
  type ApiClientOptions,
  type FetchLike,
} from "./index";

const BASE = "https://api.scholium.test";

interface Harness {
  client: ApiClient;
  store: TokenStore;
  fetchMock: Mock<FetchLike>;
}

function createHarness(options: ApiClientOptions = {}): Harness {
  const store = new TokenStore(new MemoryTokenStorage());
  const fetchMock = vi.fn<FetchLike>();
  const client = new ApiClient({
    baseUrl: BASE,
    tokenStore: store,
    fetch: fetchMock,
    ...options,
  });
  return { client, store, fetchMock };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function problemResponse(problem: Record<string, unknown>, status = 400): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function requestUrl(fetchMock: Harness["fetchMock"], call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function requestInit(fetchMock: Harness["fetchMock"], call = 0): RequestInit {
  return fetchMock.mock.calls[call]?.[1] ?? {};
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

/** Await a promise that is expected to reject and return its typed error. */
async function expectError<T extends Error = ApiError>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (error) {
    return error as T;
  }
  throw new Error("Expected the request to reject, but it resolved");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveApiBaseUrl", () => {
  it("reads NEXT_PUBLIC_API_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://env.api.test/");
    expect(resolveApiBaseUrl()).toBe("https://env.api.test");
  });

  it("falls back to localhost when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    expect(resolveApiBaseUrl()).toBe("http://localhost:8000");
  });

  it("lets an explicit base URL win", () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://env.api.test");
    expect(resolveApiBaseUrl("https://other.test/")).toBe("https://other.test");
  });
});

describe("ApiClient requests", () => {
  it("targets NEXT_PUBLIC_API_URL and prefixes /v1", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://env.api.test");
    const store = new TokenStore(new MemoryTokenStorage());
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ApiClient({ tokenStore: store, fetch: fetchMock });

    await expect(client.get("/papers/abc")).resolves.toEqual({ ok: true });
    expect(requestUrl(fetchMock)).toBe("https://env.api.test/v1/papers/abc");
  });

  it("does not double an explicit /v1 prefix", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({}));

    await client.get("/v1/papers/abc");
    expect(requestUrl(fetchMock)).toBe(`${BASE}/v1/papers/abc`);
  });

  it("can send a path without the API prefix", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    await client.get("/healthz", { prefix: false });
    expect(requestUrl(fetchMock)).toBe(`${BASE}/healthz`);
  });

  it("passes absolute URLs through", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({}));

    await client.get("https://elsewhere.test/thing");
    expect(requestUrl(fetchMock)).toBe("https://elsewhere.test/thing");
  });

  it("attaches the access token as a bearer header", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "access-1" });
    fetchMock.mockResolvedValue(jsonResponse({}));

    await client.get("/me");

    expect(header(requestInit(fetchMock), "Authorization")).toBe("Bearer access-1");
  });

  it("omits the token for public requests", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "access-1" });
    fetchMock.mockResolvedValue(jsonResponse({}));

    await client.get("/papers", { auth: false });

    expect(header(requestInit(fetchMock), "Authorization")).toBeNull();
  });

  it("honours an explicit Authorization header", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "access-1" });
    fetchMock.mockResolvedValue(jsonResponse({}));

    await client.get("/me", { headers: { Authorization: "Custom scheme" } });

    expect(header(requestInit(fetchMock), "Authorization")).toBe("Custom scheme");
  });

  it("JSON-encodes object bodies and sets the content type", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({ id: "cid" }));

    await client.post("/records", { type: "paper.genesis", body: { title: "Hi" } });

    const init = requestInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"type":"paper.genesis","body":{"title":"Hi"}}');
    expect(header(init, "Content-Type")).toContain("application/json");
    expect(header(init, "Accept")).toContain("application/problem+json");
  });

  it("leaves FormData bodies untouched", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({}));
    const form = new FormData();
    form.append("file", "content");

    await client.post("/uploads", form);

    expect(requestInit(fetchMock).body).toBe(form);
  });

  it("appends query parameters", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse([]));

    await client.get("/papers", {
      query: { page: 2, tag: ["ml", "bio"], missing: undefined, empty: null },
    });

    expect(requestUrl(fetchMock)).toBe(`${BASE}/v1/papers?page=2&tag=ml&tag=bio`);
  });

  it("merges query parameters into a path that already has one", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse([]));

    await client.get("/papers?sort=new", { query: { page: 1 } });

    expect(requestUrl(fetchMock)).toBe(`${BASE}/v1/papers?sort=new&page=1`);
  });

  it("decodes JSON responses", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(jsonResponse({ id: "abc", title: "Paper" }));

    await expect(client.get("/papers/abc")).resolves.toEqual({
      id: "abc",
      title: "Paper",
    });
  });

  it("returns undefined for 204 responses", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client.delete("/records/abc")).resolves.toBeUndefined();
  });

  it("can return the raw response", async () => {
    const { client, fetchMock } = createHarness();
    const response = jsonResponse({ raw: true }, 201);
    fetchMock.mockResolvedValue(response);

    await expect(client.post("/things", {}, { parse: "response" })).resolves.toBe(
      response,
    );
  });
});

describe("ApiClient problem details", () => {
  it("throws a typed ApiError from an RFC 9457 body", async () => {
    const { client, fetchMock } = createHarness();
    const problem = {
      type: "https://scholium.dev/problems/tier",
      title: "Forbidden",
      status: 403,
      detail: "Requires trust tier 3",
      instance: "/v1/moderation/queue",
    };
    fetchMock.mockResolvedValue(problemResponse(problem, 403));

    const error = await expectError(client.get("/moderation/queue"));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ApiError",
      status: 403,
      title: "Forbidden",
      detail: "Requires trust tier 3",
      type: "https://scholium.dev/problems/tier",
      instance: "/v1/moderation/queue",
    });
    expect(error.isForbidden).toBe(true);
    expect(error.isClientError).toBe(true);
    expect(error.isServerError).toBe(false);
    expect(error.problem).toEqual(problem);
    expect(error.message).toBe("Requires trust tier 3");
  });

  it("exposes field-level errors from a 422", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(
      problemResponse(
        {
          type: "about:blank",
          title: "Unprocessable Content",
          status: 422,
          errors: [
            { field: "body.title", message: "Field required" },
            { loc: ["body", "files", 0, "path"], msg: "Invalid path" },
          ],
        },
        422,
      ),
    );

    const error = await expectError(client.post("/records", {}));

    expect(error.isValidationError).toBe(true);
    expect(error.fieldErrors).toHaveLength(2);
    expect(error.fieldErrors[0]).toMatchObject({
      field: "body.title",
      message: "Field required",
    });
    expect(error.fieldErrors[1]).toMatchObject({
      field: "body.files.0.path",
      message: "Invalid path",
    });
    expect(error.errors).toBe(error.fieldErrors);
  });

  it("synthesises problem details for a non-problem error body", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await expectError(client.get("/oops"));

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.title).toBe("Internal Server Error");
    expect(error.detail).toBe("boom");
    expect(error.type).toBe("about:blank");
    expect(error.isServerError).toBe(true);
  });

  it("reads a Retry-After header on a 429", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ title: "Too Many Requests", status: 429, detail: "Slow down" }),
        {
          status: 429,
          headers: {
            "content-type": "application/problem+json",
            "retry-after": "17",
          },
        },
      ),
    );

    const error = await expectError(client.post("/records", {}));

    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfter).toBe(17);
  });

  it("turns a transport failure into a NetworkError", async () => {
    const { client, fetchMock } = createHarness();
    const cause = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(cause);

    const error = await expectError<NetworkError>(client.get("/papers"));

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.url).toBe(`${BASE}/v1/papers`);
    expect((error as Error).cause).toBe(cause);
  });
});

describe("ApiClient token refresh", () => {
  // The refresh token is an HttpOnly cookie: the client never holds it, so a
  // refresh is a bodiless POST that the browser attaches the cookie to.
  it("refreshes on 401 via the cookie and replays the request once", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });

    fetchMock
      .mockResolvedValueOnce(problemResponse({ status: 401, title: "Unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "new-access", refresh_token: "refresh-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ did: "did:key:z6Mk" }));

    await expect(client.get("/me")).resolves.toEqual({ did: "did:key:z6Mk" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestUrl(fetchMock, 0)).toBe(`${BASE}/v1/me`);
    expect(header(requestInit(fetchMock, 0), "Authorization")).toBe("Bearer old-access");

    expect(requestUrl(fetchMock, 1)).toBe(`${BASE}/v1/auth/refresh`);
    expect(requestInit(fetchMock, 1).method).toBe("POST");
    // The cookie carries the token: no body, and credentials let the browser
    // send it to a cross-origin API.
    expect(requestInit(fetchMock, 1).body).toBeUndefined();
    expect(requestInit(fetchMock, 1).credentials).toBe("include");
    expect(header(requestInit(fetchMock, 1), "Authorization")).toBeNull();

    expect(requestUrl(fetchMock, 2)).toBe(`${BASE}/v1/me`);
    expect(header(requestInit(fetchMock, 2), "Authorization")).toBe("Bearer new-access");

    expect(store.get()).toEqual({ accessToken: "new-access", tokenType: "Bearer" });
  });

  it("never keeps the refresh token the response body carries", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });
    fetchMock
      .mockResolvedValueOnce(problemResponse({ status: 401, title: "Unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "new-access", refresh_token: "refresh-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await client.get("/me");

    expect(store.get()).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(store.get())).not.toContain("refresh-2");
  });

  it("shares one refresh between concurrent 401s", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });
    let refreshCalls = 0;

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return jsonResponse({ access_token: "new-access", refresh_token: "refresh-2" });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer old-access") {
        return problemResponse({ status: 401, title: "Unauthorized" }, 401);
      }
      return jsonResponse({ ok: true });
    });

    await expect(Promise.all([client.get("/a"), client.get("/b")])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    expect(refreshCalls).toBe(1);
    expect(store.accessToken).toBe("new-access");
  });

  it("clears tokens and surfaces the original problem when refresh fails", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });

    fetchMock
      .mockResolvedValueOnce(
        problemResponse(
          { status: 401, title: "Unauthorized", detail: "Token expired" },
          401,
        ),
      )
      .mockResolvedValueOnce(
        problemResponse({ status: 401, title: "Unauthorized", detail: "Bad refresh" }, 401),
      );

    const error = await expectError(client.get("/me"));

    expect(error.status).toBe(401);
    expect(error.detail).toBe("Token expired");
    expect(store.get()).toBeNull();
  });

  it("reports unrecoverable 401s to onUnauthorized", async () => {
    const store = new TokenStore(new MemoryTokenStorage());
    store.set({ accessToken: "old-access" });
    const onUnauthorized = vi.fn();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(problemResponse({ status: 401, title: "Unauthorized" }, 401))
      .mockResolvedValueOnce(problemResponse({ status: 401, title: "Unauthorized" }, 401));
    const client = new ApiClient({
      baseUrl: BASE,
      tokenStore: store,
      fetch: fetchMock,
      onUnauthorized,
    });

    await expect(client.get("/me")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);
  });

  it("asks the API to refresh even though the client holds no refresh token", async () => {
    // The cookie is invisible to script, so the only way to learn whether a
    // refresh is possible is to try; a browser without the cookie gets a 4xx.
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });
    fetchMock
      .mockResolvedValueOnce(problemResponse({ status: 401, title: "Unauthorized" }, 401))
      .mockResolvedValueOnce(problemResponse({ status: 422, title: "Unprocessable" }, 422));

    await expect(client.get("/me")).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 1)).toBe(`${BASE}/v1/auth/refresh`);
    expect(store.get()).toBeNull();
  });

  it("honours retryOnUnauthorized: false", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });
    fetchMock.mockResolvedValue(problemResponse({ status: 401, title: "Unauthorized" }, 401));

    await expect(
      client.get("/me", { retryOnUnauthorized: false }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a 401 on an unauthenticated request", async () => {
    const { client, fetchMock } = createHarness();
    fetchMock.mockResolvedValue(problemResponse({ status: 401, title: "Unauthorized" }, 401));

    await expect(client.get("/me")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores a session on page load from the cookie alone", async () => {
    // Reload: the access token lived in memory and is gone, the cookie is not.
    const { client, store, fetchMock } = createHarness();
    expect(store.get()).toBeNull();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "restored-access", refresh_token: "refresh-3" }),
    );

    await expect(client.refresh()).resolves.toMatchObject({ accessToken: "restored-access" });

    expect(requestUrl(fetchMock, 0)).toBe(`${BASE}/v1/auth/refresh`);
    expect(requestInit(fetchMock, 0).credentials).toBe("include");
    expect(requestInit(fetchMock, 0).body).toBeUndefined();
    expect(store.accessToken).toBe("restored-access");
  });

  it("keeps the session when the refresh fails on the network", async () => {
    const { client, store, fetchMock } = createHarness();
    store.set({ accessToken: "old-access" });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));

    await expect(client.refresh()).resolves.toBeNull();

    expect(store.accessToken).toBe("old-access");
  });
});

describe("tokensFromResponse", () => {
  it("accepts the API's snake_case fields", () => {
    const before = Date.now();
    const tokens = tokensFromResponse({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 900,
    });

    expect(tokens).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
    });
    expect(tokens?.expiresAt).toBeGreaterThanOrEqual(before + 900_000);
  });

  it("accepts camelCase fields", () => {
    expect(
      tokensFromResponse({ accessToken: "access", refreshToken: "refresh" }),
    ).toEqual({ accessToken: "access", refreshToken: "refresh", tokenType: "Bearer" });
  });

  it("returns null without an access token", () => {
    expect(tokensFromResponse({ refresh_token: "refresh" })).toBeNull();
    expect(tokensFromResponse(null)).toBeNull();
    expect(tokensFromResponse("nope")).toBeNull();
  });

  it("detects expiry", () => {
    expect(isTokenExpired({ accessToken: "a", expiresAt: Date.now() - 1 })).toBe(true);
    expect(isTokenExpired({ accessToken: "a", expiresAt: Date.now() + 60_000 })).toBe(false);
    expect(isTokenExpired({ accessToken: "a" })).toBe(false);
  });
});
