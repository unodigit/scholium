/**
 * `paper-meta` — the Versions and Files tabs of the paper page
 * (docs/design.md §5.2).
 *
 * The module owns this feature directory and the route group
 * `app/(paper-meta)/`. A paper page mounts the two tabs in its margin panel;
 * `/meta/{id}[/v{n}]` shows both on a page of their own for reading, sharing
 * and testing.
 *
 * ```tsx
 * import { FilesTab, VersionsTab } from "@/features/paper-meta";
 *
 * <VersionsTab
 *   paperId="sch:6sel-2dio-orm6"
 *   currentVersion={2}
 *   compareHref={(from, to) => `/p/6sel-2dio-orm6/compare/${from}..${to}`}
 * />
 * <FilesTab paperId="sch:6sel-2dio-orm6" version={2} />
 * ```
 *
 * The server route may fetch each tab's data first (`loadVersions`,
 * `loadManifest`) and pass it as `initial`, so the first HTML already has the
 * timeline and the file list; a failed fetch is passed as `initialError` and
 * the tab offers a retry. The components load their own data when neither is
 * given.
 */

export {
  FilesTab,
  fileName,
  unavailableReason,
  type FilesTabProps,
} from "./files-tab";

export {
  VersionsTab,
  type VersionsTabProps,
} from "./versions-tab";

export {
  MetaRefError,
  MetaResponseError,
  SCAN_STATUSES,
  SCAN_STATUS_SPECS,
  anchorSpec,
  changeNoteText,
  contentUrl,
  currentVersionOf,
  describeMetaError,
  formatBytes,
  formatDate,
  formatDateTime,
  isDownloadable,
  licenceLabel,
  loadManifest,
  loadVersions,
  manifestEndpoint,
  metaRefFromSegments,
  normalizeScanStatus,
  paperPath,
  parseManifest,
  parseMetaRef,
  parseVersionAnchor,
  parseVersions,
  roleLabel,
  versionPath,
  versionsEndpoint,
  type AnchorSpec,
  type LoadManifest,
  type LoadVersions,
  type ManifestData,
  type ManifestFile,
  type MetaClient,
  type MetaRef,
  type ScanStatus,
  type ScanStatusSpec,
  type VersionAnchor,
  type VersionEntry,
  type VersionsData,
} from "./meta";
