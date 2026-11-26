"use client";

/**
 * Margin markers and paragraph annotations (feature 150).
 *
 * A paragraph annotation is a signed `discussion.post` whose anchor names a
 * version cid, a `paragraph_id`, a `quote` and an `offset`
 * (`POST /v1/annotations`, feature 103).  This module renders the reading
 * column's paragraphs with a margin marker beside every paragraph that has at
 * least one annotation, and lets a reader select a paragraph and press `A` to
 * compose an annotation that is signed on this device and persists after
 * reload (it is re-read from `GET /v1/papers/{id}/v/{n}/annotations`).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { ApiError, NetworkError, api, type ApiClient, type ApiRequestOptions } from "../../lib/api";
import { signRecord, type SignedRecord } from "../web-auth/sign-record";
import { isPasskeyCancellation, isRecordSigningError, isDeviceKeyError } from "../web-auth/errors";
import { discussionPath, hiddenOwnNotice } from "./discussion";
import "./paper-discussion.css";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export interface AnnotationParagraph {
  readonly id: string;
  readonly text: string;
}

export interface Annotation {
  readonly id: string;
  readonly cid?: string;
  readonly recordId?: string;
  readonly record_id?: string;
  readonly author?: string;
  readonly created?: string | null;
  readonly createdAt?: string | null;
  readonly created_at?: string | null;
  readonly type?: string;
  readonly target?: string | null;
  readonly paragraphId?: string;
  readonly paragraph_id?: string;
  readonly quote?: string | null;
  readonly offset?: unknown;
  readonly text?: string | null;
  readonly textCid?: string | null;
  readonly text_cid?: string | null;
  readonly parent?: string | null;
  /** A moderator hid it: the body is withheld and a placeholder takes its place. */
  readonly hidden?: boolean;
  /** The moderator's reason for hiding it, when the node serves one. */
  readonly hidden_reason?: string | null;
  readonly hiddenReason?: string | null;
  /**
   * The node says this hidden annotation belongs to the signed-in viewer. It
   * serves the flag, and `own_text`, only to the annotation's author: the
   * margin decides nothing from the author alone.
   */
  readonly is_own?: boolean;
  readonly isOwn?: boolean;
  /** The author's own hidden body, served only to them. */
  readonly own_text?: string | null;
  readonly ownText?: string | null;
  [key: string]: unknown;
}

export interface AnnotationGroup {
  readonly paragraphId: string;
  readonly annotations: readonly Annotation[];
}

export interface AnnotationsData {
  readonly paper?: string;
  readonly version?: number;
  readonly versionCid?: string;
  readonly version_cid?: string;
  readonly count?: number;
  readonly annotations: Readonly<Record<string, readonly Annotation[]>>;
  readonly groups?: Readonly<Record<string, readonly Annotation[]>>;
  readonly byParagraph?: Readonly<Record<string, readonly Annotation[]>>;
  readonly items?: readonly Annotation[];
}

/* -------------------------------------------------------------------------- */
/* Normalisation helpers                                                       */
/* -------------------------------------------------------------------------- */

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function normalizeParagraph(raw: unknown, index: number): AnnotationParagraph {
  if (typeof raw === "string") {
    return { id: `paragraph-${index + 1}`, text: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const id =
      readText(record.id) ??
      readText(record.paragraphId) ??
      readText(record.paragraph_id) ??
      readText(record.pid) ??
      `paragraph-${index + 1}`;
    const text =
      readText(record.text) ??
      readText(record.content) ??
      readText(record.body) ??
      readText(record.paragraph) ??
      "";
    return { id, text };
  }
  return { id: `paragraph-${index + 1}`, text: String(raw ?? "") };
}

function normalizeAnnotation(raw: unknown): Annotation {
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const id =
      readText(record.id) ??
      readText(record.cid) ??
      readText(record.recordId) ??
      readText(record.record_id) ??
      readText(record.post_cid) ??
      readText(record.postCid) ??
      "";
    const paragraphId =
      readText(record.paragraphId) ??
      readText(record.paragraph_id) ??
      readText(record.paragraph) ??
      null;
    const annotation: Annotation = {
      id,
      cid: id || undefined,
      recordId: id || undefined,
      record_id: id || undefined,
      author: readText(record.author) ?? readText(record.author_did) ?? undefined,
      created: readText(record.created) ?? readText(record.createdAt) ?? readText(record.created_at) ?? null,
      createdAt: readText(record.created) ?? readText(record.createdAt) ?? readText(record.created_at) ?? null,
      created_at: readText(record.created) ?? readText(record.createdAt) ?? readText(record.created_at) ?? null,
      type: readText(record.type) ?? "discussion.post",
      target: readText(record.target) ?? null,
      paragraphId: paragraphId ?? undefined,
      paragraph_id: paragraphId ?? undefined,
      quote: readText(record.quote) ?? null,
      offset: record.offset ?? null,
      text: readText(record.text) ?? null,
      textCid: readText(record.textCid) ?? readText(record.text_cid) ?? null,
      text_cid: readText(record.textCid) ?? readText(record.text_cid) ?? null,
      parent: readText(record.parent) ?? readText(record.parent_cid) ?? readText(record.parentCid) ?? null,
      // A hidden annotation's placeholder, and the author's own copy under it,
      // may arrive in either spelling.
      hidden: record.hidden === true,
      hidden_reason: readText(record.hidden_reason) ?? readText(record.hiddenReason),
      hiddenReason: readText(record.hidden_reason) ?? readText(record.hiddenReason),
      is_own: record.is_own === true || record.isOwn === true,
      isOwn: record.is_own === true || record.isOwn === true,
      own_text: readText(record.own_text) ?? readText(record.ownText),
      ownText: readText(record.own_text) ?? readText(record.ownText),
      ...record,
    };
    return annotation;
  }
  return { id: String(raw ?? ""), annotations: [] } as unknown as Annotation;
}

function normalizeGroups(payload: unknown): Record<string, Annotation[]> {
  const groups: Record<string, Annotation[]> = {};
  if (payload === null || payload === undefined) return groups;

  // Unwrap common wrappers.
  let node: unknown = payload;
  if (typeof node === "object" && !Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    if (record.annotations !== undefined && (typeof record.annotations === "object")) {
      node = record.annotations;
    } else if (record.groups !== undefined && typeof record.groups === "object") {
      node = record.groups;
    } else if (record.byParagraph !== undefined && typeof record.byParagraph === "object") {
      node = record.byParagraph;
    } else if (record.by_paragraph !== undefined && typeof record.by_paragraph === "object") {
      node = record.by_paragraph;
    }
  }

  if (Array.isArray(node)) {
    // Could be a list of group objects tagged with paragraph id, or a flat
    // list of annotations each carrying paragraph_id.
    for (const item of node) {
      if (item !== null && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const tagged =
          readText(record.paragraph_id) ?? readText(record.paragraphId) ?? readText(record.paragraph);
        const lists = Object.values(record).filter((value) => Array.isArray(value)) as unknown[][];
        if (tagged !== null && lists.length > 0) {
          groups[tagged] = (groups[tagged] ?? []).concat(
            (lists[0] as unknown[]).map(normalizeAnnotation),
          );
          continue;
        }
        // Flat list of annotations: group by their paragraph id.
        const pid =
          readText(record.paragraph_id) ?? readText(record.paragraphId) ?? readText(record.paragraph);
        if (pid !== null) {
          groups[pid] = (groups[pid] ?? []).concat(normalizeAnnotation(record));
        }
      }
    }
    return groups;
  }

  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        groups[key] = value.map(normalizeAnnotation);
      } else if (value !== null && typeof value === "object") {
        // Nested wrapper: { paragraph_id: P, annotations: [...] }
        const inner = value as Record<string, unknown>;
        const tagged =
          readText(inner.paragraph_id) ?? readText(inner.paragraphId) ?? readText(inner.paragraph) ?? key;
        const lists = Object.values(inner).filter((value) => Array.isArray(value)) as unknown[][];
        if (lists.length > 0) {
          groups[tagged] = (groups[tagged] ?? []).concat(
            (lists[0] as unknown[]).map(normalizeAnnotation),
          );
        } else {
          groups[key] = [normalizeAnnotation(inner)];
        }
      }
    }
  }
  return groups;
}

export function parseAnnotations(payload: unknown): AnnotationsData {
  const record = (payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const groups = normalizeGroups(payload);
  const flat: Annotation[] = [];
  for (const list of Object.values(groups)) flat.push(...list);

  const paper = readText(record.paper) ?? readText(record.shortId) ?? readText(record.short_id) ?? undefined;
  const version =
    typeof record.version === "number"
      ? record.version
      : (readText(record.version) !== null ? Number(record.version) : undefined);
  const versionCid =
    readText(record.versionCid) ?? readText(record.version_cid) ?? readText(record.versionCid) ?? undefined;

  return {
    paper,
    version: Number.isFinite(version as number) ? (version as number) : undefined,
    versionCid,
    version_cid: versionCid,
    count: typeof record.count === "number" ? record.count : flat.length,
    annotations: groups,
    groups,
    byParagraph: groups,
    items: flat,
  };
}

/* -------------------------------------------------------------------------- */
/* Endpoints / loaders                                                         */
/* -------------------------------------------------------------------------- */

export type AnnotationsClient = Pick<ApiClient, "get" | "post">;

export function annotationsEndpoint(paperId: string, version?: number | string): string {
  const id = (paperId ?? "").trim();
  if (version === undefined || version === null || version === "") {
    return `/papers/${encodeURIComponent(id)}/annotations`;
  }
  return `/papers/${encodeURIComponent(id)}/v/${encodeURIComponent(String(version))}/annotations`;
}

export const annotationsPath = annotationsEndpoint;
export const paperAnnotationsEndpoint = annotationsEndpoint;
export const getAnnotationsEndpoint = annotationsEndpoint;
export const annotationsUrl = annotationsEndpoint;

export type LoadAnnotations = (
  paperId: string,
  version?: number | string,
  options?: ApiRequestOptions | AnnotationsClient,
) => Promise<AnnotationsData>;

export async function loadAnnotations(
  paperIdOrOptions: string | { paperId?: string; paper?: string; id?: string; version?: number | string; n?: number | string; versionNumber?: number | string; client?: AnnotationsClient },
  version?: number | string,
  clientOrOptions?: AnnotationsClient | ApiRequestOptions,
  client: AnnotationsClient = api,
): Promise<AnnotationsData> {
  let resolvedPaperId = "";
  let resolvedVersion = version;
  let resolvedClient = client;
  let options: ApiRequestOptions | undefined;

  if (typeof paperIdOrOptions === "string") {
    resolvedPaperId = paperIdOrOptions;
  } else if (paperIdOrOptions && typeof paperIdOrOptions === "object") {
    const opts = paperIdOrOptions as Record<string, unknown>;
    resolvedPaperId = String(opts.paperId ?? opts.paper ?? opts.id ?? "").trim();
    resolvedVersion = (opts.version ?? opts.n ?? opts.versionNumber ?? version) as number | string | undefined;
    if (opts.client && typeof (opts.client as AnnotationsClient).get === "function") {
      resolvedClient = opts.client as AnnotationsClient;
    }
  }

  if (clientOrOptions && typeof (clientOrOptions as AnnotationsClient).get === "function") {
    resolvedClient = clientOrOptions as AnnotationsClient;
  } else if (clientOrOptions && typeof clientOrOptions === "object") {
    options = clientOrOptions as ApiRequestOptions;
  }

  const payload = await resolvedClient.get<unknown>(annotationsEndpoint(resolvedPaperId, resolvedVersion), {
    cache: "no-store",
    ...options,
  });
  return parseAnnotations(payload);
}

export const loadPaperAnnotations = loadAnnotations;
export const fetchAnnotations = loadAnnotations;

/* -------------------------------------------------------------------------- */
/* Announcing a saved annotation                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a saved annotation says on `window` (bug_spec_verify24 D2).
 *
 * The reading column and the margin panel share no state. An annotation is a
 * `discussion.post` the Discussion tab lists and counts, so after a successful
 * save the reading column says so here and a tab for the same paper re-reads
 * its threads: the list and the count move without a page reload. Listeners
 * ignore an event for another paper.
 */
export const ANNOTATION_CREATED_EVENT = "scholium:annotation-created";

/** The detail of {@link ANNOTATION_CREATED_EVENT}. */
export interface AnnotationCreatedEventDetail {
  /** Canonical paper id, `sch:xxxx-xxxx-xxxx`: only this paper's tab answers. */
  readonly paperId: string;
  /** The version record the annotation is anchored to. */
  readonly versionCid: string;
  /** The annotation as the node accepted it. */
  readonly annotation: Annotation;
}

/**
 * Tell the page an annotation was just saved. Does nothing on the server.
 *
 * Call it only once the save succeeded: a listener re-reads the paper's
 * threads, so announcing a failure would claim a post that does not exist.
 */
export function announceAnnotationCreated(detail: AnnotationCreatedEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AnnotationCreatedEventDetail>(ANNOTATION_CREATED_EVENT, { detail }),
  );
}

/* -------------------------------------------------------------------------- */
/* Creating an annotation                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateAnnotationOptions {
  paperId?: string;
  paper?: string;
  id?: string;
  version?: number | string;
  versionNumber?: number | string;
  n?: number | string;
  versionCid?: string;
  versionCID?: string;
  versionId?: string;
  target?: string;
  paragraphId?: string;
  paragraph_id?: string;
  paragraph?: string;
  quote?: string | null;
  offset?: unknown;
  text: string;
  sign?: (type: string, body: Record<string, unknown>, prev: string | null) => Promise<SignedRecord>;
  submit?: (record: SignedRecord) => Promise<unknown>;
  client?: AnnotationsClient;
  actions?: {
    sign?: (type: string, body: Record<string, unknown>, prev: string | null) => Promise<SignedRecord>;
    submit?: (record: SignedRecord) => Promise<unknown>;
    create?: (options: CreateAnnotationOptions) => Promise<unknown>;
  };
}

export async function createAnnotation(options: CreateAnnotationOptions): Promise<Annotation> {
  const paperId = (options.paperId ?? options.paper ?? options.id ?? "").trim();
  const versionCid =
    options.versionCid ?? options.versionCID ?? options.versionId ?? options.target ?? "";
  const paragraphId =
    options.paragraphId ?? options.paragraph_id ?? options.paragraph ?? "";
  const quote = options.quote ?? null;
  const offset = options.offset ?? 0;
  const text = options.text;

  const sign = options.sign ?? options.actions?.sign ?? signRecord;
  let submit = options.submit ?? options.actions?.submit;
  if (!submit) {
    const client = options.client ?? api;
    submit = (record: SignedRecord) => client.post<unknown>("/annotations", record);
  }

  const body: Record<string, unknown> = {
    target: versionCid,
    anchor: {
      version: versionCid,
      versionCid: versionCid,
      paragraph_id: paragraphId,
      paragraphId: paragraphId,
      quote,
      offset,
    },
    text: text.trim(),
    parent: null,
  };

  const signed = await sign("discussion.post", body, null);
  const accepted = await submit(signed);
  const acceptedRecord = (accepted !== null && typeof accepted === "object"
    ? (accepted as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const cid =
    readText(acceptedRecord.id) ??
    readText(acceptedRecord.cid) ??
    readText(acceptedRecord.post_cid) ??
    readText(acceptedRecord.postCid) ??
    signed.id;

  return normalizeAnnotation({
    id: cid,
    cid,
    author: signed.author,
    created: signed.created,
    type: signed.type,
    target: versionCid,
    paragraph_id: paragraphId,
    paragraphId: paragraphId,
    quote,
    offset,
    text: text.trim(),
    parent: null,
  });
}

export const submitAnnotation = createAnnotation;
export const addAnnotation = createAnnotation;
export const annotateParagraph = createAnnotation;

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

function normalizeVersion(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
    return value.trim();
  }
  return 1;
}

export interface MarginMarkersProps {
  paperId?: string;
  paper?: string;
  id?: string;
  version?: number | string;
  versionNumber?: number | string;
  versionNo?: number | string;
  n?: number | string;
  versionCid?: string;
  versionCID?: string;
  versionId?: string;
  target?: string;
  paragraphs?: unknown;
  text?: unknown;
  paragraphList?: unknown;
  initialAnnotations?: unknown;
  annotations?: unknown;
  initial?: unknown;
  data?: unknown;
  loadAnnotations?: (...args: any[]) => Promise<unknown>;
  load?: (...args: any[]) => Promise<unknown>;
  loader?: (...args: any[]) => Promise<unknown>;
  loadReport?: (...args: any[]) => Promise<unknown>;
  createAnnotation?: (options: any) => Promise<unknown>;
  create?: (options: any) => Promise<unknown>;
  onCreate?: (options: any) => Promise<unknown>;
  submitAnnotation?: (options: any) => Promise<unknown>;
  submit?: (...args: any[]) => Promise<unknown>;
  sign?: (type: string, body: Record<string, unknown>, prev: string | null) => Promise<SignedRecord>;
  signRecord?: (type: string, body: Record<string, unknown>, prev: string | null) => Promise<SignedRecord>;
  actions?: {
    sign?: (type: string, body: Record<string, unknown>, prev: string | null) => Promise<SignedRecord>;
    submit?: (...args: any[]) => Promise<unknown>;
    create?: (options: any) => Promise<unknown>;
    load?: (...args: any[]) => Promise<unknown>;
  };
  signedIn?: boolean;
  className?: string;
  [key: string]: unknown;
}

// Back-compat aliases for the prop type.
export type AnnotationsProps = MarginMarkersProps;
export type AnnotatedTextProps = MarginMarkersProps;
export type AnnotatedParagraphsProps = MarginMarkersProps;
export type AnnotatedPaperProps = MarginMarkersProps;
export type ParagraphAnnotationsProps = MarginMarkersProps;
export type AnnotationMarkersProps = MarginMarkersProps;
export type MarginAnnotationsProps = MarginMarkersProps;

export function MarginMarkers(props: MarginMarkersProps) {
  const {
    paperId: paperIdProp,
    paper,
    id,
    version: versionProp,
    versionNumber,
    versionNo,
    n,
    versionCid: versionCidProp,
    versionCID,
    versionId,
    target,
    paragraphs: paragraphsProp,
    text,
    paragraphList,
    initialAnnotations,
    annotations: annotationsProp,
    initial,
    data,
    loadAnnotations: loadAnnotationsProp,
    load,
    loader: loaderProp,
    loadReport,
    createAnnotation: createAnnotationProp,
    create,
    onCreate,
    submitAnnotation: submitAnnotationProp,
    submit,
    sign,
    signRecord: signRecordProp,
    actions,
    signedIn,
    className,
  } = props;

  const paperId = (paperIdProp ?? paper ?? id ?? "").toString().trim();
  const version = normalizeVersion(versionProp ?? versionNumber ?? versionNo ?? n);
  const versionCid = (versionCidProp ?? versionCID ?? versionId ?? target ?? "").toString().trim();
  // The standalone discussion page is addressed by version number, not by the
  // version's cid: an annotation's appeal is filed on its version's page.
  const discussionVersion = typeof version === "number" ? version : undefined;

  const paragraphs = useMemo<AnnotationParagraph[]>(() => {
    const source = paragraphsProp ?? paragraphList ?? text ?? data;
    if (Array.isArray(source)) {
      // If it's an array of paragraphs directly.
      if (source.length > 0 && (source[0] as any)?.text !== undefined || typeof source[0] === "string") {
        return source.map((item, index) => normalizeParagraph(item, index));
      }
    }
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const record = source as Record<string, unknown>;
      if (Array.isArray(record.paragraphs)) {
        return (record.paragraphs as unknown[]).map((item, index) => normalizeParagraph(item, index));
      }
      if (Array.isArray(record.items)) {
        return (record.items as unknown[]).map((item, index) => normalizeParagraph(item, index));
      }
    }
    const initialRecord = initial as Record<string, unknown> | null;
    if (initialRecord && Array.isArray(initialRecord.paragraphs)) {
      return (initialRecord.paragraphs as unknown[]).map((item, index) => normalizeParagraph(item, index));
    }
    return [];
  }, [paragraphsProp, paragraphList, text, data, initial]);

  const [selected, setSelected] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  // The author's own hidden annotations whose text they have asked to see.
  const [ownOpenIds, setOwnOpenIds] = useState<Set<string>>(() => new Set());
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const initialGroups = useMemo<Record<string, Annotation[]>>(() => {
    const source =
      annotationsProp ?? initialAnnotations ?? initial ?? data ?? null;
    if (source && typeof source === "object") {
      const record = source as Record<string, unknown>;
      if (record.annotations || record.groups || record.byParagraph || record.by_paragraph) {
        return normalizeGroups(source);
      }
      // Could be a direct record pid -> array.
      const looksLikeGroups = Object.values(source).every((v) => Array.isArray(v));
      if (looksLikeGroups) return normalizeGroups(source);
    }
    return {};
  }, [annotationsProp, initialAnnotations, initial, data]);

  const [groups, setGroups] = useState<Record<string, Annotation[]>>(initialGroups as Record<string, Annotation[]>);

  useEffect(() => {
    setGroups(initialGroups as Record<string, Annotation[]>);
  }, [initialGroups]);

  const loader =
    loadAnnotationsProp ?? load ?? loaderProp ?? loadReport ?? actions?.load ?? null;

  const reload = async () => {
    if (!loader) return;
    try {
      const result = await loader(paperId, version);
      const parsed = (result && typeof result === "object" && (result as any).annotations)
        ? (result as AnnotationsData)
        : parseAnnotations(result);
      setGroups((parsed.annotations ?? {}) as Record<string, Annotation[]>);
    } catch {
      // Keep the current markers on a failed reload.
    }
  };

  useEffect(() => {
    if (!loader) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await loader(paperId, version);
        if (cancelled) return;
        const parsed = (result && typeof result === "object" && (result as any).annotations)
          ? (result as AnnotationsData)
          : parseAnnotations(result);
        setGroups((parsed.annotations ?? {}) as Record<string, Annotation[]>);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paperId, version, loader]);

  const highLevelCreate =
    createAnnotationProp ?? create ?? onCreate ?? submitAnnotationProp ?? actions?.create ?? null;

  const signFn =
    sign ?? signRecordProp ?? actions?.sign ?? signRecord;

  const submitFn = submit ?? actions?.submit ?? null;

  const openComposer = (paragraphId: string) => {
    setSelected(paragraphId);
    setComposerFor(paragraphId);
    setComposerText("");
    setComposerError(null);
  };

  /** Show or hide one author's own hidden annotation text. */
  const toggleOwnText = (rowKey: string) => {
    setOwnOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const closeComposer = () => {
    setComposerFor(null);
    setComposerText("");
    setComposerError(null);
  };

  const handleCreate = async () => {
    const paragraphId = composerFor;
    if (!paragraphId) return;
    const paragraph = paragraphs.find((p) => p.id === paragraphId);
    const quote = paragraph?.text ?? null;
    const text = composerText;
    if (text.trim() === "") {
      setComposerError("Write something before you post.");
      return;
    }
    setSubmitting(true);
    setComposerError(null);
    try {
      let result: unknown;
      if (highLevelCreate) {
        result = await highLevelCreate({
          paperId,
          version,
          versionCid,
          paragraphId,
          paragraph_id: paragraphId,
          quote,
          offset: 0,
          text,
          sign: signFn,
          submit: submitFn,
          actions: { sign: signFn, submit: submitFn, create: highLevelCreate },
        });
      } else {
        result = await createAnnotation({
          paperId,
          versionCid,
          paragraphId,
          quote,
          offset: 0,
          text,
          sign: signFn,
          submit: submitFn ? (record: SignedRecord) => submitFn(record) : undefined,
        });
      }
      // Optimistically add the new annotation.
      const newAnnotation = normalizeAnnotation(
        (result && typeof result === "object" ? result : { id: "", paragraph_id: paragraphId, quote, text }) as unknown,
      );
      if (!newAnnotation.paragraphId && !newAnnotation.paragraph_id) {
        (newAnnotation as { paragraphId?: string; paragraph_id?: string }).paragraphId = paragraphId;
        (newAnnotation as { paragraphId?: string; paragraph_id?: string }).paragraph_id = paragraphId;
      }
      // The annotation is also a `discussion.post` an open Discussion tab
      // lists; that tab shares no state with this column, so it hears the save
      // here and re-reads its threads.
      announceAnnotationCreated({ paperId, versionCid, annotation: newAnnotation });
      setGroups((prev) => {
        const next = { ...prev };
        const list = [...(next[paragraphId] ?? [])];
        list.push(newAnnotation);
        next[paragraphId] = list;
        return next;
      });
      // A newly posted annotation is shown to its author: open that paragraph's
      // thread.
      setOpenIds((prev) => {
        const next = new Set(prev);
        next.add(paragraphId);
        return next;
      });
      closeComposer();
      await reload();
    } catch (error) {
      if (isPasskeyCancellation(error)) {
        setComposerError("Signing was cancelled, so nothing was sent.");
      } else if (isDeviceKeyError(error)) {
        setComposerError("No device key is available to sign with.");
      } else if (isRecordSigningError(error)) {
        setComposerError("The annotation could not be signed.");
      } else if (error instanceof ApiError) {
        setComposerError(error.detail || error.title || "The annotation could not be saved.");
      } else if (error instanceof NetworkError) {
        setComposerError("Couldn’t reach the server. Check your connection and try again.");
      } else if (error instanceof Error && error.message.trim() !== "") {
        setComposerError(error.message);
      } else {
        setComposerError("The annotation could not be saved.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const key = event.key;
    if (key === "a" || key === "A") {
      if (selected && !composerFor) {
        event.preventDefault();
        openComposer(selected);
      }
    }
    if (key === "Escape" && composerFor) {
      closeComposer();
    }
  };

  const containerClassName = ["pd-annotations", className].filter(Boolean).join(" ");

  return (
    <section
      className={containerClassName}
      aria-label="Annotations"
      data-state={composerFor ? "composing" : "ready"}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {paragraphs.length === 0 ? (
        <p className="pd-empty">No annotations yet — select a paragraph and press A to add the first.</p>
      ) : null}

      <div className="pd-reading">
        {paragraphs.map((paragraph) => {
          const paragraphAnnotations = groups[paragraph.id] ?? [];
          // A hidden annotation keeps its place as a placeholder but is not
          // counted as a visible annotation on the paragraph.
          const count = paragraphAnnotations.filter(
            (annotation) => annotation.hidden !== true,
          ).length;
          const isSelected = selected === paragraph.id;
          return (
            <div key={paragraph.id} className="pd-paragraph-row">
              <p
                id={`p-${paragraph.id}`}
                data-paragraph-id={paragraph.id}
                data-selected={isSelected ? "true" : "false"}
                tabIndex={0}
                className={["pd-paragraph", isSelected ? "pd-paragraph--selected" : ""].filter(Boolean).join(" ")}
                onClick={() => setSelected(paragraph.id)}
                onFocus={() => setSelected(paragraph.id)}
                onKeyDown={(event) => {
                  if (event.key === "a" || event.key === "A") {
                    event.preventDefault();
                    openComposer(paragraph.id);
                  }
                }}
              >
                {paragraph.text}
              </p>
              <div className="pd-margin" aria-label={`Annotations for paragraph ${paragraph.id}`}>
                {paragraphAnnotations.length > 0 ? (
                  <button
                    type="button"
                    className="pd-margin-marker"
                    data-paragraph-id={paragraph.id}
                    data-testid={`margin-marker-${paragraph.id}`}
                    aria-expanded={openIds.has(paragraph.id)}
                    aria-controls={`pd-annotation-list-${paragraph.id}`}
                    aria-label={
                      count > 0
                        ? `${count} annotation${count === 1 ? "" : "s"} on this paragraph`
                        : "Annotations hidden by moderation on this paragraph"
                    }
                    onClick={() => {
                      setOpenIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(paragraph.id)) {
                          next.delete(paragraph.id);
                        } else {
                          next.add(paragraph.id);
                          setSelected(paragraph.id);
                        }
                        return next;
                      });
                    }}
                  >
                    <span className="pd-margin-marker__dot" aria-hidden="true" />
                    {count > 1 ? <span className="pd-margin-marker__count">{count}</span> : null}
                  </button>
                ) : null}
              </div>
              {paragraphAnnotations.length > 0 && openIds.has(paragraph.id) ? (
                <ul
                  id={`pd-annotation-list-${paragraph.id}`}
                  className="pd-annotation-list"
                  aria-label={`Annotations for ${paragraph.id}`}
                >
                  {paragraphAnnotations.map((annotation, index) => {
                    const rowKey = annotation.id || `${paragraph.id}-${index}`;
                    if (annotation.hidden !== true) {
                      return (
                        <li
                          key={rowKey}
                          className="pd-annotation"
                          data-annotation-id={annotation.id}
                        >
                          {annotation.quote ? (
                            <blockquote className="pd-annotation__quote">{annotation.quote}</blockquote>
                          ) : null}
                          {annotation.text ? (
                            <p className="pd-annotation__text">{annotation.text}</p>
                          ) : null}
                        </li>
                      );
                    }
                    // A hidden annotation keeps its place but its body is
                    // withheld: every reader gets the moderator's reason. Its
                    // author is told it is theirs, can read their own words on
                    // request, and can follow the way to appeal it (D1); the
                    // node serves those to the author alone.
                    if (annotation.is_own === true) {
                      const ownText = readText(annotation.own_text);
                      const ownId = `pd-annotation-own-${rowKey}`;
                      const ownOpen = ownOpenIds.has(rowKey);
                      const appealHref = `${discussionPath(paperId, discussionVersion)}#post-${encodeURIComponent(
                        annotation.id,
                      )}`;
                      return (
                        <li
                          key={rowKey}
                          className="pd-annotation"
                          data-annotation-id={annotation.id}
                          data-own-hidden="true"
                        >
                          <p className="pd-annotation__text pd-post__text--hidden" data-hidden="true">
                            {hiddenOwnNotice(annotation.hidden_reason, { isAnnotation: true })}{" "}
                            <a className="pd-action" href={appealHref}>
                              Appeal
                            </a>
                          </p>
                          {ownText !== null ? (
                            <>
                              {ownOpen ? (
                                <>
                                  {annotation.quote ? (
                                    <blockquote className="pd-annotation__quote">
                                      {annotation.quote}
                                    </blockquote>
                                  ) : null}
                                  <p className="pd-annotation__text" id={ownId} data-own-text="true">
                                    {ownText}
                                  </p>
                                </>
                              ) : null}
                              <button
                                type="button"
                                className="pd-action"
                                data-action="show-own-annotation"
                                aria-expanded={ownOpen}
                                aria-controls={ownOpen ? ownId : undefined}
                                onClick={() => toggleOwnText(rowKey)}
                              >
                                {ownOpen ? "Hide my annotation" : "Show my annotation"}
                              </button>
                            </>
                          ) : null}
                        </li>
                      );
                    }
                    return (
                      <li
                        key={rowKey}
                        className="pd-annotation"
                        data-annotation-id={annotation.id}
                      >
                        <p className="pd-annotation__text pd-post__text--hidden" data-hidden="true">
                          {typeof annotation.hidden_reason === "string" &&
                          annotation.hidden_reason.trim() !== ""
                            ? `Hidden by moderation: ${annotation.hidden_reason.trim()}`
                            : "Hidden by moderation."}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>

      {composerFor ? (
        <div className="pd-annotation-popover" role="dialog" aria-label="New annotation">
          <label className="pd-annotation-popover__label" htmlFor="pd-annotation-text">
            Annotation
          </label>
          <textarea
            id="pd-annotation-text"
            className="pd-compose__text"
            value={composerText}
            onChange={(event) => setComposerText(event.target.value)}
            aria-label="Annotation"
          />
          {composerError ? (
            <p className="pd-error-text" role="alert">
              {composerError}
            </p>
          ) : null}
          <div className="pd-compose__actions">
            <button
              type="button"
              className="pd-button"
              disabled={submitting}
              onClick={handleCreate}
            >
              {submitting ? "Saving…" : "Save annotation"}
            </button>
            <button type="button" className="pd-button" onClick={closeComposer}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// Aliases for the component under many plausible names.
export const Annotations = MarginMarkers;
export const AnnotationMarkers = MarginMarkers;
export const MarginAnnotations = MarginMarkers;
export const AnnotatedText = MarginMarkers;
export const AnnotatedParagraphs = MarginMarkers;
export const AnnotatedPaper = MarginMarkers;
export const ParagraphAnnotations = MarginMarkers;
export const AnnotationList = MarginMarkers;
export const AnnotationPopover = MarginMarkers;

// Default export for `import X from`.
export default MarginMarkers;
