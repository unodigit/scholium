import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../../lib/api";
import {
  enrichAppealCases,
  loadAppealsForViewer,
  type AppealCase,
} from "./appeals";

const APPEAL = "bafy-appeal-1";

function appeal(overrides: Partial<AppealCase> = {}): AppealCase {
  return {
    appealCid: APPEAL,
    decisionCid: "bafy-decision-1",
    appellantDid: "did:key:z6MkAuthor",
    grounds: "Unfair.",
    filedAt: "2027-05-04T09:30:00Z",
    original: {
      action: "hide",
      clause: "MOD-09",
      reason: "Abusive.",
      moderatorDid: "did:key:z6MkModerator",
      versionCid: "bafy-post-1",
    },
    paper: null,
    verdict: null,
    ...overrides,
  };
}

const DETAIL = {
  id: APPEAL,
  viewer_on_panel: true,
  viewer_vote: "upheld",
  viewer_voted_at: "2026-11-18T09:30:00Z",
  votes_cast: 1,
  target_cid: "bafy-post-1",
  target_kind: "post",
  record_type: "discussion.post",
  paper_title: "Sparse attention without the quadratic cost",
  excerpt: "This is wrong and you know it.",
  target_link: "/discussion/sch:k3f9-q2xz-7mwd",
  decision_action: "hide",
  panel_status: "not_formed",
  deadline: "2027-05-18T09:30:00Z",
};

function client(body: unknown) {
  return { get: vi.fn(async (_path: string, _options?: unknown) => body) };
}

describe("enrichAppealCases", () => {
  it("says whether the viewer is on the panel, and how they voted", async () => {
    const api = client(DETAIL);

    const [enriched] = await enrichAppealCases([appeal()], api as never);

    expect(enriched?.viewerOnPanel).toBe(true);
    expect(enriched?.viewerVote).toBe("upheld");
    // A reload needs both the vote and when it was cast, so the form can open
    // in its recorded state instead of asking the member to vote again.
    expect(enriched?.viewerVotedAt).toBe("2026-11-18T09:30:00Z");
    expect(enriched?.votesCast).toBe(1);
    // The caller's own token is sent: the answer is about them.
    expect(api.get).toHaveBeenCalledWith(
      `/appeals/${APPEAL}`,
      expect.not.objectContaining({ auth: false }),
    );
  });

  it("says the viewer is not on the panel when the API does", async () => {
    const [enriched] = await enrichAppealCases(
      [appeal()],
      client({
        ...DETAIL,
        viewer_on_panel: false,
        viewer_vote: null,
        viewer_voted_at: null,
        votes_cast: 0,
      }) as never,
    );

    expect(enriched?.viewerOnPanel).toBe(false);
    expect(enriched?.viewerVote).toBeNull();
    expect(enriched?.viewerVotedAt).toBeNull();
  });

  it("describes what the appealed decision was about", async () => {
    const [enriched] = await enrichAppealCases([appeal()], client(DETAIL) as never);

    expect(enriched?.subject).toEqual({
      kind: "post",
      recordType: "discussion.post",
      title: "Sparse attention without the quadratic cost",
      excerpt: "This is wrong and you know it.",
      link: "/discussion/sch:k3f9-q2xz-7mwd",
      action: "hide",
    });
    expect(enriched?.panelStatus).toBe("not_formed");
    expect(enriched?.deadline).toBe("2027-05-18T09:30:00Z");
  });

  it("leaves a case as the log gave it when its detail cannot be read", async () => {
    const original = appeal();
    const failing = {
      get: vi.fn(async () => {
        throw new ApiError(404, { status: 404, detail: "No such appeal." });
      }),
    };

    const [enriched] = await enrichAppealCases([original], failing as never);

    expect(enriched).toEqual(original);
    expect(enriched?.viewerOnPanel).toBeUndefined();
  });

  it("ignores an answer that is not an appeal", async () => {
    const original = appeal();

    const [enriched] = await enrichAppealCases([original], client([1, 2, 3]) as never);

    expect(enriched).toEqual(original);
  });

  it("asks about every appeal, however many there are", async () => {
    const cases = Array.from({ length: 15 }, (_, index) =>
      appeal({ appealCid: `bafy-appeal-${index}` }),
    );
    const api = client(DETAIL);

    const enriched = await enrichAppealCases(cases, api as never);

    expect(api.get).toHaveBeenCalledTimes(15);
    expect(enriched.map((item) => item.appealCid)).toEqual(
      cases.map((item) => item.appealCid),
    );
  });
});

describe("loadAppealsForViewer", () => {
  it("enriches the appeals the log holds", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/sync/range") {
        return [
          {
            seq: 1,
            record_cid: "bafy-decision-1",
            record_type: "moderation.decision",
            author_did: "did:key:z6MkModerator",
            body: { target: "bafy-post-1", action: "hide", clause: "MOD-09", reason: "Abusive." },
          },
          {
            seq: 2,
            record_cid: APPEAL,
            record_type: "appeal",
            author_did: "did:key:z6MkAuthor",
            body: { target: "bafy-decision-1", grounds: "Unfair." },
          },
        ];
      }
      return DETAIL;
    });

    const load = await loadAppealsForViewer({ get } as never);

    expect(load.cases).toHaveLength(1);
    expect(load.cases[0]?.viewerOnPanel).toBe(true);
    expect(load.cases[0]?.subject?.kind).toBe("post");
  });
});
