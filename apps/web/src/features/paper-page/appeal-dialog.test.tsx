// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../../lib/api";
import { PasskeyCancelledError } from "../web-auth/errors";
import type { SignedRecord } from "../web-auth/sign-record";
import {
  APPEAL_EMPTY_GROUNDS,
  AppealDialog,
  describeAppealError,
  filedAppeal,
  latestAppealableDecision,
  loadAppealableDecision,
  submitAppeal,
  subscribeAppealFiled,
  type AppealAccepted,
  type AppealBody,
  type AppealableDecision,
  type LoadAppealableDecision,
  type SignAppeal,
  type SubmitAppeal,
} from "./appeal-dialog";

/**
 * File an appeal (MOD-2): the decision the public records name, the grounds
 * the author signs, and the `appeal` record sent to `POST /v1/appeals`.
 * Reading, signing and sending are injected, so the flow runs without a node
 * or a passkey.
 */

const PAPER = "sch:6sel-2dio-orm6";
const PAPER_CID = "bafyrei-genesis";
const DECISION = "bafyrei-decision";
const MODERATOR = "did:key:z6MkkModeratorDecisionSigner000000000000000000000";

const HELD: AppealableDecision = {
  decisionCid: DECISION,
  action: "hold",
  clause: "MOD-01",
  reason: "Outside the category's scope.",
  versionCid: "bafyrei-version-2",
  moderatorDid: MODERATOR,
};

function record(body: AppealBody): SignedRecord {
  return {
    v: 1,
    type: "appeal",
    id: "bafyrei-appeal-record",
    author: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    created: "2027-03-05T10:00:00Z",
    prev: null,
    body,
    proofs: [],
    sig: "signature",
  };
}

function seams() {
  const sign = vi.fn<SignAppeal>(async (body) => record(body));
  const submit = vi.fn<SubmitAppeal>(
    async (): Promise<AppealAccepted> => ({
      id: "bafyrei-appeal-record",
      status: "pending",
    }),
  );
  return { sign, submit };
}

function show(
  options: {
    load?: LoadAppealableDecision;
    sign?: SignAppeal;
    submit?: SubmitAppeal;
  } = {},
) {
  const { sign, submit } = seams();
  const load = vi.fn<LoadAppealableDecision>(async () => HELD);
  return render(
    <AppealDialog
      paperId={PAPER}
      paperCid={PAPER_CID}
      load={options.load ?? load}
      sign={options.sign ?? sign}
      submit={options.submit ?? submit}
    />,
  );
}

const trigger = () => screen.getByRole("button", { name: "File an appeal" });
const groundsField = () => screen.getByLabelText("Grounds for appeal") as HTMLTextAreaElement;

async function open(): Promise<void> {
  await act(async () => {
    fireEvent.click(trigger());
  });
}

function type(text: string): void {
  fireEvent.change(groundsField(), { target: { value: text } });
}

async function submitForm(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sign and file appeal/ }));
  });
}

afterEach(() => {
  cleanup();
});

describe("when the action is offered", () => {
  it("appears only once a hold or reject is the latest decision", async () => {
    show();
    await waitFor(() => expect(trigger()).toBeTruthy());
  });

  it("renders nothing while the records are unreadable", async () => {
    const load: LoadAppealableDecision = vi.fn(async () => {
      throw new NetworkError("https://node.example");
    });
    show({ load });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });

  it("renders nothing when there is no appealable decision", async () => {
    show({ load: async () => null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });
});

describe("the dialog", () => {
  it("names the decision and its clause, and reads the moderator's reason", async () => {
    show();
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();

    const dialog = screen.getByRole("dialog", { name: "Appeal the moderation decision" });
    expect(dialog.textContent).toContain("held this paper from listing");
    expect(dialog.textContent).toContain("MOD-01");
    expect(dialog.textContent).toContain("Outside the category's scope.");
  });

  it("says what blank grounds need, and signs nothing", async () => {
    const { sign, submit } = seams();
    show({ sign, submit });
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain(APPEAL_EMPTY_GROUNDS);
    expect(sign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("signs {target, grounds, paper} and sends it to the appeals endpoint", async () => {
    const { sign, submit } = seams();
    show({ sign, submit });
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();
    type("  The paper is in scope; clause MOD-01 applies to a different field.  ");

    await submitForm();

    expect(sign).toHaveBeenCalledWith({
      target: DECISION,
      grounds: "The paper is in scope; clause MOD-01 applies to a different field.",
      paper: PAPER_CID,
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ type: "appeal" }));
    await waitFor(() => expect(screen.getByText("Your appeal is filed")).toBeTruthy());
    expect(screen.getByText("bafyrei-appeal-record")).toBeTruthy();
  });

  it("tells the page the appeal was filed, so the banner behind the dialog can update", async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribeAppealFiled((event) => events.push(event));
    try {
      show();
      await waitFor(() => expect(trigger()).toBeTruthy());
      await open();
      type("The paper is in scope.");

      await submitForm();

      expect(events).toEqual([
        {
          paperId: PAPER,
          appeal: expect.objectContaining({
            appealCid: "bafyrei-appeal-record",
            decisionCid: DECISION,
            filedAt: expect.any(String),
            outcome: null,
          }),
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("stops offering File an appeal once the filed dialog is closed", async () => {
    show();
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();
    type("The paper is in scope.");
    await submitForm();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    expect(screen.queryByRole("button", { name: "File an appeal" })).toBeNull();
  });
});

describe("failures", () => {
  it("says the passkey was cancelled and that nothing was filed", async () => {
    const sign: SignAppeal = vi.fn(async () => {
      throw new PasskeyCancelledError();
    });
    show({ sign });
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();
    type("The grounds.");

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain("Signing was cancelled");
    expect(screen.getByRole("alert").textContent).toContain("no appeal was filed.");
  });

  it("shows the node's own words when the decision was already appealed", async () => {
    const sign: SignAppeal = vi.fn(async (body) => record(body));
    const submit: SubmitAppeal = vi.fn(async () => {
      throw new ApiError(409, {
        detail: "This moderation decision has already been appealed.",
      } as never);
    });
    show({ sign, submit });
    await waitFor(() => expect(trigger()).toBeTruthy());
    await open();
    type("The grounds.");

    await submitForm();

    expect(screen.getByRole("alert").textContent).toContain(
      "This moderation decision has already been appealed.",
    );
  });
});

describe("joining the paper's public records", () => {
  const decision = (seq: number, action: string, cid = `bafyrei-decision-${seq}`) => ({
    seq,
    record_cid: cid,
    record_type: "moderation.decision",
    author_did: MODERATOR,
    body: { action, target: "bafyrei-version-2", clause: "MOD-01", reason: "A reason." },
  });
  const appeal = (seq: number, target: string) => ({
    seq,
    record_cid: `bafyrei-appeal-${seq}`,
    record_type: "appeal",
    author_did: "did:key:author",
    body: { target, grounds: "Why." },
  });

  it("offers the latest hold or reject", () => {
    expect(
      latestAppealableDecision([decision(4, "hold"), decision(8, "reject", "bafyrei-reject")]),
    ).toMatchObject({ decisionCid: "bafyrei-reject", action: "reject", clause: "MOD-01" });
  });

  it("offers nothing when a later decision listed the paper", () => {
    expect(latestAppealableDecision([decision(4, "reject"), decision(9, "list")])).toBeNull();
  });

  it("offers nothing when the decision was already appealed", () => {
    expect(latestAppealableDecision([decision(4, "hold", "bafyrei-held"), appeal(5, "bafyrei-held")])).toBeNull();
  });

  it("skips entries it cannot read rather than guessing", () => {
    expect(
      latestAppealableDecision([null, "nope", { seq: 1 }, decision(6, "hold", "bafyrei-held")]),
    ).toMatchObject({ decisionCid: "bafyrei-held" });
  });

  it("reads the per-paper records without a token", async () => {
    const get = vi.fn(async () => [decision(4, "hold", "bafyrei-held")]);
    const found = await loadAppealableDecision(PAPER, undefined, { get } as never);
    expect(found).toMatchObject({ decisionCid: "bafyrei-held", action: "hold" });
    expect(get).toHaveBeenCalledWith(
      `/export/paper/${encodeURIComponent(PAPER)}/records`,
      expect.objectContaining({ auth: false }),
    );
  });
});

describe("the appeal a decision already has", () => {
  const hold = {
    decisionCid: "bafyrei-held",
    action: "hold",
  };
  const filed = (seq = 5, target = "bafyrei-held") => ({
    seq,
    record_cid: `bafyrei-appeal-${seq}`,
    record_type: "appeal",
    author_did: "did:key:author",
    received_at: "2027-03-05T10:00:00Z",
    body: { target, grounds: "Why.", paper: "bafyrei-genesis" },
  });
  const verdict = (seq = 6, outcome = "upheld") => ({
    seq,
    record_cid: `bafyrei-verdict-${seq}`,
    record_type: "appeal.decision",
    author_did: "did:key:node",
    received_at: "2027-03-06T10:00:00Z",
    body: { target: "bafyrei-appeal-5", outcome, reasons: ["In scope."] },
  });
  const release = (seq = 7) => ({
    seq,
    record_cid: `bafyrei-release-${seq}`,
    record_type: "moderation.decision",
    author_did: "did:key:node",
    received_at: "2027-03-06T10:00:00Z",
    body: {
      target: "bafyrei-version-2",
      action: "release",
      state: "moderation",
      appeal: "bafyrei-appeal-5",
      appeal_restoration: "bafyrei-appeal-5",
    },
  });

  it("finds the appeal of the decision, with when it was filed", () => {
    expect(filedAppeal([hold, filed(5)], hold)).toEqual({
      appealCid: "bafyrei-appeal-5",
      decisionCid: "bafyrei-held",
      filedAt: "2027-03-05T10:00:00Z",
      outcome: null,
      verdictCid: null,
      decidedAt: null,
    });
  });

  it("adds the panel's outcome once there is one", () => {
    expect(filedAppeal([filed(5), verdict(6, "overturned")], hold)).toMatchObject({
      appealCid: "bafyrei-appeal-5",
      outcome: "overturned",
      verdictCid: "bafyrei-verdict-6",
      decidedAt: "2027-03-06T10:00:00Z",
    });
  });

  it("is null when the decision has no appeal, or another one was appealed", () => {
    expect(filedAppeal([hold], hold)).toBeNull();
    expect(filedAppeal([hold, filed(5, "bafyrei-something-else")], hold)).toBeNull();
    expect(filedAppeal([hold], null)).toBeNull();
  });

  it("finds the appeal an overturning release restored", () => {
    expect(
      filedAppeal(
        [filed(5), verdict(6, "overturned"), release(7)],
        { decisionCid: "bafyrei-release-7", action: "release" },
      ),
    ).toMatchObject({
      appealCid: "bafyrei-appeal-5",
      outcome: "overturned",
    });
  });

  it("skips entries it cannot read rather than guessing", () => {
    expect(
      filedAppeal([null, "nope", { seq: 1 }, filed(5), verdict(6)], hold),
    ).toMatchObject({ appealCid: "bafyrei-appeal-5", outcome: "upheld" });
  });
});

describe("the failure sentences", () => {
  it("does not claim an appeal exists after a network failure", () => {
    const failure = describeAppealError(new NetworkError("https://node.example"));
    expect(failure.message).toContain("No appeal was filed.");
    expect(failure.signIn).toBe(false);
  });

  it("offers a sign-in when the session has ended", () => {
    expect(
      describeAppealError(new ApiError(401, { detail: "Unauthorized" } as never)).signIn,
    ).toBe(true);
  });

  it("posts the signed appeal to POST /v1/appeals", async () => {
    const signed = record({ target: DECISION, grounds: "The grounds.", paper: PAPER_CID });
    const post = vi.fn(async () => ({ id: signed.id, status: "pending" }));

    const accepted = await submitAppeal(signed, { post } as never);

    expect(post).toHaveBeenCalledWith("/appeals", signed);
    expect(accepted).toEqual({ id: "bafyrei-appeal-record", status: "pending" });
  });
});
