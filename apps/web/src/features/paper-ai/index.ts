/**
 * `paper-ai` — the AI pre-review tab of the paper page (docs/design.md §5.2).
 *
 * The feature owns this module and the route group `app/(paper-ai)/`. The
 * paper page mounts the tab in its margin panel:
 *
 * ```tsx
 * import { AiTab } from "@/features/paper-ai";
 *
 * <AiTab paperId="sch:k3f9-q2xz-7mwd/v2" />
 * ```
 *
 * The tab shows the purple advisory panel — the fixed banner, findings
 * grouped by agent with their evidence, and the Rebut / Confirm / Wrong
 * buttons — from `GET /v1/papers/{id}/ai-reviews`, and posts answers to
 * `POST /v1/ai-reviews/{cid}/rebuttal` and `.../assessments`.
 * `/ai/{id}[/v{n}]` shows it on a page of its own.
 */

export { AiTab, paperHref, type AiTabProps } from "./ai-tab";

export {
  ADVISORY_BANNER,
  AGENT_ORDER,
  CONFIDENCES,
  SEVERITIES,
  agentTitle,
  confidenceLabel,
  evidenceAnchor,
  evidenceLabel,
  findingCount,
  findingCountLabel,
  parseAiReport,
  severityLabel,
  sortAgentGroups,
  verdictLabel,
  type AiAgentGroup,
  type AiAssessment,
  type AiEvidence,
  type AiEvidenceKind,
  type AiFinding,
  type AiModel,
  type AiRebuttal,
  type AiReport,
  type AiVerdict,
} from "./ai-report";

export {
  NO_AI_REVIEW_YET,
  SIGNED_OUT_TO_ANSWER,
  aiReviewsPath,
  classifyAiActionError,
  classifyAiReportError,
  loadAiReport,
  postAssessment,
  postRebuttal,
  type AiActionFailure,
  type AiActionTarget,
  type AiClient,
  type AiReportFailure,
  type LoadAiReport,
  type LoadAiReportOptions,
  type SendAssessment,
  type SendRebuttal,
} from "./ai-api";
