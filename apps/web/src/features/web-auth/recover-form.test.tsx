// @vitest-environment jsdom
import { createElement } from "react";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryTokenStorage } from "../../lib/api";

import {
  placeholderRecovery,
  savePersistedRecovery,
  type RecoverySnapshot,
} from "./recover";
import { RecoverForm } from "./recover-form";
import type { RecoveryServices } from "./use-recover";

const ORCID = "0000-0002-1825-0097";
const ACCOUNT_DID = "did:key:z6MkfBiVExampleAccountDidForRecoveryTests";
const NOW = Date.parse("2026-11-15T00:00:00Z");

/** The recovery the page was already tracking. */
function snapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return { ...placeholderRecovery("rec_1", ORCID, () => NOW), ...overrides };
}

function services(
  answer: (path: string) => unknown,
  overrides: Partial<RecoverySnapshot> = {},
) {
  const storage = new MemoryTokenStorage();
  savePersistedRecovery(storage, snapshot(overrides));
  const client = {
    get: vi.fn(async (path: string) => answer(path)),
    post: vi.fn(async () => ({ request_id: "rec_1", status: "pending" })),
  };
  const deviceKey = {
    exists: vi.fn(async () => true),
    didKey: vi.fn(async () => ACCOUNT_DID),
    ensure: vi.fn(async () => ({ credentialId: "cred", createdAt: NOW })),
    signWithPasskey: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  return {
    client,
    deviceKey,
    storage,
    now: () => NOW,
  } as unknown as RecoveryServices;
}

afterEach(() => {
  cleanup();
});

describe("the account on the recovery progress page", () => {
  it("names it by profile name when one exists, with the ORCID iD secondary", async () => {
    // The status route names the account's DID; its public profile has the
    // name the person knows. The page used to show only the ORCID iD.
    function answer(path: string): unknown {
      if (path.startsWith("/profiles/")) {
        return { name: "Mei Okafor" };
      }
      return {
        request_id: "rec_1",
        status: "pending",
        approvals: 0,
        did: ACCOUNT_DID,
      };
    }
    const payloads = services(answer);

    render(createElement(RecoverForm, { services: payloads }));

    expect(await screen.findByText("Mei Okafor")).toBeTruthy();
    // The iD stays on the card as the secondary fact.
    expect(screen.getAllByText(ORCID).length).toBeGreaterThan(0);
    expect(
      screen.getByText(`Recovering Mei Okafor (${ORCID}).`),
    ).toBeTruthy();
    expect(payloads.client.get).toHaveBeenCalledWith(
      `/profiles/${encodeURIComponent(ACCOUNT_DID)}`,
      expect.objectContaining({ auth: false }),
    );
  });

  it("keeps the ORCID iD alone when the profile has no name", async () => {
    function answer(path: string): unknown {
      if (path.startsWith("/profiles/")) {
        return { erased: false };
      }
      return {
        request_id: "rec_1",
        status: "pending",
        approvals: 0,
        did: ACCOUNT_DID,
      };
    }
    const payloads = services(answer);

    render(createElement(RecoverForm, { services: payloads }));

    expect(
      await screen.findByText(`Recovering ${ORCID}.`),
    ).toBeTruthy();
    expect(screen.queryByText(/Recovering the account you identified/)).toBeNull();
  });
});
