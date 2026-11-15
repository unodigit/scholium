/**
 * `network-page` — the public node transparency page (`/network`).
 *
 * The feature owns the route group `app/(network-page)/` and this module.
 * The page is server-rendered from `GET /v1/network`; the client fallback
 * exists only so a failed server fetch can retry in the browser.
 *
 * ```tsx
 * import { NETWORK_PATH, NetworkPage } from "@/features/network-page";
 *
 * <a href={NETWORK_PATH}>Network</a>
 * ```
 */

export {
  ANCHOR_SPECS,
  ANCHOR_STATUS_PENDING,
  LOCAL_STANDING,
  NETWORK_ENDPOINT,
  NETWORK_PATH,
  NETWORK_TITLE,
  NetworkStatusError,
  STANDING_SPECS,
  anchorSpec,
  describeNetworkError,
  loadNetworkStatus,
  moderationCountLine,
  parseNetworkStatus,
  replicaSegments,
  standingSpec,
  type AnchorSpec,
  type LastAnchorStatus,
  type LogHeadStatus,
  type ModerationStatistics,
  type NetworkClient,
  type NetworkStatus,
  type ReplicaSummary,
  type StandingSpec,
  type StatusTone,
} from "./network";

export {
  NetworkPage,
  type LoadNetworkStatus,
  type NetworkPageProps,
} from "./network-page";
