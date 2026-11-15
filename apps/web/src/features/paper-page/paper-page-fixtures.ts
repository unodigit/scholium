/**
 * One realistic paper, as the node's public reads would answer for it, for the
 * paper page's tests.
 *
 * The paper is "v2 of 2" with two authors, a PDF and a code bundle, three
 * reviews and eight discussion posts, so every part of the page has something
 * to show. `stubApi` answers `fetch` by URL the way the node does, so a route
 * can be rendered end to end without a network.
 *
 * The id is a real checksummed short id from the shared vectors, so the Proof
 * tab accepts it.
 */

import { vi } from "vitest";

export const SHORT_ID = "sch:6sel-2dio-orm6";
export const BARE_ID = "6sel-2dio-orm6";
export const VERSION_CID = "bafyrei-version-2";
export const PAPER_CID = "bafyrei-genesis";

export const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
export const BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/** `GET /v1/papers/{id}[/v{n}]` */
export const PAPER_BODY = {
  paper: SHORT_ID,
  shortId: SHORT_ID,
  paperCid: PAPER_CID,
  versionCid: VERSION_CID,
  cid: VERSION_CID,
  n: 2,
  version: 2,
  title: "Can a Meta-Agent Choose the Safer Branch?",
  abstract:
    "An evaluation framework investigating whether meta-agents can identify the safer of two candidate branches before either is executed.",
  authors: [
    { did: ALICE, author: ALICE, position: 1, creditRoles: ["conceptualization"] },
    { did: BOB, author: BOB, position: 2, creditRoles: null },
  ],
  categories: ["cs.AI", "cs.MA"],
  licence: "CC-BY-4.0",
  status: "reviewed",
  notices: [],
};

/** `GET /v1/profiles/{did}` */
export const PROFILES: Record<string, unknown> = {
  [ALICE]: { did: ALICE, name: "Mei Zhang", affiliation: "Example University" },
  [BOB]: { did: BOB, name: "A. Okafor", affiliation: null },
};

/** `GET /v1/papers/{id}/versions` */
export const VERSIONS_BODY = {
  paper: SHORT_ID,
  shortId: SHORT_ID,
  paperCid: PAPER_CID,
  versions: [
    {
      n: 1,
      cid: "bafyrei-version-1",
      change_note: null,
      listed_at: "2027-02-01T09:00:00Z",
      anchor: "pending",
    },
    {
      n: 2,
      cid: VERSION_CID,
      change_note: "Names the adversarial baseline in section 3.2.",
      listed_at: "2027-03-02T04:00:00Z",
      anchor: { status: "anchored", anchored_at: "2027-03-02T04:00:00Z" },
    },
  ],
};

/** `GET /v1/papers/{id}/v/{n}/manifest` */
export const MANIFEST_BODY = {
  shortId: SHORT_ID,
  versionCid: VERSION_CID,
  n: 2,
  manifestCid: "bafyrei-manifest",
  licence: "CC-BY-4.0",
  files: [
    {
      path: "paper.pdf",
      cid: "bafkrei-pdf",
      size: 482113,
      mediaType: "application/pdf",
      role: "manuscript",
      scanStatus: "passed",
    },
    {
      path: "code/run.py",
      cid: "bafkrei-code",
      size: 1204,
      mediaType: "text/x-python",
      role: "code",
      scanStatus: "passed",
    },
  ],
};

/** `GET /v1/papers/{id}/reviews` */
export const REVIEWS_BODY = {
  paper: SHORT_ID,
  shortId: SHORT_ID,
  versionCid: VERSION_CID,
  version: 2,
  gate_open: true,
  count: 3,
  reviews: [
    {
      review_cid: "bafyrei-a",
      label: "Reviewer A",
      recommendation: "minor_revisions",
      committed_at: "2027-03-02T04:00:00",
      scores: { soundness: { score: 4, justification: "Sound." } },
      report: "Careful work.",
    },
    {
      review_cid: "bafyrei-b",
      label: "Reviewer B",
      recommendation: "sound_as_is",
      committed_at: "2027-03-03T04:00:00",
      scores: { soundness: { score: 5, justification: "Very sound." } },
    },
    {
      review_cid: "bafyrei-c",
      label: "Reviewer C",
      recommendation: "minor_revisions",
      committed_at: "2027-03-04T04:00:00",
      scores: { soundness: { score: 4, justification: "Sound." } },
    },
  ],
};

function post(cid: string, text: string, replies: unknown[] = []): unknown {
  return {
    post_cid: cid,
    author: ALICE,
    text,
    created: "2027-03-05T10:00:00Z",
    helpful: 0,
    replies,
  };
}

/** `GET /v1/papers/{id}/threads`: eight posts in all, replies included. */
export const THREADS_BODY = {
  paper: SHORT_ID,
  paper_cid: PAPER_CID,
  threads: [
    post("bafyrei-t1", "Is the baseline in Table 2 tuned?", [
      post("bafyrei-t1r1", "Yes, see section 3.2.", [post("bafyrei-t1r1r1", "Thanks.")]),
      post("bafyrei-t1r2", "Which seed?"),
    ]),
    post("bafyrei-t2", "The proof of Lemma 2 skips n = 0.", [
      post("bafyrei-t2r1", "Fixed in v2."),
    ]),
    post("bafyrei-t3", "Nice figure.", [post("bafyrei-t3r1", "Agreed.")]),
  ],
};

/** `GET /v1/papers/{id}/v/{n}/text` */
export const TEXT_BODY = {
  paper: SHORT_ID,
  version: 2,
  versionCid: VERSION_CID,
  count: 3,
  paragraphs: [
    { paragraph_id: "para-1", paragraphId: "para-1", position: 0, text: "Multi-agent systems increasingly choose between candidate plans." },
    { paragraph_id: "para-2", paragraphId: "para-2", position: 1, text: "We ask whether a meta-agent can tell the safer branch." },
    { paragraph_id: "para-3", paragraphId: "para-3", position: 2, text: "Section 2 states the evaluation protocol." },
  ],
};

/**
 * `GET /v1/papers/{id}/compare?from=1&to=2`, in the node's shape: one changed
 * pair, one added paragraph and one removed paragraph, plus both change notes.
 */
export const COMPARE_BODY = {
  paper: SHORT_ID,
  shortId: SHORT_ID,
  from: 1,
  to: 2,
  fromChangeNote: null,
  toChangeNote: "Names the adversarial baseline in section 3.2.",
  addedCount: 1,
  removedCount: 1,
  changedCount: 1,
  counts: { added: 1, removed: 1, changed: 1 },
  addedParagraphs: [
    {
      paragraph_id: "para-4",
      paragraphId: "para-4",
      position: 3,
      text: "Section 3.2 now names the adversarial baseline and its seed.",
    },
  ],
  removedParagraphs: [
    {
      paragraph_id: "para-old",
      paragraphId: "para-old",
      position: 2,
      text: "The baseline was tuned on the test split.",
    },
  ],
  changedParagraphs: [
    {
      from: {
        paragraph_id: "para-1",
        paragraphId: "para-1",
        position: 0,
        text: "Multi-agent systems choose between candidate plans.",
      },
      to: {
        paragraph_id: "para-1b",
        paragraphId: "para-1b",
        position: 0,
        text: "Multi-agent systems increasingly choose between candidate plans.",
      },
    },
  ],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": status === 200 ? "application/json" : "application/problem+json",
    },
  });
}

/** A `404` problem response, the way the node answers for what it does not hold. */
export function notFound(): Response {
  return json({ title: "Not Found", status: 404, detail: "No listed paper." }, 404);
}

/** One answer per read, by name; an omitted read answers `404`. */
export type Routes = Partial<{
  paper: (path: string) => Response;
  profile: (did: string) => Response;
  versions: () => Response;
  manifest: () => Response;
  reviews: () => Response;
  threads: () => Response;
  text: () => Response;
  compare: (from: number, to: number) => Response;
}>;

/** What the node answers when every read works. */
export const HAPPY: Routes = {
  paper: () => json(PAPER_BODY),
  profile: (did) => json(PROFILES[did] ?? { did, name: null }),
  versions: () => json(VERSIONS_BODY),
  manifest: () => json(MANIFEST_BODY),
  reviews: () => json(REVIEWS_BODY),
  threads: () => json(THREADS_BODY),
  text: () => json(TEXT_BODY),
  compare: () => json(COMPARE_BODY),
};

export { json };

/**
 * Answer `fetch` the way the node does, by URL. Returns the mock so a test can
 * read which URLs were asked for.
 */
export function stubApi(routes: Routes = HAPPY): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const profile = /^\/v1\/profiles\/(.+)$/.exec(path);
    if (profile !== null) {
      return routes.profile !== undefined ? routes.profile(profile[1]) : notFound();
    }
    if (/\/versions$/.test(path)) return (routes.versions ?? notFound)();
    if (/\/compare$/.test(path)) {
      return (routes.compare ?? notFound)(
        Number(url.searchParams.get("from")),
        Number(url.searchParams.get("to")),
      );
    }
    if (/\/manifest$/.test(path)) return (routes.manifest ?? notFound)();
    if (/\/reviews$/.test(path)) return (routes.reviews ?? notFound)();
    if (/\/threads$/.test(path)) return (routes.threads ?? notFound)();
    if (/\/text$/.test(path)) return (routes.text ?? notFound)();
    if (/^\/v1\/papers\/[^/]+(\/v\d+)?$/.test(path)) {
      return (routes.paper ?? notFound)(path);
    }
    return notFound();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
