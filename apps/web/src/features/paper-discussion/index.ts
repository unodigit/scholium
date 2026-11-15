/**
 * `paper-discussion` — the Discussion tab of the paper page
 * (docs/design.md §5.2, §11).
 *
 * The module owns this feature directory and the route group
 * `app/(paper-discussion)/`. A paper page mounts the tab in its margin panel;
 * `/discussion/{id}[/v{n}]` shows it on a page of its own for reading,
 * sharing and testing.
 *
 * ```tsx
 * import { DiscussionTab } from "@/features/paper-discussion";
 *
 * <DiscussionTab paperId="sch:6sel-2dio-orm6" versionCid={version.cid} />
 * ```
 *
 * Threads are shown most helpful first. Every post has a reply form and a
 * Report action. The server route may fetch the threads first (`loadThreads`)
 * and pass them as `initial`, so the first HTML already has the discussion; a
 * failed fetch is passed as `initialError` and the tab offers a retry. The
 * component loads its own data when neither is given.
 */

export { DiscussionTab, type DiscussionActions, type DiscussionTabProps } from "./discussion-tab";

export {
  DISCUSSION_RECORD_TYPE,
  DiscussionResponseError,
  FLAGS_ENDPOINT,
  POST_TEXT_MAX,
  PostInputError,
  REPORT_REASONS,
  WrongPostRecordError,
  addPost,
  authorLabel,
  comparePosts,
  countPosts,
  describeActionError,
  describeLoadError,
  describeWait,
  discussionPath,
  findPost,
  formatDate,
  formatDateTime,
  helpfulEndpoint,
  helpfulLabel,
  loadThreads,
  markPostHelpful,
  orderThreads,
  paperPagePath,
  parseThreads,
  postBody,
  postCountLabel,
  postTextProblem,
  reportPostFlag,
  reportReason,
  shortDid,
  signInPath,
  submitPost,
  threadsEndpoint,
  withHelpful,
  type ActionFailure,
  type DiscussionAction,
  type DiscussionClient,
  type DiscussionData,
  type DiscussionPost,
  type LoadThreads,
  type MarkHelpful,
  type PostAccepted,
  type ReportPost,
  type ReportReason,
  type ReportReceipt,
  type SignPostRecord,
  type SubmitPostOptions,
  type SubmitPostRecord,
} from "./discussion";

export {
  MarginMarkers,
  Annotations,
  AnnotationMarkers,
  MarginAnnotations,
  AnnotatedText,
  AnnotatedParagraphs,
  AnnotatedPaper,
  ParagraphAnnotations,
  AnnotationList,
  AnnotationPopover,
  type MarginMarkersProps,
  type AnnotationsProps,
  type AnnotatedTextProps,
  type AnnotatedParagraphsProps,
  type AnnotatedPaperProps,
  type ParagraphAnnotationsProps,
  type AnnotationMarkersProps,
  type MarginAnnotationsProps,
} from "./annotations";

export {
  parseAnnotations,
  loadAnnotations,
  loadPaperAnnotations,
  fetchAnnotations,
  createAnnotation,
  submitAnnotation,
  addAnnotation,
  annotateParagraph,
  annotationsEndpoint,
  annotationsPath,
  paperAnnotationsEndpoint,
  getAnnotationsEndpoint,
  annotationsUrl,
  type Annotation,
  type AnnotationParagraph,
  type AnnotationsData,
  type CreateAnnotationOptions,
  type LoadAnnotations,
  type AnnotationsClient,
} from "./annotations";
