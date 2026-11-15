/**
 * `mod-console` — the moderation console (`/mod`, tier 4).
 *
 * The feature owns the route group `app/(mod-console)/` and this module. The
 * queue of versions waiting for a decision is read from
 * `GET /v1/moderation/queue` in the browser (it needs the signed-in account's
 * bearer token), and the API alone decides who may see it:
 *
 * ```tsx
 * import { ModConsole } from "@/features/mod-console";
 *
 * <ModConsole />
 * ```
 *
 * Later console views (the decision detail, flags and appeals) are added to
 * this feature and link from the queue rows.
 */

export {
  MODERATOR_TIER,
  MOD_PATH,
  MOD_TITLE,
  QUEUE_ENDPOINT,
  QueueListError,
  SIGNED_OUT_FAILURE,
  SIGNIN_HREF,
  accountSignal,
  classifyQueueError,
  formatAge,
  formatCategories,
  formatSimilarity,
  loadQueue,
  parseQueue,
  parseScanResult,
  referencesSignal,
  scanSignal,
  similaritySignal,
  type QueueClient,
  type QueueEntry,
  type QueueFailure,
  type ScanResult,
  type Signal,
} from "./queue";

export { QueueTable, type QueueTableProps } from "./queue-table";

export {
  ModConsole,
  type LoadQueue,
  type ModConsoleProps,
} from "./mod-console";
