"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { tokenStore } from "../../lib/api";
import { EmptyState, StatusChip, isPaperStatus } from "../ui-kit";

import {
  DASHBOARD_TITLE,
  SECURITY_PATH,
  SIGNIN_HREF,
  describeDashboardError,
  loadDashboard as fetchDashboard,
  type AttentionItem,
  type DashboardData,
  type MyPaper,
  type MyReview,
  type NeedsAttention,
} from "./dashboard";
import "./dashboard-page.css";

/** Loads the dashboard; replaceable in tests. */
export type LoadDashboard = () => Promise<DashboardData>;

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
}

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
        <DashboardView data={state.data} onRefresh={retry} />
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

/** The five cards (docs/design.md §5.6). */
function DashboardView({
  data,
  onRefresh,
}: {
  data: DashboardData;
  onRefresh: () => void;
}) {
  return (
    <div className="db-grid">
      <NeedsAttentionCard attention={data.needs_attention} onRefresh={onRefresh} />
      <MyPapersCard papers={data.my_papers} />
      <MyReviewsCard reviews={data.my_reviews} />
      <CredentialsCard did={data.did} />
      <SecurityCard />
      <NotificationsCard onRefresh={onRefresh} />
    </div>
  );
}

/** One card. `anchor` is set where another screen deep-links to it. */
export function Card({
  title,
  anchor,
  children,
}: {
  title: string;
  anchor?: string;
  children: ReactNode;
}) {
  const headingId = `db-${anchor ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  return (
    <section className="db-card" id={anchor} aria-labelledby={headingId}>
      <h2 className="db-card-title" id={headingId}>
        {title}
      </h2>
      <div className="db-card-body">{children}</div>
    </section>
  );
}

/** How each kind of attention item is named on screen. */
const ATTENTION_KIND_LABELS: Readonly<Record<string, string>> = {
  consent_to_sign: "Consent to sign",
  review_invitation: "Review invitation",
  author_reply: "Author reply",
  moderation_outcome: "Moderation outcome",
};

function attentionKindLabel(kind: string): string {
  return ATTENTION_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
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
  const detail = item.reason ?? (item.summary ? item.title : null);
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

function MyPapersCard({ papers }: { papers: readonly MyPaper[] }) {
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
                <PaperStatus paper={paper} />
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
          action={{ label: "Find a paper to review", href: "/" }}
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

function CredentialsCard({ did }: { did: string }) {
  return (
    <Card title="Credentials" anchor="credentials">
      <p className="db-cred-label meta">You sign with this key</p>
      <p className="db-cred-id mono-id">{did}</p>
      <p className="db-cred-note meta">
        ORCID, affiliation, reviewer categories and contribution credentials appear
        here, each with a proof you can share.
      </p>
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

function NotificationsCard({ onRefresh }: { onRefresh: () => void }) {
  return (
    <Card title="Notifications" anchor="notifications">
      <EmptyState
        sentence="No notifications yet."
        action={{ label: "Refresh", onClick: onRefresh }}
      />
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
