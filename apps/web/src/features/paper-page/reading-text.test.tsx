// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";
import { ANNOTATION_CREATED_EVENT } from "../paper-discussion/annotations";
import { loadKatex, type LoadMath } from "./math-typeset";
import { stubApi } from "./paper-page-fixtures";
import { ReadingText } from "./reading-text";

// Posting an annotation signs it with the device key, which needs a real
// authenticator. The composer's behaviour on the page, not the signing, is what
// these tests check, so signing returns a signed record directly.
vi.mock("../web-auth/sign-record", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../web-auth/sign-record")>();
  return {
    ...actual,
    signRecord: async (type: string, body: Record<string, unknown>) => ({
      v: 1,
      type,
      id: "bafyrei-signed-annotation",
      author: "did:key:z6Mk-signature-for-the-test",
      created: "2026-01-01T00:00:00.000Z",
      prev: null,
      body,
      proofs: [],
      sig: "signature",
    }),
  };
});

/**
 * The paragraphs of the reading column, with their math typeset once the page
 * runs. The annotation component (feature 150) renders the paragraphs; these
 * tests check that typesetting works on what it renders and does not get in the
 * way of what it does.
 */

const PARAGRAPHS = [
  { id: "p1", text: "Multi-agent systems increasingly choose between plans." },
  { id: "p2", text: "The score is $s = \\sum_i w_i x_i$ for each branch." },
  { id: "p3", text: "A fee of $5 to $10 applies." },
  { id: "p4", text: "Normalising gives $$\\frac{a}{b}$$ in the limit." },
];

function renderText(
  loadMath: LoadMath = loadKatex,
  paragraphs = PARAGRAPHS,
  facts: { title?: string; abstract?: string } = {},
) {
  return render(
    <ReadingText
      paperId="sch:6sel-2dio-orm6"
      version={2}
      versionCid="bafyrei-version-2"
      paragraphs={paragraphs}
      loadMath={loadMath}
      title={facts.title}
      abstract={facts.abstract}
    />,
  );
}

function paragraphElement(id: string): HTMLElement {
  const element = document.getElementById(`p-${id}`);
  if (element === null) {
    throw new Error(`no paragraph ${id}`);
  }
  return element;
}

/* --------------------------- annotations -------------------------------- */

const ANNOTATED_PARAGRAPHS = [
  { id: "p1", text: "Only the marker belongs in the narrow margin column." },
  { id: "p2", text: "Every note on this paragraph was hidden by a moderator." },
  { id: "p3", text: "Nothing has been said about this paragraph." },
];

const QUOTE = "the marker alone, not the annotations";
const NOTE =
  "The quote and this note take the full width of the reading column, instead of wrapping one word per line in the 48px gutter.";

const NOTE_GROUPS: Record<string, unknown[]> = {
  p1: [{ id: "a1", paragraph_id: "p1", quote: QUOTE, text: NOTE }],
  p2: [{ id: "h1", paragraph_id: "p2", hidden: true, hidden_reason: "Harassment" }],
};

const POSTED_NOTE = "A note the author has just posted.";
const POSTED_GROUPS: Record<string, unknown[]> = {
  ...NOTE_GROUPS,
  p1: [
    ...NOTE_GROUPS.p1,
    { id: "a2", paragraph_id: "p1", quote: QUOTE, text: POSTED_NOTE },
  ],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answer the annotations read the way the node does. A POST records the new
 * annotation, so the reload that follows it returns the list with the note in
 * it, as the real endpoint would.
 */
function stubAnnotationApi(options: { refuseSave?: boolean } = {}) {
  const state = { posted: false };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (/\/annotations$/.test(path)) {
      if (init?.method === "POST") {
        if (options.refuseSave === true) {
          return new Response(
            JSON.stringify({
              type: "about:blank",
              title: "Problem",
              status: 500,
              detail: "The annotation could not be saved.",
            }),
            { status: 500, headers: { "content-type": "application/problem+json" } },
          );
        }
        state.posted = true;
        return jsonResponse({ id: "bafyrei-posted-annotation" });
      }
      return jsonResponse({ annotations: state.posted ? POSTED_GROUPS : NOTE_GROUPS });
    }
    return new Response("{}", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // The annotation component reads its markers on mount; this node has none.
  stubApi({});
  // The token store is shared by every test: start each one signed out.
  tokenStore.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  tokenStore.clear();
});

describe("ReadingText: paragraphs", () => {
  it("shows every paragraph as text before anything is typeset", () => {
    // `loadMath` never settles: this is the first paint, and what a reader with
    // no JavaScript would get.
    renderText(() => new Promise(() => {}));

    expect(paragraphElement("p1").textContent).toBe(PARAGRAPHS[0].text);
    expect(paragraphElement("p2").textContent).toBe(PARAGRAPHS[1].text);
  });
});

describe("ReadingText: math", () => {
  it("typesets the paragraphs that have math", async () => {
    renderText();

    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });
    expect(paragraphElement("p4").querySelector(".katex-display")).not.toBeNull();
    // The words around a formula are still there, the delimiters are not.
    expect(paragraphElement("p2").textContent).toContain("The score is ");
    expect(paragraphElement("p2").textContent).toContain(" for each branch.");
    expect(paragraphElement("p2").querySelector(".katex-html")?.textContent).not.toContain("$");
  });

  it("leaves a paragraph with no math, and one with only a price, as it was", async () => {
    renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    expect(paragraphElement("p1").querySelector(".katex")).toBeNull();
    expect(paragraphElement("p1").textContent).toBe(PARAGRAPHS[0].text);
    expect(paragraphElement("p3").textContent).toBe(PARAGRAPHS[2].text);
  });

  it("exposes each formula as MathML for screen readers", async () => {
    renderText();

    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex-mathml math")).not.toBeNull();
    });
    // The visible glyphs are hidden from assistive technology so a formula is
    // read once, from the MathML.
    expect(paragraphElement("p2").querySelector(".katex-html")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("does not load the math renderer for a paper that has none", async () => {
    const loadMath = vi.fn(loadKatex);

    renderText(loadMath, [PARAGRAPHS[0], PARAGRAPHS[2]]);
    // Let any effect settle.
    await Promise.resolve();

    expect(loadMath).not.toHaveBeenCalled();
  });

  it("keeps the LaTeX on the page when the renderer cannot be fetched", async () => {
    const loadMath = vi.fn(async () => {
      throw new Error("chunk failed to load");
    });

    renderText(loadMath);
    await waitFor(() => expect(loadMath).toHaveBeenCalled());
    await Promise.resolve();

    expect(paragraphElement("p2").textContent).toBe(PARAGRAPHS[1].text);
    expect(paragraphElement("p2").querySelector(".katex")).toBeNull();
  });

  it("does not touch the page if it went away before the renderer arrived", async () => {
    let arrive: (renderer: Awaited<ReturnType<LoadMath>>) => void = () => {};
    const slow: LoadMath = () =>
      new Promise((resolve) => {
        arrive = resolve;
      });
    const view = renderText(slow);
    const element = paragraphElement("p2");

    view.unmount();
    arrive(await loadKatex());
    await Promise.resolve();

    expect(element.querySelector(".katex")).toBeNull();
  });

  it("typesets again when a paragraph's text changes", async () => {
    const view = renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    view.rerender(
      <ReadingText
        paperId="sch:6sel-2dio-orm6"
        version={3}
        versionCid="bafyrei-version-3"
        paragraphs={[
          PARAGRAPHS[0],
          { id: "p2", text: "The revised score is $r = \\prod_i w_i$ now." },
          PARAGRAPHS[2],
          PARAGRAPHS[3],
        ]}
        loadMath={loadKatex}
      />,
    );

    await waitFor(() => {
      expect(paragraphElement("p2").textContent).toContain("The revised score is ");
    });
    await waitFor(() => {
      expect(
        paragraphElement("p2").querySelector('annotation[encoding="application/x-tex"]')
          ?.textContent,
      ).toBe("r = \\prod_i w_i");
    });
  });
});

describe("ReadingText: the body", () => {
  const TITLE = "Can a Meta-Agent Choose the Safer Branch?";
  const ABSTRACT =
    "An evaluation framework investigating whether meta-agents can identify the safer of two candidate branches before either is executed.";
  // The demo manuscripts' front matter: title, byline, notice, "Abstract"
  // heading, abstract — the byline and notice sit between title and abstract.
  const REPEATED = [
    { id: "title", text: TITLE },
    { id: "byline", text: "Mei Zhang, A. Okafor  |  cs.AI cs.MA" },
    {
      id: "notice",
      text: "Demo manuscript. The authors, institutions and results in it are fictional.",
    },
    { id: "abstract-heading", text: "Abstract" },
    { id: "abstract", text: ABSTRACT },
    { id: "body-1", text: "Multi-agent systems increasingly choose between candidate plans." },
    { id: "body-2", text: "Section 2 states the evaluation protocol." },
  ];

  it("starts at the body: the title and abstract already shown above are not repeated", () => {
    renderText(loadKatex, REPEATED, { title: TITLE, abstract: ABSTRACT });

    for (const id of ["title", "byline", "notice", "abstract-heading", "abstract"]) {
      expect(document.getElementById(`p-${id}`)).toBeNull();
    }
    expect(paragraphElement("body-1").textContent).toBe(REPEATED[5].text);
    expect(paragraphElement("body-2").textContent).toBe(REPEATED[6].text);
  });

  it("drops only the leading repeats: an abstract quoted later in the paper stays", () => {
    const quoted = [
      ...REPEATED,
      { id: "later", text: ABSTRACT },
    ];
    renderText(loadKatex, quoted, { title: TITLE, abstract: ABSTRACT });

    expect(paragraphElement("later").textContent).toBe(ABSTRACT);
  });

  it("keeps every paragraph when the text does not repeat the title or abstract", () => {
    renderText(loadKatex, PARAGRAPHS, { title: TITLE, abstract: ABSTRACT });

    for (const paragraph of PARAGRAPHS) {
      expect(paragraphElement(paragraph.id).textContent).toBe(paragraph.text);
    }
  });

  it("reads the title and abstract from the page when the props are not given", async () => {
    // The listed page's reading column renders the heading and abstract above
    // this component and does not pass them; the column still starts at the
    // body once the page runs.
    render(
      <>
        <h1 id="ppg-title">{TITLE}</h1>
        <p className="ppg-abstract-body">{ABSTRACT}</p>
        <ReadingText
          paperId="sch:6sel-2dio-orm6"
          version={2}
          versionCid="bafyrei-version-2"
          paragraphs={REPEATED}
          loadMath={() => new Promise(() => {})}
        />
      </>,
    );

    await waitFor(() => expect(document.getElementById("p-title")).toBeNull());
    expect(paragraphElement("body-1").textContent).toBe(REPEATED[5].text);
  });
});

describe("ReadingText: annotations", () => {
  it("still selects a typeset paragraph and opens the composer on A", async () => {
    renderText();
    await waitFor(() => {
      expect(paragraphElement("p2").querySelector(".katex")).not.toBeNull();
    });

    const paragraph = paragraphElement("p2");
    fireEvent.focus(paragraph);
    expect(paragraph.getAttribute("data-selected")).toBe("true");

    fireEvent.keyDown(paragraph, { key: "a" });
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toBeTruthy();
    });
    // The paragraph is still typeset while it is being annotated.
    expect(paragraph.querySelector(".katex")).not.toBeNull();
  });
});

describe("ReadingText: the annotation margin column", () => {
  it("keeps the marker column to the marker and starts every list closed", async () => {
    stubAnnotationApi();
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    const marker = await screen.findByTestId("margin-marker-p1");
    const margin = marker.closest(".pd-margin");
    expect(margin).not.toBeNull();
    // The bug: the list was drawn inside the 48px column, beside the paragraph.
    expect(margin?.querySelector(".pd-annotation-list")).toBeNull();

    // Closed at first, and the marker is a disclosure button for the list.
    expect(marker.getAttribute("aria-expanded")).toBe("false");
    expect(marker.getAttribute("aria-controls")).toBe("pd-annotation-list-p1");
    expect(document.getElementById("pd-annotation-list-p1")).toBeNull();
    expect(margin?.textContent).toBe("");

    // A paragraph whose only annotations are hidden still has a marker, and
    // the label says the annotations are there but hidden rather than counting
    // them as visible.
    const hiddenMarker = await screen.findByTestId("margin-marker-p2");
    expect(hiddenMarker.getAttribute("aria-label")).toBe(
      "Annotations hidden by moderation on this paragraph",
    );
    // A paragraph with no annotations at all has no marker.
    expect(screen.queryByTestId("margin-marker-p3")).toBeNull();
  });

  it("opens the list across the reading column and closes it again", async () => {
    stubAnnotationApi();
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    const marker = await screen.findByTestId("margin-marker-p1");
    fireEvent.click(marker);

    const list = await screen.findByRole("list", { name: "Annotations for p1" });
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    // Opening the list also selects the paragraph, as clicking the marker
    // always has.
    expect(paragraphElement("p1").getAttribute("data-selected")).toBe("true");
    // It is a sibling of the paragraph and the margin, not inside the column.
    expect(list.closest(".pd-margin")).toBeNull();
    expect(list.closest(".pd-paragraph-row")).not.toBeNull();
    expect(screen.getByText(QUOTE)).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();

    fireEvent.click(marker);
    expect(screen.queryByRole("list", { name: "Annotations for p1" })).toBeNull();
    expect(marker.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the moderation placeholders when a hidden-only paragraph is opened", async () => {
    stubAnnotationApi();
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    const marker = await screen.findByTestId("margin-marker-p2");
    fireEvent.click(marker);

    expect(await screen.findByText("Hidden by moderation: Harassment")).toBeTruthy();
    expect(marker.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("pd-annotation-list-p2")).not.toBeNull();
  });

  it("opens the paragraph's list after the author posts a new annotation", async () => {
    stubAnnotationApi();
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    const paragraph = paragraphElement("p1");
    const marker = await screen.findByTestId("margin-marker-p1");
    expect(marker.getAttribute("aria-expanded")).toBe("false");

    fireEvent.focus(paragraph);
    fireEvent.keyDown(paragraph, { key: "a" });
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: POSTED_NOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    // A new annotation the reader cannot see would be a silent failure, so the
    // paragraph it belongs to opens.
    await waitFor(() => expect(marker.getAttribute("aria-expanded")).toBe("true"));
    expect(await screen.findByText(POSTED_NOTE)).toBeTruthy();
  });
});

describe("ReadingText: an author's own hidden annotation", () => {
  const OWN_TEXT = "My own note, withheld from everyone else.";
  const OWN_NOTE =
    "An annotation the reader wrote and a moderator hid. The reading column must tell the author it is theirs.";

  /**
   * Answer the annotations read with the given paragraph groups, the way the
   * node answers the author's own read: the hidden annotation carries
   * `is_own` and the author's `own_text`; another reader's carries neither.
   */
  function stubAnnotationRead(groups: Record<string, unknown[]>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (/\/annotations$/.test(path) && init?.method !== "POST") {
          return jsonResponse({ annotations: groups });
        }
        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  const OWN_HIDDEN = [
    {
      id: "own-hidden",
      paragraph_id: "p2",
      hidden: true,
      hidden_reason: "Off topic",
      is_own: true,
      isOwn: true,
      own_text: OWN_TEXT,
      ownText: OWN_TEXT,
      quote: "Every note on this paragraph was hidden by a moderator.",
    },
  ];
  /** The same annotation as every other reader's read returns it. */
  const ANONYMOUS_HIDDEN = [
    {
      id: "own-hidden",
      paragraph_id: "p2",
      hidden: true,
      hidden_reason: "Off topic",
    },
  ];

  const ANONYMOUS_PLACEHOLDER = "Hidden by moderation: Off topic";
  const OWN_NOTICE = /Your annotation was hidden: Off topic\./;

  /** A JWT-shaped access token whose payload carries the API's `sub` claim. */
  function accessJwt(sub: string): string {
    const segment = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${segment({ alg: "none" })}.${segment({ sub, tier: 1 })}.signature`;
  }

  const SAM = "did:key:z6MkSamTheAuthor";

  /**
   * Answer the annotations read the way the node does for the session that
   * made it: a read with a bearer token is the author's and carries `is_own`
   * and `own_text`; a read without one is any other reader's. Every read's
   * authorization header is recorded so a test can see what was sent.
   */
  function stubAuthAwareAnnotationRead() {
    const reads: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (/\/annotations$/.test(path) && init?.method !== "POST") {
          const authorization = new Headers(init?.headers).get("authorization");
          reads.push(authorization);
          return jsonResponse({
            annotations: authorization === null ? { p2: ANONYMOUS_HIDDEN } : { p2: OWN_HIDDEN },
          });
        }
        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return { reads };
  }

  /** The reading column as `renderText` renders it, for a rerender. */
  function readingText() {
    return (
      <ReadingText
        paperId="sch:6sel-2dio-orm6"
        version={2}
        versionCid="bafyrei-version-2"
        paragraphs={ANNOTATED_PARAGRAPHS}
        loadMath={loadKatex}
      />
    );
  }

  it("tells the author it is theirs, reveals their text on request and links to the appeal", async () => {
    stubAnnotationRead({ p2: OWN_HIDDEN });
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    fireEvent.click(await screen.findByTestId("margin-marker-p2"));
    const list = await screen.findByRole("list", { name: "Annotations for p2" });

    // The author's notice, not the anonymous placeholder.
    expect(within(list).getByText(/Your annotation was hidden: Off topic\./)).toBeTruthy();
    expect(within(list).queryByText(/Hidden by moderation/)).toBeNull();
    // Their words stay out of the page until they ask for them.
    expect(within(list).queryByText(OWN_TEXT)).toBeNull();
    const show = within(list).getByRole("button", { name: "Show my annotation" });
    expect(show.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(show);
    expect(await within(list).findByText(OWN_TEXT)).toBeTruthy();
    // The revealed annotation keeps the passage it was written on.
    expect(
      within(list).getByText("Every note on this paragraph was hidden by a moderator."),
    ).toBeTruthy();
    expect(
      within(list).getByRole("button", { name: "Hide my annotation" }).getAttribute("aria-expanded"),
    ).toBe("true");

    // Appeal is filed on the paper's discussion page, at the post.
    const appeal = within(list).getByRole("link", { name: "Appeal" });
    expect(appeal.getAttribute("href")).toBe(
      "/discussion/6sel-2dio-orm6/v2#post-own-hidden",
    );

    fireEvent.click(within(list).getByRole("button", { name: "Hide my annotation" }));
    expect(within(list).queryByText(OWN_TEXT)).toBeNull();
    expect(within(list).getByRole("button", { name: "Show my annotation" })).toBeTruthy();
  });

  it("shows another reader the anonymous placeholder and none of the author's text", async () => {
    stubAnnotationRead({
      p3: [
        {
          id: "theirs-hidden",
          paragraph_id: "p3",
          hidden: true,
          hidden_reason: "Harassment",
          // The node serves no `own_text` or `is_own` to another reader; a
          // quote on the placeholder must not surface through either.
          quote: OWN_NOTE,
        },
      ],
    });
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    fireEvent.click(await screen.findByTestId("margin-marker-p3"));
    const list = await screen.findByRole("list", { name: "Annotations for p3" });

    expect(within(list).getByText("Hidden by moderation: Harassment")).toBeTruthy();
    expect(within(list).queryByText(/was hidden/)).toBeNull();
    expect(within(list).queryByText(OWN_NOTE)).toBeNull();
    expect(within(list).queryByRole("button", { name: /my annotation/ })).toBeNull();
    expect(within(list).queryByRole("link", { name: "Appeal" })).toBeNull();
  });

  it("re-reads once the session is restored after a normal page load", async () => {
    // A reload: the component mounts before /v1/auth/refresh has put the
    // session's token back, so the first read goes out without one and the
    // node answers as it would to any reader.
    const { reads } = stubAuthAwareAnnotationRead();
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    const marker = await screen.findByTestId("margin-marker-p2");
    fireEvent.click(marker);
    expect(await screen.findByText(ANONYMOUS_PLACEHOLDER)).toBeTruthy();
    expect(reads).toEqual([null]);

    // The session is restored: the viewer becomes sam, the annotation's
    // author. The margin reads again with the token the store now holds.
    act(() => tokenStore.set({ accessToken: accessJwt(SAM) }));

    await waitFor(() => expect(reads.length).toBe(2));
    expect(reads[1]).toMatch(/^Bearer /);

    // The author's notice replaces the anonymous placeholder, and the
    // paragraph the reader had opened stays open.
    expect(await screen.findByText(OWN_NOTICE)).toBeTruthy();
    expect(screen.queryByText(ANONYMOUS_PLACEHOLDER)).toBeNull();
    expect(marker.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Show my annotation" }));
    expect(await screen.findByText(OWN_TEXT)).toBeTruthy();
  });

  it("does not read again when the same viewer renders the column again", async () => {
    const { reads } = stubAuthAwareAnnotationRead();
    // Signed in before the page runs, as when it is reached from sign-in.
    tokenStore.set({ accessToken: accessJwt(SAM) });
    const view = renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    // The reads the mount needs have answered: the viewer resolved, and the
    // margin shows the author's notice.
    fireEvent.click(await screen.findByTestId("margin-marker-p2"));
    expect(await screen.findByText(OWN_NOTICE)).toBeTruthy();
    const answered = reads.length;

    // A rerender with the same viewer is not a reason to ask the node again.
    view.rerender(readingText());
    await act(async () => {});
    expect(reads.length).toBe(answered);
  });

  it("keeps the newer viewer's answer when an earlier read answers late", async () => {
    // The first, tokenless read hangs; the read for the restored session
    // answers at once. When the first finally answers, it is stale and must
    // not put the anonymous placeholder back over the author's notice.
    let releaseFirstRead: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (/\/annotations$/.test(path) && init?.method !== "POST") {
          const authorization = new Headers(init?.headers).get("authorization");
          if (authorization === null) {
            await new Promise<void>((resolve) => {
              releaseFirstRead = resolve;
            });
            return jsonResponse({ annotations: { p2: ANONYMOUS_HIDDEN } });
          }
          return jsonResponse({ annotations: { p2: OWN_HIDDEN } });
        }
        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    renderText(loadKatex, ANNOTATED_PARAGRAPHS);
    // The tokenless read is in flight, holding back the whole answer.
    await waitFor(() => expect(releaseFirstRead).not.toBeNull());

    act(() => tokenStore.set({ accessToken: accessJwt(SAM) }));
    fireEvent.click(await screen.findByTestId("margin-marker-p2"));
    expect(await screen.findByText(OWN_NOTICE)).toBeTruthy();

    await act(async () => releaseFirstRead?.());

    expect(screen.queryByText(ANONYMOUS_PLACEHOLDER)).toBeNull();
    expect(screen.getByText(OWN_NOTICE)).toBeTruthy();
  });

  it("goes back to the anonymous placeholder when the viewer signs out", async () => {
    const { reads } = stubAuthAwareAnnotationRead();
    tokenStore.set({ accessToken: accessJwt(SAM) });
    renderText(loadKatex, ANNOTATED_PARAGRAPHS);

    fireEvent.click(await screen.findByTestId("margin-marker-p2"));
    expect(await screen.findByText(OWN_NOTICE)).toBeTruthy();

    // Signing out is another viewer: the margin reads again, with no token,
    // and the answer replaces the author's notice.
    act(() => tokenStore.clear());

    expect(await screen.findByText(ANONYMOUS_PLACEHOLDER)).toBeTruthy();
    expect(screen.queryByText(OWN_NOTICE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show my annotation" })).toBeNull();
    expect(reads[reads.length - 1]).toBeNull();
  });
});

describe("ReadingText: announcing a saved annotation", () => {
  /** Hear what the reading column says on `window`; returns the stop function. */
  function hear(listener: (event: Event) => void): () => void {
    window.addEventListener(ANNOTATION_CREATED_EVENT, listener);
    return () => window.removeEventListener(ANNOTATION_CREATED_EVENT, listener);
  }

  async function saveNote(): Promise<void> {
    const paragraph = paragraphElement("p1");
    fireEvent.focus(paragraph);
    fireEvent.keyDown(paragraph, { key: "a" });
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: POSTED_NOTE } });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
  }

  it("says so once, naming the paper, after the annotation is saved", async () => {
    stubAnnotationApi();
    const heard = vi.fn();
    const stop = hear(heard);
    try {
      renderText(loadKatex, ANNOTATED_PARAGRAPHS);
      await saveNote();

      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      const detail = (heard.mock.calls[0][0] as CustomEvent).detail;
      expect(detail).toMatchObject({
        paperId: "sch:6sel-2dio-orm6",
        versionCid: "bafyrei-version-2",
      });
      expect(detail.annotation).toMatchObject({ paragraphId: "p1", text: POSTED_NOTE });

      // The save itself still works: the paragraph's list opens with the note.
      expect(await screen.findByText(POSTED_NOTE)).toBeTruthy();
    } finally {
      stop();
    }
  });

  it("says nothing when the save fails", async () => {
    stubAnnotationApi({ refuseSave: true });
    const heard = vi.fn();
    const stop = hear(heard);
    try {
      renderText(loadKatex, ANNOTATED_PARAGRAPHS);
      await saveNote();

      // The composer says why, and no one is told a save happened.
      expect((await screen.findByRole("alert")).textContent).toMatch(/could not be saved/);
      expect(heard).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
