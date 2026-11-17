"use client";

/**
 * The margin panel (docs/design.md §5.2): a 360 px column beside the paper
 * with the tabs Reviews, AI, Discussion, Versions, Files and Proof.
 *
 * ```text
 * ✓ Verified                     Details ›
 * sch:k3f9-q2xz-7mwd/v2 ⧉
 * ◔ Anchor pending
 * ────────────────────────────────────────
 * Reviews (3)   AI   Discussion (8)
 * Versions      Files      Proof
 * ────────────────────────────────────────
 * …the open tab…
 * ```
 *
 * **The badge is the Proof tab's verdict.** The Proof tab runs verify-core in
 * the reader's browser and reports its state through `onStateChange`; the
 * badge above the tabs shows that state and "always opens the Proof tab"
 * (design §7). So the Proof tab is mounted from the start, even while another
 * tab is showing: otherwise the badge could not say anything until the reader
 * had opened Proof. It starts as "Checking…" and never claims a verdict the
 * browser has not reached.
 *
 * **Tabs follow the WAI-ARIA tabs pattern**: one `tablist`, the open tab is
 * the only one in the tab order, the arrow keys, Home and End move between
 * them, and every tab owns a `tabpanel`. A tab is also an address — `#reviews`
 * … `#proof` — so a link can open one, the badge's `#proof` works, and the
 * browser's back and forward buttons keep working.
 *
 * **Tabs cost nothing until they are opened.** Reviews (the default) and Proof
 * are mounted at once; the others mount the first time they are opened and then
 * stay, so a half-written reply survives a trip to another tab and the Proof
 * check never runs twice. Reviews, Discussion, Versions and Files are handed
 * the data the server already read, so they open with content; AI reads its
 * report in the browser.
 *
 * The tab strip needs JavaScript. Without it the page still shows the paper,
 * the byline, the actions and the Reviews tab as the server rendered it.
 */

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { AiTab } from "../paper-ai";
import { DiscussionTab, countPosts } from "../paper-discussion";
import { FilesTab, VersionsTab, anchorSpec } from "../paper-meta";
import type {
  ManifestData,
  VersionsData,
} from "../paper-meta/meta";
import type { DiscussionData } from "../paper-discussion/discussion";
import { ProofTab } from "../paper-proof";
import { ReviewsTab } from "../paper-reviews";
import type { ReviewsData } from "../paper-reviews/review";
import {
  Icon,
  IdPill,
  VerifyBadge,
  type VerifyCounts,
  type VerifyState,
} from "../ui-kit";
import {
  MARGIN_TAB_IDS,
  comparePagePath,
  tabFromHash,
  tabHash,
  type MarginTabId,
} from "./paper-links";
import type { Part } from "./paper-page-data";

export interface MarginPanelProps {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`. */
  readonly shortId: string;
  /** The version on screen. */
  readonly version: number;
  /** `sch:xxxx-xxxx-xxxx/vN`: the id the Proof, Reviews and AI tabs are given. */
  readonly versionId: string;
  /** Id of the version's record: a new discussion thread attaches to it. */
  readonly versionCid: string;
  readonly reviews: Part<ReviewsData>;
  readonly discussion: Part<DiscussionData>;
  readonly versions: Part<VersionsData>;
  readonly manifest: Part<ManifestData>;
}

/** The words on each tab. A count is added when there is something to count. */
const TAB_LABELS: Readonly<Record<MarginTabId, string>> = {
  reviews: "Reviews",
  ai: "AI",
  discussion: "Discussion",
  versions: "Versions",
  files: "Files",
  proof: "Proof",
};

/** Tabs that are mounted at once; the rest mount when first opened. */
const MOUNTED_AT_START: readonly MarginTabId[] = ["reviews", "proof"];

const tabDomId = (tab: MarginTabId): string => `ppg-tab-${tab}`;
const panelDomId = (tab: MarginTabId): string => `ppg-panel-${tab}`;

/** What a tab is handed when the server already read its data. */
function seed<T>(
  part: Part<T>,
): { initial: T; initialError?: undefined } | { initial?: undefined; initialError: string } {
  return part.ok ? { initial: part.data } : { initialError: part.error };
}

export function MarginPanel({
  shortId,
  version,
  versionId,
  versionCid,
  reviews,
  discussion,
  versions,
  manifest,
}: MarginPanelProps) {
  const [active, setActive] = useState<MarginTabId>("reviews");
  const [opened, setOpened] = useState<ReadonlySet<MarginTabId>>(
    () => new Set(MOUNTED_AT_START),
  );
  const [proofState, setProofState] = useState<VerifyState>("checking");
  // What the finished check verified, for the badge's counted words; the
  // anchor state stays on its own line beneath it.
  const [proofCounts, setProofCounts] = useState<VerifyCounts | null>(null);

  const open = useCallback((tab: MarginTabId) => {
    setActive(tab);
    setOpened((previous) =>
      previous.has(tab) ? previous : new Set(previous).add(tab),
    );
  }, []);

  /** Open a tab because the reader asked for it here: update the address too. */
  const select = useCallback(
    (tab: MarginTabId, options: { focus?: boolean } = {}) => {
      open(tab);
      if (window.location.hash !== tabHash(tab)) {
        // A tab is a view of the same page, not a new page: replace, so the
        // back button leaves the paper instead of stepping through tabs.
        window.history.replaceState(null, "", tabHash(tab));
      }
      if (options.focus === true) {
        document.getElementById(tabDomId(tab))?.focus();
      }
    },
    [open],
  );

  // The address names a tab: on arrival (`/p/…#proof`) and whenever a link to
  // one is followed. The server cannot see the fragment, so this is the first
  // moment the right tab can open.
  useEffect(() => {
    const follow = () => {
      const tab = tabFromHash(window.location.hash);
      if (tab !== null) {
        open(tab);
      }
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [open]);

  const openProof = (event: MouseEvent<HTMLElement>) => {
    // Take the click over with a tab switch; without JavaScript the link is
    // still `#proof`.
    event.preventDefault();
    select("proof", { focus: true });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = MARGIN_TAB_IDS.length - 1;
    const at = MARGIN_TAB_IDS.indexOf(active);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = at === last ? 0 : at + 1;
        break;
      case "ArrowLeft":
        next = at === 0 ? last : at - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(MARGIN_TAB_IDS[next], { focus: true });
  };

  const counts: Partial<Record<MarginTabId, number>> = {};
  if (reviews.ok) {
    counts.reviews = reviews.data.count;
  }
  if (discussion.ok) {
    counts.discussion = countPosts(discussion.data.threads);
  }

  const anchor = versions.ok
    ? versions.data.versions.find((entry) => entry.n === version)
    : undefined;
  const anchorLine = anchor === undefined ? null : anchorSpec(anchor.anchor);

  return (
    <div className="ppg-panel">
      <div className="ppg-proofbar">
        <div className="ppg-proofbar-row">
          <VerifyBadge
            state={proofState}
            counts={proofCounts}
            href={tabHash("proof")}
            onClick={openProof}
          />
          <a className="ppg-details" href={tabHash("proof")} onClick={openProof}>
            Details<span aria-hidden="true"> ›</span>
            <span className="ppg-visually-hidden"> of the proof</span>
          </a>
        </div>
        <IdPill schId={versionId} />
        {anchorLine !== null ? (
          <p className="ppg-anchor" data-tone={anchorLine.tone}>
            <Icon name={anchorLine.icon} className="ppg-anchor-icon" />
            <span>{anchorLine.label}</span>
          </p>
        ) : null}
      </div>

      <div
        className="ppg-tabs"
        role="tablist"
        aria-label="Margin of the paper"
        onKeyDown={onTabKeyDown}
      >
        {MARGIN_TAB_IDS.map((tab) => {
          const count = counts[tab];
          const selected = tab === active;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={tabDomId(tab)}
              className="ppg-tab"
              aria-selected={selected}
              aria-controls={panelDomId(tab)}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab)}
            >
              {TAB_LABELS[tab]}
              {count !== undefined && count > 0 ? (
                <span className="ppg-tab-count"> ({count})</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {MARGIN_TAB_IDS.map((tab) => (
        <div
          key={tab}
          role="tabpanel"
          id={panelDomId(tab)}
          className="ppg-tabpanel"
          aria-labelledby={tabDomId(tab)}
          hidden={tab !== active}
        >
          {opened.has(tab) ? (
            <>
              {tab === "reviews" ? (
                <ReviewsTab paperId={versionId} {...seed(reviews)} />
              ) : null}
              {tab === "ai" ? <AiTab paperId={versionId} /> : null}
              {tab === "discussion" ? (
                <DiscussionTab
                  paperId={shortId}
                  versionCid={versionCid}
                  {...seed(discussion)}
                />
              ) : null}
              {tab === "versions" ? (
                <VersionsTab
                  paperId={shortId}
                  currentVersion={version}
                  compareHref={(from, to) => comparePagePath(shortId, from, to)}
                  {...seed(versions)}
                />
              ) : null}
              {tab === "files" ? (
                <FilesTab paperId={shortId} version={version} {...seed(manifest)} />
              ) : null}
              {tab === "proof" ? (
                <ProofTab
                  schId={versionId}
                  onStateChange={(state, outcome) => {
                    setProofState(state);
                    setProofCounts(outcome?.counts ?? null);
                  }}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
