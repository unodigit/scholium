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
  EXPORT_ARCHIVE_PATH,
  EXPORT_REBUILD_COMMAND,
  EXPORT_VERIFY_COMMAND,
  LOCAL_STANDING,
  NETWORK_ENDPOINT,
  NETWORK_PATH,
  NETWORK_TITLE,
  NetworkStatusError,
  REPLICA_HEALTHS,
  STANDING_SPECS,
  anchorSpec,
  archiveExportHref,
  describeNetworkError,
  incidentDate,
  listedPapersLine,
  loadNetworkStatus,
  moderationCountLine,
  parseNetworkStatus,
  policyTargetSentence,
  probeSummary,
  replicaHealthSegments,
  replicaHealthSpec,
  replicaSegments,
  standingSpec,
  type AnchorSpec,
  type HealthSegment,
  type IncidentEntry,
  type LastAnchorStatus,
  type LogHeadStatus,
  type ModerationStatistics,
  type NetworkClient,
  type NetworkStatus,
  type ProbeStatistics,
  type ProbeSummary,
  type ReplicaHealth,
  type ReplicaHealthCounts,
  type ReplicaHealthSpec,
  type ReplicaSummary,
  type ReplicationPolicy,
  type StandingSpec,
  type StatusTone,
} from "./network";

export {
  NetworkPage,
  type LoadNetworkStatus,
  type NetworkPageProps,
} from "./network-page";
