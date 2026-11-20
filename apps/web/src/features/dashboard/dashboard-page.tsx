"use client";

import { useCallback, useEffect, useState } from "react";

import { tokenStore, api } from "../../lib/api";
import { FEED_PATH } from "../feed/feed";
import { filedAppeal } from "../paper-page/appeal-dialog";
import { latestDecision, loadPaperRecords } from "../paper-page/unlisted-paper";
import { EmptyState, StatusChip, isPaperStatus } from "../ui-kit";

import { Card } from "./card";
import {
  DASHBOARD_TITLE,
  SECURITY_PATH,
  SIGNIN_HREF,
  describeDashboardError,
  loadDashboard as fetchDashboard,
  loadLinkedOrcid as fetchLinkedOrcid,
  moderationChip,
  orcidHref,
  ownProfileHref,
  type AttentionItem,
  type DashboardData,
  type MyPaper,
  type MyReview,
  type NeedsAttention,
} from "./dashboard";
import { NotificationsCard, type NotificationsCardProps } from "./notifications-card";
import { SavedSearchesCard, type SavedSearchesCardProps } from "./saved-searches-card";
import { didEndpoint, parseKeyState } from "./security";
import "./dashboard-page.css";

/** Loads the dashboard; replaceable in tests. */
export type LoadDashboard = () => Promise<DashboardData>;

/**
 * Loads the key the account currently signs with, from `GET /v1/did/{did}` —
 * the same read `/me/security` makes. The account DID is not the signing key:
 * after a rotation the DID is unchanged while the key is not.
 */
export type LoadActiveKey = (did: string) => Promise<string>;

/** The default: the DID document's active key. */
async function defaultLoadActiveKey(did: string): Promise<string> {
  const payload = await api.get<unknown>(didEndpoint(did), { cache: "no-store" });
  return parseKeyState(payload).activeKey;
}

/** Props for {@link DashboardPage}. Everything is optional. */
export interface DashboardPageProps {
  /** Dashboard fetched by the server route. */
  initialDashboard?: DashboardData;
  /** Alias used by callers that name the data generically. */
  initialData?: DashboardData;
  /** Alias used by callers that name the data after the route. */
  initialMe?: DashboardData;
  /** Alias used by callers mirroring the network page prop name. */
  initialStatus?: DashboardData;
  /** Alias used by callers that name the data generically. */
  initialResult?: DashboardData;
  /** Failure message from a server-side fetch; the client retries on mount. */
  initialError?: string;
  /** Replace the loader, for tests or an alternate API client. */
  loadDashboard?: LoadDashboard;
  /** Alias for {@link loadDashboard}. */
  loadMe?: LoadDashboard;
  /** Alias for {@link loadDashboard}. */
  loadMeDashboard?: LoadDashboard;
  /** Alias for {@link loadDashboard}. */
  loadData?: LoadDashboard;
  /** Alias for {@link loadDashboard}. */
  loadStatus?: LoadDashboard;
  /**
   * Pin the sign-in state. When omitted it is read from the shared token
   * store on mount.
   */
  signedIn?: boolean;
  /** Replace the saved-searches loader, for tests or an alternate API client. */
  loadSavedSearches?: SavedSearchesCardProps["loadSavedSearches"];
  /** Replace the saved-search delete call, for tests or an alternate API client. */
  deleteSavedSearch?: SavedSearchesCardProps["deleteSavedSearch"];
  /** Replace the notifications loader, for tests or an alternate API client. */
  loadNotifications?: NotificationsCardProps["loadNotifications"];
  /** Replace the mark-read call, for tests or an alternate API client. */
  markNotificationRead?: NotificationsCardProps["markNotificationRead"];
  /** Replace the linked-ORCID-iD loader, for tests or an alternate API client. */
  loadLinkedOrcid?: LoadLinkedOrcid;
  /** Replace the active signing-key loader, for tests or an alternate API client. */
  loadActiveKey?: LoadActiveKey;
  /** Replace the appeal lookup for held papers, for tests or an alternate API client. */
  loadAppealPending?: LoadAppealPending;
}

/** The ORCID iD linked to a DID, or `null` when none is. */
export type LoadLinkedOrcid = (did: string) => Promise<string | null>;

/** Whether a paper's appeal has been filed and still awaits a panel. */
export type LoadAppealPending = (paper: MyPaper) => Promise<boolean>;

type DashboardState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "ready"; data: DashboardData };

function initialState(
  initial: DashboardData | undefined,
  initialError: string | undefined,
): DashboardState {
  if (initial) {
    return { status: "ready", data: initial };
  }
  if (initialError) {
    return { status: "error", message: initialError };
  }
  return { status: "loading" };
}

/** The member's home screen: needs attention, their papers, their reviews. */
export function DashboardPage({
  initialDashboard,
  initialData,
  initialMe,
  initialStatus,
  initialResult,
  initialError,
  loadDashboard,
  loadMe,
  loadMeDashboard,
  loadData,
  loadStatus,
  signedIn,
  loadSavedSearches,
  deleteSavedSearch,
  loadNotifications,
  markNotificationRead,
  loadLinkedOrcid,
  loadActiveKey,
  loadAppealPending,
}: DashboardPageProps = {}) {
  const initial =
    initialDashboard ?? initialData ?? initialMe ?? initialStatus ?? initialResult;
  const [state, setState] = useState<DashboardState>(() =>
    initialState(initial, initialError),
  );
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    if (!(signedIn ?? tokenStore.isAuthenticated)) {
      setState({ status: "signed-out" });
      return;
    }

    if (initial && attempt === 0) {
      return;
    }

    let cancelled = false;
    const load =
      loadDashboard ?? loadMe ?? loadMeDashboard ?? loadData ?? loadStatus ?? fetchDashboard;
    setState({ status: "loading" });

    load().then(
      (data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: describeDashboardError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    initial,
    loadDashboard,
    loadMe,
    loadMeDashboard,
    loadData,
    loadStatus,
    signedIn,
  ]);

  // The header's bell deep-links to /me#notifications. The cards only exist
  // once the dashboard document has loaded, so the browser's own fragment
  // scroll fires too early on a cold load and leaves the reader at the top.
  // Once the cards have rendered -- and again on a later hash change -- bring
  // the Notifications section into view and put focus on its heading, so a
  // keyboard or screen-reader user lands there too.
  useEffect(() => {
    if (state.status !== "ready") {
      return;
    }
    const reveal = () => {
      if (window.location.hash !== "#notifications") {
        return;
      }
      const section = document.getElementById("notifications");
      if (section === null) {
        return;
      }
      section.scrollIntoView({ block: "start" });
      const heading = section.querySelector<HTMLElement>("h2");
      if (heading === null) {
        return;
      }
      if (!heading.hasAttribute("tabindex")) {
        heading.setAttribute("tabindex", "-1");
      }
      heading.focus({ preventScroll: true });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [state.status]);

  if (state.status === "signed-out") {
    return (
      <div className="db-page">
        <DashboardHeader />
        <div className="db-notice" role="alert">
          <h2 className="db-notice-title">Sign in to continue</h2>
          <p className="db-notice-text">Your dashboard is private to your account.</p>
          <a className="db-button" href={SIGNIN_HREF}>
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="db-page">
      <DashboardHeader />

      {state.status === "loading" ? (
        <p className="db-loading" role="status">
          Loading your dashboard…
        </p>
      ) : null}

      {state.status === "error" ? (
        <div className="db-notice" role="alert">
          <h2 className="db-notice-title">Couldn&rsquo;t load your dashboard</h2>
          <p className="db-notice-text">{state.message}</p>
          <button type="button" className="db-button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}

      {state.status === "ready" ? (
        <DashboardView
          data={state.data}
          onRefresh={retry}
          signedIn={signedIn}
          loadSavedSearches={loadSavedSearches}
          deleteSavedSearch={deleteSavedSearch}
          loadNotifications={loadNotifications}
          markNotificationRead={markNotificationRead}
          loadLinkedOrcid={loadLinkedOrcid}
          loadActiveKey={loadActiveKey}
          loadAppealPending={loadAppealPending}
        />
      ) : null}
    </div>
  );
}

/** The page title. */
function DashboardHeader() {
  return (
    <header className="db-header">
      <p className="db-kicker mono-id">scholium / me</p>
      <h1 className="db-title">{DASHBOARD_TITLE}</h1>
      <p className="db-lede">
        What needs your attention, the papers you wrote, and the reviews you wrote —
        all in one place.
      </p>
    </header>
  );
}

/** The five cards (docs/design.md §5.6), plus the reader's saved searches. */
function DashboardView({
  data,
  onRefresh,
  signedIn,
  loadSavedSearches,
  deleteSavedSearch,
  loadNotifications,
  markNotificationRead,
  loadLinkedOrcid = fetchLinkedOrcid,
  loadActiveKey = defaultLoadActiveKey,
  loadAppealPending = defaultLoadAppealPending,
}: {
  data: DashboardData;
  onRefresh: () => void;
  loadLinkedOrcid?: LoadLinkedOrcid;
  loadActiveKey?: LoadActiveKey;
  loadAppealPending?: LoadAppealPending;
} & SavedSearchesCardProps &
  NotificationsCardProps) {
  return (
    <div className="db-grid">
      <NeedsAttentionCard attention={data.needs_attention} onRefresh={onRefresh} />
      <MyPapersCard papers={data.my_papers} loadAppealPending={loadAppealPending} />
      <MyReviewsCard reviews={data.my_reviews} />
      <SavedSearchesCard
        signedIn={signedIn}
        loadSavedSearches={loadSavedSearches}
        deleteSavedSearch={deleteSavedSearch}
      />
      <CredentialsCard
        did={data.did}
        loadLinkedOrcid={loadLinkedOrcid}
        loadActiveKey={loadActiveKey}
      />
      <SecurityCard />
      <NotificationsCard
        signedIn={signedIn}
        loadNotifications={loadNotifications}
        markNotificationRead={markNotificationRead}
      />
    </div>
  );
}

/** Re-exported for `security-page`, which imported the card from here. */
export { Card };

/** How each kind of attention item is named on screen. */
const ATTENTION_KIND_LABELS: Readonly<Record<string, string>> = {
  consent_to_sign: "Consent to sign",
  review_invitation: "Review invitation",
  author_reply: "Author reply",
  moderation_outcome: "Moderation outcome",
  appeal_available: "Appeal",
  appeal_panel: "Appeal panel",
  email_verification: "Email verification",
  recovery_request: "Recovery request",
};

/**
 * The chip's words for an attention kind.
 *
 * An unknown kind is spelled out in sentence case, so one list never mixes
 * "Author reply" with "recovery request".
 */
export function attentionKindLabel(kind: string): string {
  const known = ATTENTION_KIND_LABELS[kind];
  if (known !== undefined) {
    return known;
  }
  const words = kind.replace(/[._-]+/g, " ").trim();
  return words === "" ? words : words.charAt(0).toUpperCase() + words.slice(1);
}

/** `1 review`, `3 reviews`. */
function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `awaiting_consent` → `awaiting consent`. */
function humanState(state: string): string {
  return state.replace(/_/g, " ");
}

function NeedsAttentionCard({
  attention,
  onRefresh,
}: {
  attention: NeedsAttention;
  onRefresh: () => void;
}) {
  const items = attention.items;
  return (
    <Card title="Needs your attention">
      {items.length === 0 ? (
        <EmptyState
          sentence="Nothing needs your attention right now."
          action={{ label: "Refresh", onClick: onRefresh }}
        />
      ) : (
        <>
          <p className="db-count meta">{countLabel(attention.count, "item")}</p>
          <ul className="db-list">
            {items.map((item, index) => (
              <AttentionRow
                key={`${item.kind}-${item.paperCid ?? item.paper ?? index}`}
                item={item}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const headline = item.summary ?? item.title ?? attentionKindLabel(item.kind);
  // The summary already names the paper; only a reason belongs beneath it.
  const detail = item.reason ?? (item.summary === null ? item.title : null);
  return (
    <li className="db-item" data-kind={item.kind}>
      <span className="db-chip">{attentionKindLabel(item.kind)}</span>
      <p className="db-item-summary">{headline}</p>
      {detail ? <p className="db-item-detail meta">{detail}</p> : null}
      {item.link ? (
        <a className="db-link" href={item.link}>
          Open
        </a>
      ) : null}
    </li>
  );
}

/**
 * Whether the paper's public records show an appeal of the decision that
 * stands, which no panel has decided yet. The records are the same ones the
 * paper page reads (`GET /v1/export/paper/{id}/records`), so the two screens
 * can never disagree about an appeal.
 */
export function hasPendingAppeal(
  entries: readonly unknown[],
  versionCid: string | null,
): boolean {
  const appeal = filedAppeal(entries, latestDecision(entries, versionCid));
  return appeal !== null && appeal.outcome === null;
}

async function defaultLoadAppealPending(paper: MyPaper): Promise<boolean> {
  const id = paper.shortId ?? paper.paperCid;
  if (id === null) {
    return false;
  }
  return hasPendingAppeal(await loadPaperRecords(id), paper.latestVersionCid);
}

function MyPapersCard({
  papers,
  loadAppealPending,
}: {
  papers: readonly MyPaper[];
  loadAppealPending: LoadAppealPending;
}) {
  return (
    <Card title="My papers" anchor="papers">
      {papers.length === 0 ? (
        <EmptyState
          sentence="You have not authored any papers yet."
          action={{ label: "Submit a paper", href: "/submit" }}
        />
      ) : (
        <ul className="db-list">
          {papers.map((paper) => (
            <li
              className="db-paper"
              key={paper.paperCid ?? paper.paper ?? paper.title ?? "paper"}
            >
              <div className="db-paper-head">
                {paper.link ? (
                  <a className="db-link db-paper-title" href={paper.link}>
                    {paper.title ?? paper.paper ?? "Untitled paper"}
                  </a>
                ) : (
                  <span className="db-paper-title">
                    {paper.title ?? paper.paper ?? "Untitled paper"}
                  </span>
                )}
                <PaperChips paper={paper} loadAppealPending={loadAppealPending} />
              </div>
              <p className="db-paper-meta meta">
                {countLabel(paper.reviewCount, "review")}
                {paper.versionCount > 0
                  ? ` · ${countLabel(paper.versionCount, "version")}`
                  : ""}
                {paper.state ? ` · ${humanState(paper.state)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * A paper's two chips: where moderation has it (Held, Appeal pending,
 * Rejected, Listed, Awaiting consent…) and, beside it, the review status the
 * API computed from the reviews.
 *
 * A hold alone makes the computed status `contested`, so for a paper a
 * moderator has stopped that word is left off: the moderation chip already says
 * what happened, and "Contested" would read as a reviewer's rejection.
 */
function PaperChips({
  paper,
  loadAppealPending,
}: {
  paper: MyPaper;
  loadAppealPending: LoadAppealPending;
}) {
  const stopped = paper.state === "held" || paper.state === "rejected";
  const [appealPending, setAppealPending] = useState(false);

  useEffect(() => {
    if (!stopped) {
      return;
    }
    let cancelled = false;
    loadAppealPending(paper).then(
      (pending) => {
        if (!cancelled) {
          setAppealPending(pending);
        }
      },
      () => {
        // The records could not be read: the chip keeps saying Held.
        if (!cancelled) {
          setAppealPending(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [stopped, paper, loadAppealPending]);

  const chip = moderationChip(paper, { appealPending });
  const hideContested = chip?.stopped === true && paper.status === "contested";
  return (
    <span className="db-paper-chips">
      {chip === null ? null : (
        <span className="db-chip" data-tone={chip.tone} data-moderation={chip.state}>
          {chip.label}
        </span>
      )}
      {hideContested ? null : <PaperStatus paper={paper} />}
    </span>
  );
}

/** The stored status as an icon-plus-word chip; never colour alone. */
function PaperStatus({ paper }: { paper: MyPaper }) {
  if (paper.status === null) {
    return null;
  }
  if (isPaperStatus(paper.status)) {
    return <StatusChip status={paper.status} count={paper.reviewCount} />;
  }
  // A status this build does not know yet: show the word rather than nothing.
  return <span className="db-chip">{humanState(paper.status)}</span>;
}

function MyReviewsCard({ reviews }: { reviews: readonly MyReview[] }) {
  return (
    <Card title="My reviews" anchor="reviews">
      {reviews.length === 0 ? (
        <EmptyState
          sentence="You have not written any reviews yet."
          action={{ label: "Find a paper to review", href: FEED_PATH }}
        />
      ) : (
        <ul className="db-list">
          {reviews.map((review) => (
            <ReviewRow key={review.reviewCid} review={review} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReviewRow({ review }: { review: MyReview }) {
  const meta: string[] = [];
  if (review.version !== null) {
    meta.push(`v${review.version}`);
  }
  if (review.awaitingAuthor) {
    meta.push("Awaiting author");
  } else if (review.authorReplied) {
    meta.push("Author replied");
  }
  if (review.responseCount > 0) {
    meta.push(countLabel(review.responseCount, "response"));
  }
  return (
    <li className="db-review">
      <div className="db-review-head">
        {review.link ? (
          <a className="db-link db-review-title" href={review.link}>
            {review.title ?? review.paper ?? "Review"}
          </a>
        ) : (
          <span className="db-review-title">{review.title ?? review.paper ?? "Review"}</span>
        )}
        <span className="db-chip" data-tone={review.revealed ? "verified" : "pending"}>
          {review.revealed ? "Revealed" : "Sealed"}
        </span>
      </div>
      {meta.length > 0 ? <p className="db-review-meta meta">{meta.join(" · ")}</p> : null}
    </li>
  );
}

type OrcidState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; orcid: string | null };

type SigningKeyState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; activeKey: string };

/**
 * The key the member signs with — the account's *active* key, read from
 * `GET /v1/did/{did}` like `/me/security` does — the ORCID iD linked to the
 * account, and the way to the public profile.
 *
 * The account DID and the signing key are shown separately because a rotation
 * changes one and not the other: labelling the DID "the key you sign with" is
 * what made `/me` disagree with `/me/security` after a rotation. When they
 * are the same (no rotation yet) one line says it.
 *
 * The key and the iD are read on their own, so failing to read one never
 * hides the other.
 */
function CredentialsCard({
  did,
  loadLinkedOrcid,
  loadActiveKey,
}: {
  did: string;
  loadLinkedOrcid: LoadLinkedOrcid;
  loadActiveKey: LoadActiveKey;
}) {
  const [orcid, setOrcid] = useState<OrcidState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [signingKey, setSigningKey] = useState<SigningKeyState>({ status: "loading" });
  const [keyAttempt, setKeyAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOrcid({ status: "loading" });
    loadLinkedOrcid(did).then(
      (value) => {
        if (!cancelled) {
          setOrcid({ status: "ready", orcid: value });
        }
      },
      () => {
        if (!cancelled) {
          setOrcid({ status: "error" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [did, loadLinkedOrcid, attempt]);

  useEffect(() => {
    let cancelled = false;
    setSigningKey({ status: "loading" });
    loadActiveKey(did).then(
      (activeKey) => {
        if (!cancelled) {
          setSigningKey({ status: "ready", activeKey });
        }
      },
      () => {
        if (!cancelled) {
          setSigningKey({ status: "error" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [did, loadActiveKey, keyAttempt]);

  return (
    <Card title="Credentials" anchor="credentials">
      <p className="db-cred-label meta">You sign with this key</p>
      {signingKey.status === "loading" ? (
        <p className="db-cred-note meta">Checking your signing key…</p>
      ) : null}
      {signingKey.status === "ready" ? (
        <p className="db-cred-id mono-id">{signingKey.activeKey}</p>
      ) : null}
      {signingKey.status === "error" ? (
        <div className="db-cred-error">
          <p className="db-cred-note meta">Couldn&rsquo;t read your signing key.</p>
          <button
            type="button"
            className="db-button"
            onClick={() => setKeyAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {/* The account DID, separately, only when it is not the signing key. */}
      {signingKey.status === "ready" && signingKey.activeKey === did ? null : (
        <>
          <p className="db-cred-label meta">Account</p>
          <p className="db-cred-id mono-id">{did}</p>
        </>
      )}

      <p className="db-cred-label meta">ORCID iD</p>
      {orcid.status === "loading" ? (
        <p className="db-cred-note meta">Checking for a linked ORCID iD…</p>
      ) : null}
      {orcid.status === "ready" && orcid.orcid !== null ? (
        <p className="db-cred-id mono-id">
          <a className="db-link" href={orcidHref(orcid.orcid)} rel="noopener noreferrer">
            {orcid.orcid}
          </a>
        </p>
      ) : null}
      {orcid.status === "ready" && orcid.orcid === null ? (
        <p className="db-cred-note meta">No ORCID iD linked yet.</p>
      ) : null}
      {orcid.status === "error" ? (
        <div className="db-cred-error">
          <p className="db-cred-note meta">Couldn&rsquo;t read your ORCID iD.</p>
          <button
            type="button"
            className="db-button"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}

      <p className="db-cred-note meta">
        Affiliation, reviewer categories and contribution credentials appear here, each
        with a proof you can share.
      </p>
      <a className="db-button" href={ownProfileHref(did)}>
        View public profile
      </a>
    </Card>
  );
}

/** Doorway to `/me/security`; the screen itself reads the key and guardian state. */
function SecurityCard() {
  return (
    <Card title="Security" anchor="security">
      <p className="db-cred-note meta">
        Your devices, your recovery guardians and your last key rotation.
      </p>
      <a className="db-button" href={SECURITY_PATH}>
        Manage security
      </a>
    </Card>
  );
}

export type { DashboardPageProps as MePageProps };
export type { DashboardPageProps as MeDashboardPageProps };

/** Alias for callers that name the component after the route. */
export const MePage = DashboardPage;
/** Alias for callers that name the component after the endpoint. */
export const MeDashboardPage = DashboardPage;
/** Alias for callers that name the component generically. */
export const Dashboard = DashboardPage;
