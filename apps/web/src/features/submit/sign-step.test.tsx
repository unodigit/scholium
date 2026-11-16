// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import type { ConsentReport } from "./consents";
import type { ChecksVersionRef, FetchChecks, VersionChecks } from "./checks";
import { SignStep } from "./sign-step";
import type { SignedRecord } from "../web-auth";

const ME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const PDF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

afterEach(cleanup);

function notFound(): ApiError {
  return new ApiError(404, { type: "about:blank", title: "Not Found", status: 404 });
}

function signed(type: string): SignedRecord {
  return {
    v: 1,
    type,
    id: `bafyrei-${type}`,
    author: ME,
    created: "2026-11-16T12:00:00Z",
    prev: null,
    body: {},
    proofs: [],
    sig: "sig",
  };
}

function consents(): ConsentReport {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "awaiting_consent",
    declinedBy: null,
    count: 1,
    waiting: 1,
    signed: 0,
    declined: 0,
    authors: [{ did: ME, position: 1, status: "waiting" }],
  };
}

function checksReport(): VersionChecks {
  return {
    paper: "sch:abcd-efgh-ijkl",
    version: 1,
    versionCid: "bafyreiversion",
    state: "moderation",
    files: [
      {
        path: "paper.pdf",
        cid: PDF,
        role: "pdf",
        status: "passed",
        failedChecks: [],
        detail: null,
      },
    ],
    referencesTotal: 10,
    referencesUnresolved: 2,
    similarityPct: 4.2,
    metadataMatch: true,
    signedTitle: null,
    firstPageTitle: null,
    checkedAt: null,
  };
}

/** Render the step with everything injected, then press Sign and submit. */
async function signAndSubmit(fetchChecks: FetchChecks): Promise<void> {
  render(
    <SignStep
      files={[
        { id: "1", path: "paper.pdf", size: 2, mediaType: "application/pdf", role: "pdf", cid: PDF },
      ]}
      details={{
        title: "Sparse Probing of Reward Models",
        abstract: "",
        categories: ["cs.AI"],
        licence: "CC-BY-4.0",
      }}
      authors={[]}
      signRecord={vi
        .fn()
        .mockImplementation((type: string) => Promise.resolve(signed(type)))}
      submitRecord={vi
        .fn()
        .mockImplementation((record: SignedRecord) =>
          Promise.resolve({ id: record.id, shortId: "sch:abcd-efgh-ijkl" }),
        )}
      fetchConsents={vi.fn().mockResolvedValue(consents())}
      fetchChecks={fetchChecks}
      pollMs={0}
      checksPollMs={10}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign and submit" }));
  await screen.findByText("Status", { selector: ".sw-status-tracker__title" });
}

describe("SignStep — the status tracker's checks", () => {
  it("says Checks pending while the route answers 404, then shows the advisory report", async () => {
    // The first ask 404s (the version is being scanned); the retry lands the
    // report, and the tracker shows it without blocking anything.
    let landReport: ((report: VersionChecks) => void) | undefined;
    const fetchChecks = vi.fn(
      (_ref: ChecksVersionRef, _signal?: AbortSignal): Promise<VersionChecks> => {
        if (fetchChecks.mock.calls.length === 1) {
          return Promise.reject(notFound());
        }
        return new Promise<VersionChecks>((resolve) => {
          landReport = resolve;
        });
      },
    );
    await signAndSubmit(fetchChecks);

    expect(await screen.findByText(/Checks pending/)).toBeTruthy();
    await vi.waitFor(() => expect(landReport).toBeDefined());

    await act(async () => {
      landReport?.(checksReport());
    });
    const region = await screen.findByRole("region", { name: "Automated checks" });
    expect(within(region).getByText("File safety")).toBeTruthy();
    expect(within(region).getByText("References")).toBeTruthy();
    expect(within(region).getByText("Similarity")).toBeTruthy();
    expect(within(region).getByText("Metadata match")).toBeTruthy();
    expect(within(region).getByText("8 of 10 references resolved")).toBeTruthy();
    expect(within(region).getByText("3 of 4 checks passed, 1 to fix or look at.")).toBeTruthy();
    expect(fetchChecks).toHaveBeenCalledWith(
      { paper: "sch:abcd-efgh-ijkl", version: 1 },
      expect.anything(),
    );
  });

  it("keeps saying Checks pending for as long as the route answers 404", async () => {
    const fetchChecks: FetchChecks = vi.fn().mockImplementation(() => Promise.reject(notFound()));
    await signAndSubmit(fetchChecks);

    expect(await screen.findByText(/Checks pending/)).toBeTruthy();
    // The advisory rows are not invented while the node has nothing to say.
    expect(screen.queryByText("File safety")).toBeNull();
    expect(screen.queryByText("3 of 4 checks passed")).toBeNull();
  });
});
