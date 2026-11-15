import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  MemoryTokenStorage,
  NetworkError,
  createApiClient,
  createTokenStore,
} from "../../lib/api";
import type { Viewer } from "../review-form/viewer";
import {
  INVITEE_PROBLEMS,
  NOT_INVITED,
  canInvite,
  checkInvitee,
  describeInviteError,
  inviteBody,
  invitationsPath,
  parseInvitation,
  sendInvitation,
} from "./invitation";

/**
 * The Invite reviewer action's logic (feature 187): who is offered it, what
 * counts as a reviewer's DID, the exact request sent to
 * `POST /v1/papers/{id}/review-invitations`, and the sentence for each way it
 * can fail. No React and no network: the request is checked by sending it
 * through the real API client against a stubbed `fetch`.
 */

const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const OKAFOR = "did:key:z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr";
const PAPER = "sch:6sel-2dio-orm6";

const signedIn = (did: string | null): Viewer => ({ signedIn: true, did, tier: 2 });

function problem(status: number, detail?: string): ApiError {
  return new ApiError(status, {
    status,
    title: "Problem",
    ...(detail !== undefined ? { detail } : {}),
  });
}

describe("canInvite: who is offered the action", () => {
  it("offers it to a signed-in viewer whose DID is on the byline", () => {
    expect(canInvite(signedIn(ALICE), [ALICE, BOB])).toBe(true);
    expect(canInvite(signedIn(BOB), [ALICE, BOB])).toBe(true);
  });

  it("does not offer it to a signed-in reader who is not an author", () => {
    expect(canInvite(signedIn(OKAFOR), [ALICE, BOB])).toBe(false);
  });

  it("does not offer it to a signed-out reader, even for a byline they could match", () => {
    expect(
      canInvite({ signedIn: false, did: ALICE, tier: null }, [ALICE]),
    ).toBe(false);
  });

  it("does not offer it when the token names no DID, because the byline cannot be matched", () => {
    expect(canInvite(signedIn(null), [ALICE])).toBe(false);
  });

  it("does not offer it on a paper with no listed authors", () => {
    expect(canInvite(signedIn(ALICE), [])).toBe(false);
  });
});

describe("checkInvitee: what was typed in the DID field", () => {
  it("accepts a did:key and returns it", () => {
    expect(checkInvitee(OKAFOR, [ALICE, BOB])).toEqual({ ok: true, did: OKAFOR });
  });

  it("accepts other DID methods: only the shape is checked", () => {
    expect(checkInvitee("did:web:example.edu", [])).toEqual({
      ok: true,
      did: "did:web:example.edu",
    });
  });

  it("ignores the space a pasted DID often carries", () => {
    expect(checkInvitee(`  ${OKAFOR}\n`, [ALICE])).toEqual({ ok: true, did: OKAFOR });
  });

  it("asks for a DID when the field is empty or only space", () => {
    for (const input of ["", "   ", "\n"]) {
      expect(checkInvitee(input, [ALICE])).toEqual({
        ok: false,
        problem: "empty",
        message: INVITEE_PROBLEMS.empty,
      });
    }
  });

  it("says so when the text is not a DID", () => {
    for (const input of [
      "Dr. Okafor",
      "okafor@example.edu",
      "https://scholium.example/u/did:key:z6Mk",
      "did:key",
      "did:key:",
      "did:key:z6Mk with space",
      "DID:key:z6Mk",
    ]) {
      expect(checkInvitee(input, [ALICE])).toMatchObject({
        ok: false,
        problem: "not-a-did",
      });
    }
  });

  it("refuses one of the paper's own authors: authors cannot review their own paper", () => {
    expect(checkInvitee(BOB, [ALICE, BOB])).toEqual({
      ok: false,
      problem: "is-author",
      message: INVITEE_PROBLEMS["is-author"],
    });
  });

  it("gives every problem a full sentence that says what to do or why", () => {
    for (const message of Object.values(INVITEE_PROBLEMS)) {
      expect(message).toMatch(/[.…]$/);
      expect(message.length).toBeGreaterThan(20);
    }
  });
});

describe("the request", () => {
  it("is POST /v1/papers/{id}/review-invitations, with the id encoded", () => {
    expect(invitationsPath(PAPER)).toBe("/papers/sch%3A6sel-2dio-orm6/review-invitations");
  });

  it("names the reviewer and sends the version as text, which the node reads as a hint", () => {
    expect(inviteBody({ paperId: PAPER, version: 2, reviewer: OKAFOR })).toEqual({
      reviewer: OKAFOR,
      version: "2",
    });
  });

  it("is sent through the API client with the author's bearer token", async () => {
    const fetchMock = vi.fn(async (..._args: [RequestInfo | URL, RequestInit?]) =>
      new Response(
        JSON.stringify({
          id: "inv-1",
          invitation_id: "inv-1",
          reviewer_did: OKAFOR,
          reviewer: OKAFOR,
          status: "pending",
          version_cid: "bafyrei-version-2",
          paper: PAPER,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const tokens = createTokenStore(new MemoryTokenStorage());
    tokens.set({ accessToken: "author-access-token" });
    const client = createApiClient({
      baseUrl: "http://node.test",
      fetch: fetchMock,
      tokenStore: tokens,
    });

    const invitation = await sendInvitation(
      { paperId: PAPER, version: 2, reviewer: OKAFOR },
      client,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://node.test/v1/papers/sch%3A6sel-2dio-orm6/review-invitations",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ reviewer: OKAFOR, version: "2" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer author-access-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(invitation).toEqual({ id: "inv-1", reviewer: OKAFOR, status: "pending" });
  });

  it("rejects with the node's problem when it refuses", async () => {
    const client = createApiClient({
      baseUrl: "http://node.test",
      tokenStore: createTokenStore(new MemoryTokenStorage()),
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: 403,
            title: "Forbidden",
            detail: "The invitee must be a tier-3 reviewer in the paper category.",
          }),
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    });

    await expect(
      sendInvitation({ paperId: PAPER, version: 2, reviewer: OKAFOR }, client),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("parseInvitation: the 201 body", () => {
  it("reads the id, the reviewer and the status in any of the node's spellings", () => {
    expect(
      parseInvitation({ invitationId: "i-2", reviewerDid: OKAFOR, status: "accepted" }, "x"),
    ).toEqual({ id: "i-2", reviewer: OKAFOR, status: "accepted" });
    expect(parseInvitation({ id: "i-3", reviewer: OKAFOR }, "x")).toEqual({
      id: "i-3",
      reviewer: OKAFOR,
      status: "pending",
    });
  });

  it("never turns a saved invitation into a failure: an unreadable body falls back to what was asked", () => {
    for (const raw of [undefined, null, "created", 7, [], {}]) {
      expect(parseInvitation(raw, OKAFOR)).toEqual({
        id: null,
        reviewer: OKAFOR,
        status: "pending",
      });
    }
  });
});

describe("describeInviteError", () => {
  it("sends an ended session to sign in", () => {
    expect(describeInviteError(problem(401))).toEqual({
      message: `Your session has ended. ${NOT_INVITED}`,
      signIn: true,
    });
  });

  it("shows a refusal in the node's own words, because it says what to change", () => {
    const said = "The invitee must be a tier-3 reviewer in the paper category.";
    expect(describeInviteError(problem(403, said))).toEqual({
      message: `${said} ${NOT_INVITED}`,
      signIn: false,
    });
  });

  it("adds the full stop the node's sentence may lack", () => {
    expect(describeInviteError(problem(403, "Not allowed")).message).toBe(
      `Not allowed. ${NOT_INVITED}`,
    );
  });

  it("says who may invite when a refusal has no reason of its own", () => {
    const { message } = describeInviteError(problem(403));
    expect(message).toMatch(/author of this paper/);
    expect(message).toMatch(/tier 3/);
    expect(message.endsWith(NOT_INVITED)).toBe(true);
  });

  it("says the paper was not found, and to reload", () => {
    const { message } = describeInviteError(problem(404, "No paper 'x' on this node."));
    expect(message).toMatch(/could not be found/);
    expect(message).toMatch(/Reload/);
    expect(message).toContain(NOT_INVITED);
  });

  it("says the node did not accept the reviewer on a 422, without the node's jargon", () => {
    const { message } = describeInviteError(problem(422, "reviewer is required"));
    expect(message).toMatch(/did not accept that reviewer/);
    expect(message).not.toMatch(/reviewer is required/);
    expect(message).toContain(NOT_INVITED);
  });

  it("does not claim the invitation was or was not saved when the node failed", () => {
    const { message, signIn } = describeInviteError(problem(503, "database is locked"));
    expect(signIn).toBe(false);
    expect(message).toMatch(/not confirmed as sent/);
    expect(message).not.toMatch(/database is locked/);
    expect(message).not.toContain(NOT_INVITED);
  });

  it("says the node could not be reached, and that nothing was sent", () => {
    const { message } = describeInviteError(new NetworkError("http://node.test/x"));
    expect(message).toMatch(/could not reach the node/);
    expect(message).toContain(NOT_INVITED);
  });

  it("uses the node's words for any other refusal", () => {
    expect(describeInviteError(problem(409, "Already invited")).message).toBe(
      `Already invited. ${NOT_INVITED}`,
    );
  });

  it("falls back to a plain sentence for anything that is not an API error", () => {
    expect(describeInviteError(new Error("boom")).message).toBe(
      `boom. ${NOT_INVITED}`,
    );
    expect(describeInviteError("nope").message).toBe(
      `The invitation could not be sent. ${NOT_INVITED}`,
    );
  });
});
