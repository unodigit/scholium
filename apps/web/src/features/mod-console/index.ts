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
 * Later console views (flags and appeals) are added to this feature and link
 * from the queue rows or the detail view.
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
  modDetailHref,
  modDetailSignInHref,
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

export {
  DECISIONS_ENDPOINT,
  DECISION_ACTIONS,
  DECISION_ACTION_LABELS,
  DECISION_RECORD_TYPE,
  DecisionDraftError,
  EMPTY_DECISION_DRAFT,
  ModerationPaperError,
  PAPER_SIGNED_OUT_FAILURE,
  PUBLIC_RECORD_NOTICE,
  RECORDS_ENDPOINT,
  SIGN_DECISION_REASON,
  authorPreview,
  buildDecisionBody,
  classifyPaperError,
  describeDecisionError,
  isDecisionAction,
  loadDecisionClauses,
  loadModeratedPaper,
  parseDecisionAccepted,
  parseVersionRecord,
  shortenDid,
  signModerationDecision,
  submitModerationDecision,
  validateDecisionDraft,
  type AuthorPreview,
  type DecisionAccepted,
  type DecisionAction,
  type DecisionBody,
  type DecisionClient,
  type DecisionDraft,
  type DecisionField,
  type DecisionSigner,
  type DecisionSubmitter,
  type DecisionValidation,
  type ModeratedPaper,
  type PaperAuthor,
  type PaperClient,
  type PaperFailure,
} from "./decision";

export {
  DecisionForm,
  stateLabel,
  type DecisionFormProps,
} from "./decision-form";

export {
  ModDetail,
  PaperPane,
  type LoadClauses,
  type LoadPaper,
  type ModDetailProps,
} from "./mod-detail";
