// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tokenStore } from "../../lib/api";

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
