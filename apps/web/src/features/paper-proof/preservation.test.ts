import { describe, expect, it, vi } from "vitest";

import { NetworkError } from "../../lib/api";
import {
  LOCAL_PRESERVATION,
  NETWORK_PATH,
  loadPreservation,
  parsePreservation,
  preservationCopy,
  type PreservationClient,
} from "./preservation";

/** A `GET`-only client that records what it was asked, like source.test.ts. */
function clientOf(answer: (path: string) => unknown): {
  client: PreservationClient;
  calls: Array<{ path: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const client: PreservationClient = {
    async get<T>(path: string, options: Record<string, unknown> = {}) {
      calls.push({ path, options });
      return answer(path) as T;
    },
  };
  return { client, calls };
}

describe("parsePreservation", () => {
  it("reads the replicas summary of GET /v1/network", () => {
    expect(
      parsePreservation({
        node_did: "did:key:z6Mk",
        standing: "local",
        replicas: { have: 1, of: 1, local: true, summary: "1 of 1 local" },
      }),
    ).toEqual({ have: 1, of: 1, local: true });
    expect(
      parsePreservation({ replicas: { have: 2, of: 5, local: false, summary: "2 of 5" } }),
    ).toEqual({ have: 2, of: 5, local: false });
  });

  it("refuses a body that does not say, rather than guessing a state", () => {
    expect(parsePreservation(null)).toBeNull();
    expect(parsePreservation({})).toBeNull();
    expect(parsePreservation({ replicas: null })).toBeNull();
    expect(parsePreservation({ replicas: {} })).toBeNull();
    // Counts that are not whole numbers, or a target of zero replicas, say
    // nothing usable: a node holds at least one replica.
    expect(parsePreservation({ replicas: { have: 1, of: 0, local: true } })).toBeNull();
    expect(parsePreservation({ replicas: { have: 1.5, of: 1, local: true } })).toBeNull();
    expect(parsePreservation({ replicas: { have: -1, of: 1, local: true } })).toBeNull();
    expect(parsePreservation({ replicas: { have: "1", of: 1, local: true } })).toBeNull();
    expect(parsePreservation({ replicas: { have: 1, of: 1, local: "yes" } })).toBeNull();
  });
});

describe("preservationCopy", () => {
  it("names this deployment's single local copy and why that is all there is", () => {
    expect(preservationCopy(LOCAL_PRESERVATION)).toEqual({
      label: "Preserved: 1 of 1 local copy",
      note: "Multi-operator replication is not enabled yet.",
      pending: true,
    });
  });

  it("counts a replica set that is not only local, without the local note", () => {
    expect(preservationCopy({ have: 5, of: 5, local: false })).toEqual({
      label: "Preserved: 5 of 5 replicas",
      note: null,
      pending: false,
    });
    expect(preservationCopy({ have: 1, of: 5, local: false })).toEqual({
      label: "Preserved: 1 of 5 replicas",
      note: null,
      pending: true,
    });
  });

  it("pluralises one local copy", () => {
    // A local-only node configured to hold more than its one copy.
    expect(preservationCopy({ have: 1, of: 2, local: true })).toMatchObject({
      label: "Preserved: 1 of 2 local copies",
    });
  });
});

describe("loadPreservation", () => {
  it("reads the public network status without credentials", async () => {
    const { client, calls } = clientOf(() => ({
      replicas: { have: 1, of: 1, local: true, summary: "1 of 1 local" },
    }));
    await expect(loadPreservation(undefined, client)).resolves.toEqual({
      have: 1,
      of: 1,
      local: true,
    });
    expect(calls[0].path).toBe(NETWORK_PATH);
    expect(calls[0].options).toMatchObject({ auth: false });
  });

  it("answers null when the node cannot be read: the paper still verifies", async () => {
    const failing: PreservationClient = {
      async get() {
        throw new NetworkError("https://node.example/v1/network");
      },
    };
    await expect(loadPreservation(undefined, failing)).resolves.toBeNull();
  });

  it("answers null for a body that is not a network status", async () => {
    const { client } = clientOf(() => ({ detail: "nope" }));
    await expect(loadPreservation(undefined, client)).resolves.toBeNull();
  });

  it("passes the signal through so a cancelled read stops", async () => {
    const get = vi.fn(async () => ({}));
    const client = { get } as unknown as PreservationClient;
    const controller = new AbortController();
    controller.abort();
    await loadPreservation(controller.signal, client);
    expect(get).toHaveBeenCalledWith(NETWORK_PATH, expect.objectContaining({ signal: controller.signal }));
  });
});
