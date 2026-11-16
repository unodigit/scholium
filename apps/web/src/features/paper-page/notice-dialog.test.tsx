// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError } from "../web-auth/errors";
import type { SignedRecord } from "../web-auth/sign-record";
import {
  NOTICE_EMPTY_REASON,
  NOTICE_LABELS,
  NoticeDialog,
  describeNoticeError,
  noticeBody,
  submitNotice,
  type NoticeAccepted,
  type NoticeKind,
  type SignNotice,
  type SubmitNotice,
} from "./notice-dialog";

/**
 * Issue notice (PUB-7): the three kinds, the reason readers see, the second
 * confirmation for a retraction or withdrawal, and the signed record the
 * dialog sends. Signing and sending are injected, so the flow runs without a
 * passkey or a node.
 */

const PAPER = "sch:6sel-2dio-orm6";
const PAPER_CID = "bafyrei-genesis";
const VERSION_CID = "bafyrei-version-2";

function record(kind: NoticeKind, body: Record<string, unknown>): SignedRecord {
  return {
    v: 1,
    type: kind,
    id: `bafyrei-${kind}-record`,
    author: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    created: "2027-03-05T10:00:00Z",
    prev: null,
    body,
    proofs: [],
    sig: "signature",
  };
}

function seams() {
  const sign = vi.fn<SignNotice>(async (kind, body) => record(kind, body));
  const submit = vi.fn<SubmitNotice>(
    async (): Promise<NoticeAccepted> => ({
      id: "bafyrei-notice-record",
      state: "accepted",
    }),
  );
  return { sign, submit };
}

function show(options: { sign?: SignNotice; submit?: SubmitNotice } = {}) {
  const { sign, submit } = seams();
  return render(
    <NoticeDialog
      paperId={PAPER}
      paperCid={PAPER_CID}
      versionCid={VERSION_CID}
      version={2}
      sign={options.sign ?? sign}
      submit={options.submit ?? submit}
    />,
  );
}

const trigger = () => screen.getByRole("button", { name: "Issue notice" });
const reasonField = () => screen.getByLabelText("Reason") as HTMLTextAreaElement;

function open(): void {
  fireEvent.click(trigger());
}

function type(text: string): void {
  fireEvent.change(reasonField(), { target: { value: text } });
}

async function submitForm(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sign and issue|Review and sign/ }));
  });
}

afterEach(() => {
  cleanup();
});

describe("the dialog", () => {
  it("opens a modal named by its title and closes back to its trigger", () => {
    show();
    open();

    const dialog = screen.getByRole("dialog", { name: "Issue a notice" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The three kinds, and the default chosen.
    expect(screen.getByLabelText(/Correction/)).toBeTruthy();
    expect(screen.getByLabelText(/Retraction/)).toBeTruthy();
    expect(screen.getByLabelText(/Withdrawal/)).toBeTruthy();
    expect((screen.getByLabelText(/Correction/) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("says what a blank reason needs, and signs nothing", async () => {
    const { sign, submit } = seams();
    show({ sign, submit });
    open();

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain(NOTICE_EMPTY_REASON);
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a correction", () => {
  it("signs and sends the reason for the version on screen", async () => {
    const { sign, submit } = seams();
    show({ sign, submit });
    open();
    type("  The y-axis of Figure 2 was mislabelled.  ");

    await submitForm();

    expect(sign).toHaveBeenCalledWith("correction", {
      target: VERSION_CID,
      paper: PAPER_CID,
      reason: "The y-axis of Figure 2 was mislabelled.",
    });
    expect(submit).toHaveBeenCalledWith("correction", expect.objectContaining({ type: "correction" }));
    await waitFor(() =>
      expect(screen.getByText(/Your correction is on record/)).toBeTruthy(),
    );
    expect(screen.getByText("bafyrei-notice-record")).toBeTruthy();
  });
});

describe("a retraction or a withdrawal", () => {
  for (const kind of ["retraction", "withdrawal"] as const) {
    it(`asks once more before signing a ${kind}`, async () => {
      const { sign, submit } = seams();
      show({ sign, submit });
      open();
      fireEvent.click(screen.getByLabelText(new RegExp(NOTICE_LABELS[kind])));
      type(`The ${kind} reason.`);

      await submitForm();

      // Nothing is signed until the second, explicit step.
      expect(sign).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: new RegExp(`Confirm the ${kind}`) }),
      ).toBeTruthy();
      expect(screen.getByText(new RegExp(`Readers will see`))).toBeTruthy();

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: `Yes, sign the ${kind}` }),
        );
      });

      expect(sign).toHaveBeenCalledWith(kind, {
        target: VERSION_CID,
        paper: PAPER_CID,
        reason: `The ${kind} reason.`,
      });
      expect(submit).toHaveBeenCalled();
      expect(screen.getByText(new RegExp(`Your ${kind} is on record`))).toBeTruthy();
    });
  }

  it("goes back to the form without signing when the author changes their mind", async () => {
    const { sign } = seams();
    show({ sign });
    open();
    fireEvent.click(screen.getByLabelText(/Retraction/));
    type("The retraction reason.");

    await submitForm();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(sign).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toBeTruthy();
  });
});

describe("failures", () => {
  it("says the passkey was cancelled and that nothing was sent", async () => {
    const sign: SignNotice = vi.fn(async () => {
      throw new PasskeyCancelledError();
    });
    show({ sign });
    open();
    type("The correction reason.");

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain("Signing was cancelled");
    expect(screen.getByRole("alert").textContent).toContain("no correction was issued.");
  });

  it("shows the node's own words when it refuses the notice", async () => {
    const sign: SignNotice = vi.fn(async (kind, body) => record(kind, body));
    const submit: SubmitNotice = vi.fn(async () => {
      throw new ApiError(403, {
        detail: "Only a consented author of this paper may issue a notice for it.",
      } as never);
    });
    show({ sign, submit });
    open();
    type("The correction reason.");

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain(
      "Only a consented author of this paper may issue a notice for it.",
    );
  });
});

describe("the record", () => {
  it("keeps the version as target, names the paper, and trims the reason", () => {
    expect(
      noticeBody({
        kind: "withdrawal",
        paperCid: PAPER_CID,
        versionCid: VERSION_CID,
        reason: "  The authors took it back.  ",
      }),
    ).toEqual({
      target: VERSION_CID,
      paper: PAPER_CID,
      reason: "The authors took it back.",
    });
  });

  it("describes a network failure without claiming the notice exists", () => {
    const failure = describeNoticeError(
      new NetworkError("https://node.example"),
      "retraction",
    );
    expect(failure.message).toContain("No retraction was issued.");
    expect(failure.signIn).toBe(false);
  });

  it("offers a sign-in when the session has ended", () => {
    const failure = describeNoticeError(
      new ApiError(401, { detail: "Unauthorized" } as never),
      "correction",
    );
    expect(failure.signIn).toBe(true);
  });

  it("posts the signed notice to POST /v1/records", async () => {
    const signed = record("correction", {
      target: VERSION_CID,
      paper: PAPER_CID,
      reason: "A mislabelled axis.",
    });
    const post = vi.fn(async () => ({ id: signed.id, state: "accepted" }));

    const accepted = await submitNotice("correction", signed, { post } as never);

    expect(post).toHaveBeenCalledWith("/records", signed);
    expect(accepted.id).toBe("bafyrei-correction-record");
  });
});
