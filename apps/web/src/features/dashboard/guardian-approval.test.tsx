// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, tokenStore } from "../../lib/api";

import { NOTIFICATIONS_CHANGED_EVENT, type NotificationItem } from "./dashboard";
import { GuardianApprovalPage, type GuardianApprovalData } from "./guardian-approval";

const VIEWER = "did:key:z6MkGuardianViewerViewerViewerViewerViewerViewer1";
const OTHER = "did:key:z6MkGuardianOtherOtherOtherOtherOtherOtherOther2";
const ACCOUNT = "did:key:z6MkAccountAccountAccountAccountAccountAccount3";
const NEW_KEY = "did:key:z6MkNewKeyNewKeyNewKeyNewKeyNewKeyNewKeyNewKey4";

function request(overrides: Partial<GuardianApprovalData> = {}): GuardianApprovalData {
  return {
    requestId: "rec_1",
    status: "pending",
    accountDid: ACCOUNT,
    accountName: "Ada Lovelace",
    newPublicKey: NEW_KEY,
    approvals: 0,
    threshold: 3,
    contestUntil: null,
    requestedAt: "2026-11-16T09:00:00Z",
    approvalDids: [],
    approvalTimes: {},
    ...overrides,
  };
}

function renderPage(data: GuardianApprovalData, props: Parameters<typeof GuardianApprovalPage>[0] = {}) {
  return render(<GuardianApprovalPage initialRequest={data} signedIn viewerDid={VIEWER} {...props} />);
}

afterEach(() => {
  cleanup();
  tokenStore.clear();
  vi.restoreAllMocks();
});

describe("GuardianApprovalPage", () => {
  it("offers Approve and Decline to a guardian who has not answered", () => {
    renderPage(request());

    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByText(/You approved/)).toBeNull();
  });

  it("shows a guardian their answer, with the date, and no actions", () => {
    renderPage(
      request({
        approvals: 1,
        approvalDids: [VIEWER],
        approvalTimes: { [VIEWER]: "2026-11-17T12:00:00Z" },
      }),
    );

    expect(screen.getByText(/You approved on 17 Nov 2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("offers no actions once enough guardians have approved", () => {
    renderPage(
      request({
        status: "contest",
        approvals: 3,
        approvalDids: [OTHER, ACCOUNT, VIEWER],
        contestUntil: "2026-11-20T12:00:00Z",
      }),
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.getByText(/You approved on/)).toBeTruthy();
  });

  it("offers no further actions at the threshold even to a guardian who has not answered", () => {
    renderPage(
      request({
        status: "contest",
        approvals: 3,
        approvalDids: [OTHER, ACCOUNT, "did:key:z6MkThirdThirdThirdThirdThirdThirdThird5"],
      }),
    );

    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.getByText(/3 of 3/)).toBeTruthy();
  });

  it("tells a guardian who approved that the account holder cancelled it", () => {
    renderPage(
      request({
        status: "cancelled",
        approvals: 3,
        approvalDids: [VIEWER, OTHER, "did:key:z6MkThirdThirdThirdThirdThirdThirdThird5"],
        approvalTimes: { [VIEWER]: "2026-11-17T12:00:00Z" },
        closedAt: "2026-11-18T09:30:00Z",
      }),
    );

    expect(screen.getByText(/Cancelled by the account holder on 18 Nov 2026/)).toBeTruthy();
    expect(screen.queryByText(/You approved/)).toBeNull();
    expect(screen.queryByText(/No further action is needed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.queryByText(/3 of 3/)).toBeNull();
  });

  it("tells a guardian who did not answer that it was cancelled, not that enough approved", () => {
    renderPage(
      request({
        status: "cancelled",
        approvals: 3,
        approvalDids: [OTHER, ACCOUNT, "did:key:z6MkThirdThirdThirdThirdThirdThirdThird5"],
        closedAt: "2026-11-18T09:30:00Z",
      }),
    );

    expect(screen.getByText(/Cancelled by the account holder on 18 Nov 2026/)).toBeTruthy();
    expect(screen.queryByText(/Enough guardians have approved/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("tells every guardian of a cancellation nobody approved, without counting approvals", () => {
    renderPage(request({ status: "cancelled", approvals: 0, approvalDids: [] }));

    expect(screen.getByText("Cancelled by the account holder.")).toBeTruthy();
    expect(screen.queryByText(/0 of 3/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  describe("the lead over the request", () => {
    it("keeps the present tense while the request waits for guardians", () => {
      renderPage(request());

      expect(
        screen.getByText("Ada Lovelace is asking to recover their account."),
      ).toBeTruthy();
    });

    it("keeps the present tense while the safety window is open", () => {
      renderPage(
        request({ status: "contest", approvals: 3, contestUntil: "2026-11-20T12:00:00Z" }),
      );

      expect(
        screen.getByText("Ada Lovelace is asking to recover their account."),
      ).toBeTruthy();
    });

    it("reads in the past tense on a cancelled request", () => {
      renderPage(request({ status: "cancelled", closedAt: "2026-11-18T09:30:00Z" }));

      expect(screen.getByText("Ada Lovelace asked to recover their account.")).toBeTruthy();
      expect(
        screen.queryByText("Ada Lovelace is asking to recover their account."),
      ).toBeNull();
    });

    it("reads in the past tense on a completed request", () => {
      renderPage(request({ status: "finalized", approvals: 3 }));

      expect(screen.getByText("Ada Lovelace asked to recover their account.")).toBeTruthy();
      expect(
        screen.queryByText("Ada Lovelace is asking to recover their account."),
      ).toBeNull();
    });

    it("says a member asked when no name is known", () => {
      renderPage(request({ status: "cancelled", accountName: null }));

      expect(screen.getByText("A member asked to recover their account.")).toBeTruthy();
      expect(
        screen.queryByText("A member is asking to recover their account."),
      ).toBeNull();
    });
  });

  describe("loaded from the API", () => {
    // What GET /v1/recovery/requests/{id} returns for a cancelled request: the
    // page words the date from the `closed_at` the API gives it.
    function serve(detail: Record<string, unknown>) {
      return vi.spyOn(api, "get").mockImplementation(async (path: string) => {
        if (path.startsWith("/recovery/requests/")) return detail;
        return { name: "Ada Lovelace" };
      });
    }
    const cancelled = {
      request_id: "rec_1",
      status: "cancelled",
      did: ACCOUNT,
      new_public_key: NEW_KEY,
      approvals: [],
      approval_count: 0,
      contest_until: null,
      threshold: 3,
    };

    it("dates the cancellation from the closed_at the API returns", async () => {
      serve({ ...cancelled, closed_at: "2026-11-18T09:30:00Z" });

      render(<GuardianApprovalPage requestId="rec_1" signedIn viewerDid={VIEWER} />);

      expect(await screen.findByText("Cancelled by the account holder on 18 Nov 2026.")).toBeTruthy();
      expect(screen.queryByText("Cancelled by the account holder.")).toBeNull();
    });

    it("dates it for a guardian who had approved too", async () => {
      serve({
        ...cancelled,
        approvals: [{ guardian: VIEWER, approved_at: "2026-11-17T12:00:00Z" }],
        approval_count: 1,
        closed_at: "2026-11-18T09:30:00Z",
      });

      render(<GuardianApprovalPage requestId="rec_1" signedIn viewerDid={VIEWER} />);

      expect(await screen.findByText("Cancelled by the account holder on 18 Nov 2026.")).toBeTruthy();
      expect(screen.queryByText(/You approved/)).toBeNull();
    });

    it("says it without a date when the API has no time for it", async () => {
      serve({ ...cancelled, closed_at: null });

      render(<GuardianApprovalPage requestId="rec_1" signedIn viewerDid={VIEWER} />);

      expect(await screen.findByText("Cancelled by the account holder.")).toBeTruthy();
    });
  });

  it("says a completed recovery is complete", () => {
    renderPage(
      request({
        status: "finalized",
        approvals: 3,
        approvalDids: [VIEWER, OTHER, "did:key:z6MkThirdThirdThirdThirdThirdThirdThird5"],
      }),
    );

    expect(screen.getByText(/recovery is complete/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("records the date on the guardian's answer after they approve", async () => {
    const approve = vi.fn(async () => undefined);
    renderPage(request(), { approve });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText(/You approved on/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(approve).toHaveBeenCalledWith("rec_1");
  });

  describe("the bell", () => {
    const notice = (id: number, read: boolean): NotificationItem => ({
      id,
      did: VIEWER,
      kind: "recovery.request",
      payload: { request_id: `rec_${id}` },
      read,
    });
    const heard: number[] = [];
    const listen = (event: Event) => {
      heard.push((event as CustomEvent<{ unread: number }>).detail.unread);
    };

    beforeEach(() => {
      heard.length = 0;
      window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, listen);
    });
    afterEach(() => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, listen));

    it("is told the new unread count as soon as the guardian approves", async () => {
      const approve = vi.fn(async () => undefined);
      // The server resolved this guardian's notice when the approval landed.
      const loadNotifications = vi.fn(async () => [notice(1, true), notice(2, false)]);
      renderPage(request(), { approve, loadNotifications });

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      await waitFor(() => expect(heard).toEqual([1]));
      expect(loadNotifications).toHaveBeenCalledTimes(1);
    });

    it("is told after a decline too", async () => {
      const decline = vi.fn(async () => undefined);
      const loadNotifications = vi.fn(async () => [notice(1, false)]);
      renderPage(request(), { decline, loadNotifications });

      fireEvent.click(screen.getByRole("button", { name: "Decline" }));

      await waitFor(() => expect(heard).toEqual([1]));
    });

    it("hears nothing when the approval fails", async () => {
      const approve = vi.fn(async () => {
        throw new Error("Approval failed.");
      });
      const loadNotifications = vi.fn(async () => [notice(1, false)]);
      renderPage(request(), { approve, loadNotifications });

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      await screen.findByText("Approval failed.");
      expect(loadNotifications).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
    });

    it("still shows the answer when the count cannot be fetched", async () => {
      const approve = vi.fn(async () => undefined);
      const loadNotifications = vi.fn(async () => {
        throw new Error("offline");
      });
      renderPage(request(), { approve, loadNotifications });

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      await waitFor(() => expect(screen.getByText(/You approved on/)).toBeTruthy());
      expect(heard).toEqual([]);
    });
  });
});
