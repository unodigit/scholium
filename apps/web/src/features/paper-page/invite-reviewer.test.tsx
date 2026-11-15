// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import type { Viewer } from "../review-form/viewer";
import {
  INVITEE_PROBLEMS,
  NOT_INVITED,
  type Invitation,
  type InviteRequest,
  type SendInvitation,
} from "./invitation";
import { InviteReviewer } from "./invite-reviewer";

/**
 * The Invite reviewer action (feature 187): offered to authors only, a
 * disclosure that opens a one-field form, and the request it sends. The viewer
 * and the send are injected, so the whole flow runs without a token or a node.
 */

const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const OKAFOR = "did:key:z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr";
const PAPER = "sch:6sel-2dio-orm6";

const author: Viewer = { signedIn: true, did: ALICE, tier: 2 };
const outsider: Viewer = { signedIn: true, did: OKAFOR, tier: 3 };
const signedOut: Viewer = { signedIn: false, did: null, tier: null };

/** A send that accepts, answering the way the node does. */
function accepting(): ReturnType<typeof vi.fn<SendInvitation>> {
  return vi.fn<SendInvitation>(async (request: InviteRequest) => ({
    id: "inv-1",
    reviewer: request.reviewer,
    status: "pending",
  }));
}

interface Overrides {
  viewer?: Viewer;
  send?: SendInvitation;
  categories?: readonly string[];
}

function show({ viewer = author, send = accepting(), categories = ["cs.AI", "cs.MA"] }: Overrides = {}) {
  return render(
    <InviteReviewer
      paperId={PAPER}
      version={2}
      categories={categories}
      authorDids={[ALICE, BOB]}
      viewer={viewer}
      send={send}
    />,
  );
}

const toggle = () => screen.getByRole("button", { name: "Invite reviewer" });
const field = () => screen.getByLabelText("Reviewer’s DID") as HTMLInputElement;
const sendButton = () => screen.getByRole("button", { name: /Send invitation|Sending/ });

function open(): void {
  fireEvent.click(toggle());
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(sendButton());
  });
}

afterEach(() => {
  cleanup();
});

describe("who is offered the action", () => {
  it("shows an author a button named Invite reviewer", () => {
    show();
    expect(toggle()).toBeTruthy();
  });

  it("shows nothing to a signed-in reader who is not on the byline", () => {
    show({ viewer: outsider });
    expect(screen.queryByRole("button", { name: "Invite reviewer" })).toBeNull();
    expect(screen.queryByLabelText("Reviewer’s DID")).toBeNull();
  });

  it("shows nothing to a signed-out reader", () => {
    show({ viewer: signedOut });
    expect(screen.queryByRole("button", { name: "Invite reviewer" })).toBeNull();
  });

  it("is absent from the server's HTML, so a shared link reads as it always did", () => {
    // No override: the first render is the signed-out one, whoever is looking.
    const html = renderToStaticMarkup(
      <InviteReviewer
        paperId={PAPER}
        version={2}
        categories={["cs.AI"]}
        authorDids={[ALICE]}
      />,
    );
    expect(html).toBe("");
  });
});

describe("the disclosure", () => {
  it("starts closed: the button says so and the form is not in the page", () => {
    show();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const panelId = toggle().getAttribute("aria-controls") as string;
    const panel = document.getElementById(panelId) as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(screen.queryByRole("region", { name: /Invite a reviewer/ })).toBeNull();
  });

  it("opens on a click, names the version, and puts the cursor in the field", () => {
    show();
    open();

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Invite a reviewer to v2" });
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("cs.AI, cs.MA");
    expect(document.activeElement).toBe(field());
  });

  it("closes again from the button or from Close, and keeps a half-typed DID", () => {
    show();
    open();
    type("did:key:z6MkHalf");

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    open();
    expect(field().value).toBe("did:key:z6MkHalf");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("labels the field and says where to find a DID", () => {
    show();
    open();
    expect(field().getAttribute("aria-describedby")).toBeTruthy();
    const hint = document.getElementById(field().getAttribute("aria-describedby") as string);
    expect(hint?.textContent).toMatch(/profile’s address/);
    expect(field().getAttribute("autocomplete")).toBe("off");
    // The attribute, not the property: jsdom does not implement `spellcheck`.
    expect(field().getAttribute("spellcheck")).toBe("false");
  });

  it("does not claim a category the paper does not have", () => {
    show({ categories: [] });
    open();
    const panel = screen.getByRole("region", { name: "Invite a reviewer to v2" });
    expect(panel.textContent).toContain("Ask a verified reviewer to review this version");
  });
});

describe("sending", () => {
  it("sends the paper, the version on screen and the checked DID", async () => {
    const send = accepting();
    show({ send });
    open();
    type(`  ${OKAFOR}  `);
    await submit();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ paperId: PAPER, version: 2, reviewer: OKAFOR });
  });

  it("sends on Enter, as a form does", async () => {
    const send = accepting();
    show({ send });
    open();
    type(OKAFOR);
    await act(async () => {
      fireEvent.submit(field().closest("form") as HTMLFormElement);
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says who was invited, in a live region, with a tick and words", async () => {
    show();
    open();
    type(OKAFOR);
    await submit();

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Invitation sent to did:key:z6Mk");
    expect(status.textContent).toContain("It is on their dashboard.");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("clears the field for the next reviewer and lists who has been invited", async () => {
    show();
    open();
    type(OKAFOR);
    await submit();
    expect(field().value).toBe("");

    type("did:key:z6MkSecondReviewerXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    await submit();

    const list = screen.getByRole("list");
    const items = Array.from(list.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("pending");
    expect(items[0].querySelector("[title]")?.getAttribute("title")).toBe(OKAFOR);
    expect(screen.getByRole("heading", { name: "Invited from this page" })).toBeTruthy();
  });

  it("shows the invitation's own status, as the node saved it", async () => {
    const send: SendInvitation = async (request) => ({
      id: null,
      reviewer: request.reviewer,
      status: "accepted",
    });
    show({ send });
    open();
    type(OKAFOR);
    await submit();
    expect(screen.getByRole("list").textContent).toContain("accepted");
  });

  it("shows Sending… while it is in flight and sends once however often it is pressed", async () => {
    let finish: (invitation: Invitation) => void = () => undefined;
    const send = vi.fn<SendInvitation>(
      () =>
        new Promise<Invitation>((resolve) => {
          finish = resolve;
        }),
    );
    show({ send });
    open();
    type(OKAFOR);

    await submit();
    expect(sendButton().textContent).toBe("Sending…");
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");

    await submit();
    await submit();
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ id: "inv-1", reviewer: OKAFOR, status: "pending" });
    });
    await waitFor(() => expect(sendButton().textContent).toBe("Send invitation"));
    expect(sendButton().getAttribute("aria-disabled")).toBe("false");
  });
});

describe("mistakes caught before anything is sent", () => {
  it("asks for a DID when the field is empty, and puts the cursor back in it", async () => {
    const send = accepting();
    show({ send });
    open();
    // Focus somewhere else so the return of focus is the form's doing.
    sendButton().focus();
    await submit();

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(INVITEE_PROBLEMS.empty);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
  });

  it("says when the text is not a DID, and leaves it for the author to fix", async () => {
    const send = accepting();
    show({ send });
    open();
    type("Dr. Okafor");
    await submit();

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("That is not a DID");
    expect(field().value).toBe("Dr. Okafor");
  });

  it("refuses one of the paper's own authors", async () => {
    const send = accepting();
    show({ send });
    open();
    type(BOB);
    await submit();

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(INVITEE_PROBLEMS["is-author"]);
  });

  it("takes the message away as soon as the author starts correcting it", async () => {
    show();
    open();
    await submit();
    expect(screen.getByRole("alert")).toBeTruthy();

    type("did:");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });
});

describe("when the node says no", () => {
  const refusing = (error: unknown): SendInvitation => vi.fn(async () => {
    throw error;
  });

  it("shows a 403 in the node's own words, with an icon, and keeps the DID", async () => {
    const said = "The invitee must be a tier-3 reviewer in the paper category.";
    show({
      send: refusing(new ApiError(403, { status: 403, title: "Forbidden", detail: said })),
    });
    open();
    type(OKAFOR);
    await submit();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(said);
    expect(alert.textContent).toContain(NOT_INVITED);
    expect(alert.querySelector("svg")).not.toBeNull();
    // The author can correct a DID rather than retype it.
    expect(field().value).toBe(OKAFOR);
    // Nothing to announce as sent, and nothing listed.
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("list")).toBeNull();
    // The form is usable again.
    expect(sendButton().textContent).toBe("Send invitation");
  });

  it("offers Sign in when the session has ended", async () => {
    show({ send: refusing(new ApiError(401, { status: 401, title: "Unauthorized" })) });
    open();
    type(OKAFOR);
    await submit();

    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/signin");
    expect(screen.getByRole("alert").textContent).toContain("Your session has ended");
  });

  it("says the node could not be reached", async () => {
    show({ send: refusing(new NetworkError("http://node.test")) });
    open();
    type(OKAFOR);
    await submit();
    expect(screen.getByRole("alert").textContent).toContain("could not reach the node");
  });

  it("clears an earlier failure when the next try is sent", async () => {
    const send = vi
      .fn<SendInvitation>()
      .mockRejectedValueOnce(new ApiError(503, { status: 503, title: "Unavailable" }))
      .mockResolvedValueOnce({ id: "inv-2", reviewer: OKAFOR, status: "pending" });
    show({ send });
    open();
    type(OKAFOR);
    await submit();
    expect(screen.getByRole("alert").textContent).toContain("not confirmed as sent");

    await submit();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Invitation sent");
  });
});
