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
 * Flags and appeals sit beneath the queue on the same page (`ModCases`): the
 * appeals are read from the public log, each open one carries the panel vote
 * form, and the API alone decides who holds a seat.
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
  RecordPane,
  type LoadClauses,
  type LoadPaper,
  type ModDetailProps,
} from "./mod-detail";

export {
  DISCUSSION_POST_TYPE,
  EXCERPT_LIMIT,
  PAPER_GENESIS_TYPE,
  PAPER_VERSION_TYPE,
  REVIEW_COMMIT_TYPE,
  REVIEW_FORMAL_TYPE,
  REVIEW_RATING_TYPE,
  REVIEW_RESPONSE_TYPE,
  RecordReadError,
  excerptOf,
  isAnnotation,
  loadFlagTargetSummary,
  loadModerationItem,
  parseRecord,
  recordHeading,
  recordKindLabel,
  recordNoun,
  recordPaperHref,
  resolveOwningPaper,
  summarizePaper,
  summarizeRecord,
  type FlagTargetSummary,
  type LoadFlagTarget,
  type LoadItem,
  type ModerationItem,
  type ModeratedRecord,
  type RecordClient,
} from "./record";

export {
  RecordDecisionForm,
  recordActionLabel,
  recordOutcome,
  type RecordDecisionAction,
  type RecordDecisionFormProps,
} from "./record-decision-form";

export {
  RecordFlags,
  type RecordFlagsProps,
} from "./record-flags";

export {
  PersonName,
  loadPersonName,
  type LoadPersonName,
  type PersonNameProps,
} from "./person";

export {
  LOG_PAGE_SIZE,
  LOG_RECORD_TYPES,
  MAX_LOG_PAGES,
  SYNC_RANGE_ENDPOINT,
  AppealsLoadError,
  actionLabel,
  buildAppealCases,
  describeAppealsError,
  enrichAppealCases,
  isAppealOpen,
  loadAppealCases,
  loadAppealsForViewer,
  outcomeLabel,
  readLogEntry,
  type AppealCase,
  type AppealPaper,
  type AppealSubject,
  type AppealVerdict,
  type AppealedDecision,
  type AppealsClient,
  type AppealsLoad,
  type LogEntry,
  type PanelVoteRecord,
} from "./appeals";

export {
  DECIDING_VOTES,
  EMPTY_VOTE_DRAFT,
  PANEL_RECORD_NOTICE,
  PANEL_SIZE,
  VOTE_CHOICES,
  VoteDraftError,
  buildVoteBody,
  castPanelVote,
  decideAppealWithoutPanel,
  decideWithoutPanelEndpoint,
  describeVoteError,
  isVoteOutcome,
  parseVoteAccepted,
  validateVoteDraft,
  voteEndpoint,
  type FallbackDecider,
  type VoteAccepted,
  type VoteBody,
  type VoteCaster,
  type VoteClient,
  type VoteDraft,
  type VoteField,
  type VoteFailure,
  type VoteOutcome,
  type VoteValidation,
} from "./panel-vote";

export {
  FLAGS_ENDPOINT,
  FlagReadError,
  classifyFlagsError,
  flagDecisionHref,
  flagSignal,
  formatFlagReason,
  isFlagOpen,
  loadFlag,
  loadFlags,
  loadFlagsForTarget,
  parseFlag,
  parseFlags,
  type FlagEntry,
  type FlagsClient,
  type FlagsFailure,
  type LoadTargetFlags,
} from "./flags";

export {
  AppealVoteForm,
  type AppealVoteFormProps,
} from "./appeal-vote-form";

export { AppealCard, appealSignal, type AppealCardProps } from "./appeal-card";

export {
  AppealsSection,
  type AppealsSectionProps,
  type LoadAppeals,
} from "./appeals-section";

export {
  FlagCard,
  FlagsSection,
  type FlagsSectionProps,
  type LoadFlag,
  type LoadFlags,
} from "./flags-section";

export { ModCases, type ModCasesProps } from "./mod-cases";
