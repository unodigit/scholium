import { Upload } from "tus-js-client";
import { describe, expect, it, vi } from "vitest";

import {
  describeFailure,
  shouldRetry,
  startTusUpload,
  type TusUploadCallbacks,
  type UploadFactory,
} from "./tus-upload";

/* ---------------------------------------------------------------------------
   A miniature of the API's tus endpoint, standing in for the network.

   It speaks the same protocol as apps/api's `uploads` module: creation answers
   201 + Location (a path, as the API's does), HEAD reports Upload-Offset, a
   PATCH at the wrong offset is a 409, and the PATCH that delivers the last byte
   answers with Upload-Cid. The real tus-js-client talks to it through its
   `httpStack` option, so these tests exercise the real library, not a mock of it.
   ------------------------------------------------------------------------- */

interface StoredUpload {
  length: number;
  offset: number;
  metadata: string;
  cid: string | null;
}

class FakeResponse {
  constructor(
    private readonly status: number,
    private readonly headers: Record<string, string> = {},
    private readonly body = "",
  ) {}
  getStatus = () => this.status;
  getHeader = (name: string) => this.headers[name.toLowerCase()];
  getBody = () => this.body;
  getUnderlyingObject = () => ({});
}

class FakeApi {
  readonly uploads = new Map<string, StoredUpload>();
  readonly log: { method: string; url: string; headers: Record<string, string> }[] = [];
  /** Statuses to answer the next PATCH requests with instead of handling them. */
  failPatches: number[] = [];
  private nextId = 1;

  createRequest(method: string, url: string) {
    const headers: Record<string, string> = {};
    let onProgress: (bytes: number) => void = () => undefined;
    return {
      getMethod: () => method,
      getURL: () => url,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      setProgressHandler: (handler: (bytes: number) => void) => {
        onProgress = handler;
      },
      send: async (body?: Uint8Array | null) => {
        this.log.push({ method, url, headers: { ...headers } });
        const response = this.handle(method, url, headers, body ?? null);
        onProgress(body?.length ?? 0);
        return response;
      },
      abort: () => Promise.resolve(),
      getUnderlyingObject: () => ({}),
    };
  }

  getName = () => "fake-api";

  /** An upload the server already holds `offset` bytes of. */
  seed(id: string, length: number, offset: number): void {
    this.uploads.set(id, { length, offset, metadata: "", cid: offset === length ? `bafkrei${id}` : null });
  }

  private handle(method: string, url: string, headers: Record<string, string>, body: Uint8Array | null) {
    const path = new URL(url).pathname;
    if (method === "POST" && path === "/v1/uploads") {
      const id = `u${this.nextId++}`;
      this.uploads.set(id, {
        length: Number(headers["upload-length"]),
        offset: 0,
        metadata: headers["upload-metadata"] ?? "",
        cid: null,
      });
      return new FakeResponse(201, { location: `/v1/uploads/${id}` });
    }

    const upload = this.uploads.get(path.split("/").pop() ?? "");
    if (!upload) {
      return new FakeResponse(404);
    }
    if (method === "HEAD") {
      return new FakeResponse(200, {
        "upload-offset": String(upload.offset),
        "upload-length": String(upload.length),
      });
    }
    if (method === "PATCH") {
      const failure = this.failPatches.shift();
      if (failure) {
        return new FakeResponse(failure);
      }
      if (Number(headers["upload-offset"]) !== upload.offset) {
        return new FakeResponse(409, { "upload-offset": String(upload.offset) });
      }
      upload.offset += body?.length ?? 0;
      const response: Record<string, string> = { "upload-offset": String(upload.offset) };
      if (upload.offset === upload.length) {
        upload.cid = `bafkrei${path.split("/").pop()}`;
        response["upload-cid"] = upload.cid;
      }
      return new FakeResponse(204, response);
    }
    return new FakeResponse(405);
  }
}

class MemoryUrlStorage {
  private readonly items = new Map<string, { fingerprint: string; upload: Record<string, unknown> }>();
  private counter = 0;
  async findAllUploads() {
    return [...this.items.values()].map((item) => item.upload);
  }
  async findUploadsByFingerprint(fingerprint: string) {
    return [...this.items.values()].filter((item) => item.fingerprint === fingerprint).map((item) => item.upload);
  }
  async removeUpload(key: string) {
    this.items.delete(key);
  }
  async addUpload(fingerprint: string, upload: Record<string, unknown>) {
    const key = `key-${this.counter++}`;
    this.items.set(key, { fingerprint, upload: { ...upload, urlStorageKey: key } });
    return key;
  }
}

/** A "file" the node build of tus-js-client can read: a Buffer carrying the File properties we use. */
function fakeFile(size: number, name = "paper.pdf", type = "application/pdf"): File {
  return Object.assign(Buffer.alloc(size, 7), { name, type, size }) as unknown as File;
}

function setup(options: { api?: FakeApi; storage?: MemoryUrlStorage } = {}) {
  const api = options.api ?? new FakeApi();
  const storage = options.storage ?? new MemoryUrlStorage();
  const createUpload: UploadFactory = (file, tusOptions) =>
    new Upload(file as never, {
      ...tusOptions,
      httpStack: api as never,
      urlStorage: storage as never,
      fingerprint: async () => "fingerprint-of-paper",
    });
  const callbacks = {
    onProgress: vi.fn(),
    onResumed: vi.fn(),
    onRetrying: vi.fn(),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
  } satisfies TusUploadCallbacks;
  const config = {
    endpoint: "http://api.test/v1/uploads",
    createUpload,
    chunkSize: 4,
    retryDelays: [0, 0],
    getAuthorization: () => undefined as string | undefined,
    isOnline: () => true,
  };
  return { api, storage, callbacks, config };
}

/** Wait until `condition` holds, failing the test (not hanging it) if it never does. */
async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000, interval: 5 });
}

describe("startTusUpload against the real tus-js-client", () => {
  it("creates the upload, sends it in chunks and reports the CID the server answers with", async () => {
    const { api, callbacks, config } = setup();
    startTusUpload(fakeFile(10), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0 || callbacks.onFailure.mock.calls.length > 0);

    expect(callbacks.onFailure).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).toHaveBeenCalledWith({
      cid: "bafkreiu1",
      url: "http://api.test/v1/uploads/u1",
    });
    expect(api.log.map((entry) => entry.method)).toEqual(["POST", "PATCH", "PATCH", "PATCH"]);
    expect(callbacks.onProgress).toHaveBeenLastCalledWith(10, 10);
    expect(callbacks.onResumed).not.toHaveBeenCalled();
  });

  it("declares the size and the file's name, type and role in the creation request", async () => {
    const { api, callbacks, config } = setup();
    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);

    const creation = api.log[0];
    expect(creation.headers["upload-length"]).toBe("8");
    expect(creation.headers["tus-resumable"]).toBe("1.0.0");

    const metadata = Object.fromEntries(
      creation.headers["upload-metadata"].split(",").map((pair) => {
        const [key, value] = pair.split(" ");
        return [key, Buffer.from(value, "base64").toString("utf8")];
      }),
    );
    expect(metadata).toEqual({ filename: "paper.pdf", filetype: "application/pdf", role: "pdf" });
  });

  it("leaves the media type out when the browser does not know it", async () => {
    const { api, callbacks, config } = setup();
    startTusUpload(fakeFile(8, "data.bin", ""), { role: "data" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);
    expect(api.log[0].headers["upload-metadata"]).not.toContain("filetype");
  });

  it("sends the bearer token with every request when there is one", async () => {
    const { api, callbacks, config } = setup();
    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, { ...config, getAuthorization: () => "Bearer abc" });
    await until(() => callbacks.onSuccess.mock.calls.length > 0);
    expect(api.log.length).toBeGreaterThan(0);
    expect(api.log.every((entry) => entry.headers.authorization === "Bearer abc")).toBe(true);
  });

  it("sends no Authorization header when signed out", async () => {
    const { api, callbacks, config } = setup();
    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);
    expect(api.log.some((entry) => "authorization" in entry.headers)).toBe(false);
  });

  it("continues an earlier partial upload of the same file from the server's offset", async () => {
    const { api, storage, callbacks, config } = setup();
    api.seed("earlier", 12, 8);
    await storage.addUpload("fingerprint-of-paper", {
      size: 12,
      metadata: {},
      creationTime: new Date().toISOString(),
      uploadUrl: "http://api.test/v1/uploads/earlier",
      parallelUploadUrls: null,
    });

    startTusUpload(fakeFile(12), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);

    expect(callbacks.onResumed).toHaveBeenCalledTimes(1);
    expect(api.log.map((entry) => entry.method)).toEqual(["HEAD", "PATCH"]);
    expect(api.log[1].headers["upload-offset"]).toBe("8");
    expect(callbacks.onSuccess).toHaveBeenCalledWith({
      cid: "bafkreiearlier",
      url: "http://api.test/v1/uploads/earlier",
    });
  });

  it("starts a new upload when told not to resume", async () => {
    const { api, storage, callbacks, config } = setup();
    api.seed("earlier", 12, 8);
    await storage.addUpload("fingerprint-of-paper", {
      size: 12,
      metadata: {},
      creationTime: new Date().toISOString(),
      uploadUrl: "http://api.test/v1/uploads/earlier",
      parallelUploadUrls: null,
    });

    startTusUpload(fakeFile(12), { role: "pdf", fresh: true }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);

    expect(callbacks.onResumed).not.toHaveBeenCalled();
    expect(api.log[0].method).toBe("POST");
  });

  it("starts over, with a new upload, when the remembered one is gone from the server", async () => {
    const { api, storage, callbacks, config } = setup();
    await storage.addUpload("fingerprint-of-paper", {
      size: 12,
      metadata: {},
      creationTime: new Date().toISOString(),
      uploadUrl: "http://api.test/v1/uploads/vanished",
      parallelUploadUrls: null,
    });

    startTusUpload(fakeFile(12), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0);

    expect(api.log.map((entry) => entry.method).slice(0, 2)).toEqual(["HEAD", "POST"]);
    expect(callbacks.onSuccess.mock.calls[0][0].cid).toBe("bafkreiu1");
  });

  it("fetches the CID with an empty PATCH when the final response was lost", async () => {
    const { api, storage, callbacks, config } = setup();
    // The server has every byte (and a CID) but the client never saw the final answer.
    api.seed("done", 12, 12);
    await storage.addUpload("fingerprint-of-paper", {
      size: 12,
      metadata: {},
      creationTime: new Date().toISOString(),
      uploadUrl: "http://api.test/v1/uploads/done",
      parallelUploadUrls: null,
    });
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 204, headers: { "Upload-Cid": "bafkreidone" } }),
    );

    startTusUpload(fakeFile(12), { role: "pdf" }, callbacks, {
      ...config,
      getAuthorization: () => "Bearer abc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await until(() => callbacks.onSuccess.mock.calls.length > 0);

    expect(callbacks.onSuccess).toHaveBeenCalledWith({
      cid: "bafkreidone",
      url: "http://api.test/v1/uploads/done",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/uploads/done");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "12",
      "Content-Type": "application/offset+octet-stream",
      Authorization: "Bearer abc",
    });
  });

  it("fails as 'unconfirmed' when the CID cannot be recovered either", async () => {
    const { api, storage, callbacks, config } = setup();
    api.seed("done", 12, 12);
    await storage.addUpload("fingerprint-of-paper", {
      size: 12,
      metadata: {},
      creationTime: new Date().toISOString(),
      uploadUrl: "http://api.test/v1/uploads/done",
      parallelUploadUrls: null,
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });

    startTusUpload(fakeFile(12), { role: "pdf" }, callbacks, { ...config, fetchImpl: fetchImpl as never });
    await until(() => callbacks.onFailure.mock.calls.length > 0);

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onFailure.mock.calls[0][0]).toMatchObject({ kind: "unconfirmed", retryable: true });
  });

  it("retries a 503, says so, and still finishes", async () => {
    const { api, callbacks, config } = setup();
    api.failPatches = [503];
    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onSuccess.mock.calls.length > 0 || callbacks.onFailure.mock.calls.length > 0);

    expect(callbacks.onRetrying).toHaveBeenCalledTimes(1);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
  });

  it("gives up on a 413 at once, with the server's own explanation", async () => {
    const { api, callbacks, config } = setup();
    const detail = "PDF uploads are limited to 50 MiB (52428800 bytes); the declared Upload-Length is 60000000 bytes.";
    const original = api.createRequest.bind(api);
    api.createRequest = (method, url) => {
      const request = original(method, url);
      if (method === "POST") {
        request.send = async () => {
          api.log.push({ method, url, headers: {} });
          return new FakeResponse(413, {}, JSON.stringify({ title: "Payload Too Large", status: 413, detail })) as never;
        };
      }
      return request;
    };

    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, config);
    await until(() => callbacks.onFailure.mock.calls.length > 0);

    expect(callbacks.onFailure.mock.calls[0][0]).toEqual({
      kind: "too-large",
      status: 413,
      message: detail,
      retryable: false,
    });
    expect(callbacks.onRetrying).not.toHaveBeenCalled();
    expect(api.log).toHaveLength(1);
  });

  it("is silent after stop()", async () => {
    const { callbacks, config } = setup();
    const handle = startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, config);
    await handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callbacks.onProgress).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });
});

describe("startTusUpload with a stub uploader", () => {
  it("reports a failure to even build the upload", async () => {
    const callbacks = {
      onProgress: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    };
    startTusUpload(fakeFile(8), { role: "pdf" }, callbacks, {
      createUpload: () => {
        throw new TypeError("Failed to fetch dynamically imported module");
      },
    });
    await until(() => callbacks.onFailure.mock.calls.length > 0);
    expect(callbacks.onFailure.mock.calls[0][0].kind).toBe("network");
  });

  it("does not start an upload that was stopped while it was being built", async () => {
    const start = vi.fn();
    const handle = startTusUpload(
      fakeFile(8),
      { role: "pdf" },
      { onProgress: vi.fn(), onSuccess: vi.fn(), onFailure: vi.fn() },
      {
        createUpload: async () => ({
          url: null,
          start,
          abort: async () => undefined,
          findPreviousUploads: async () => [],
          resumeFromPreviousUpload: () => undefined,
        }),
      },
    );
    await handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();
  });
});

/** What tus-js-client throws: an Error carrying the response that caused it. */
function httpError(status: number, body = ""): Error {
  return Object.assign(new Error(`tus: unexpected response (${status})`), {
    originalResponse: { getStatus: () => status, getBody: () => body },
  });
}

describe("describeFailure", () => {
  it("treats an error with no response as a lost connection that Retry can fix", () => {
    expect(describeFailure(new Error("network"))).toMatchObject({ kind: "network", status: null, retryable: true });
  });

  it("uses the problem-details `detail` of a 413 and does not offer a retry", () => {
    const failure = describeFailure(httpError(413, JSON.stringify({ detail: "Too big." })));
    expect(failure).toEqual({ kind: "too-large", status: 413, message: "Too big.", retryable: false });
  });

  it("falls back to a plain sentence when a 413 has no readable body", () => {
    expect(describeFailure(httpError(413, "<html>")).message).toBe("The server says this file is too large.");
  });

  it("says a 410 means starting over", () => {
    expect(describeFailure(httpError(410))).toMatchObject({ kind: "gone", retryable: true });
  });

  it("calls a 5xx the server's problem", () => {
    expect(describeFailure(httpError(503))).toMatchObject({
      kind: "server",
      status: 503,
      message: "The server had a problem (HTTP 503). Try again in a moment.",
    });
  });

  it("reports any other 4xx with the server's detail when it gave one", () => {
    expect(describeFailure(httpError(412, JSON.stringify({ detail: "Send Tus-Resumable." })))).toMatchObject({
      kind: "rejected",
      message: "Send Tus-Resumable.",
    });
    expect(describeFailure(httpError(404)).message).toBe("The server did not accept the upload (HTTP 404).");
  });
});

describe("shouldRetry", () => {
  it("retries lost connections and server errors while online", () => {
    expect(shouldRetry(new Error("network"))).toBe(true);
    expect(shouldRetry(httpError(500))).toBe(true);
    expect(shouldRetry(httpError(503))).toBe(true);
  });

  it("retries the 4xx answers that are about timing, not the request", () => {
    for (const status of [408, 409, 423, 429]) {
      expect(shouldRetry(httpError(status))).toBe(true);
    }
  });

  it("does not retry a request the server refused", () => {
    for (const status of [400, 401, 403, 404, 410, 412, 413, 415]) {
      expect(shouldRetry(httpError(status))).toBe(false);
    }
  });

  it("does not retry while offline: the online event restarts the upload instead", () => {
    expect(shouldRetry(new Error("network"), false)).toBe(false);
  });
});
