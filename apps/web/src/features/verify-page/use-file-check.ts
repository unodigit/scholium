/**
 * The state behind `/verify`: the version id the reader typed, the signed file
 * list loaded for it, and the file they dropped, fingerprinted on their device.
 *
 * Two things happen independently, in whichever order the reader supplies
 * them, and {@link deriveVerdict} combines whatever has arrived:
 *
 * - **The signed list.** Whenever the id field holds a valid version id, its
 *   file list is loaded from the node. Editing the id abandons the request in
 *   flight, and an answer for an older id is never used for a newer one.
 * - **The file.** Dropping a file starts fingerprinting it in chunks
 *   (`fingerprintBlob`, the same code the Submit wizard uses), reporting
 *   progress. Dropping another file abandons the first.
 *
 * Nothing about the file is sent anywhere: the only request made is for the
 * signed list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FingerprintAborted, fingerprintBlob } from "../submit/fingerprint";
import {
  describeManifestError,
  loadVersionManifest,
  type LoadManifest,
} from "./manifest-source";
import {
  deriveVerdict,
  manifestStateFor,
  type FileState,
  type LoadedManifest,
  type ManifestState,
  type Verdict,
} from "./verdict";
import { parseVersionRef, type VersionRef } from "./version-ref";

export interface FileCheckOptions {
  /** The id to start with, e.g. from `/verify?id=…`. */
  initialId?: string;
  /** Where signed file lists come from. Pass a stable function: a new one reloads the list. */
  loadManifest?: LoadManifest;
}

export interface FileCheck {
  /** What is in the id field. */
  readonly idText: string;
  readonly setIdText: (text: string) => void;
  /** Call when the id field loses focus: its problems are shown until it is edited again. */
  readonly onIdBlur: () => void;
  /** Why the id cannot be used, once the reader has had a chance to finish typing it. */
  readonly idError: string | null;
  /** The version the id names, when it names one. */
  readonly ref: VersionRef | null;
  readonly manifest: ManifestState;
  readonly file: FileState;
  /** Start checking `file`, replacing any file already being checked. */
  readonly checkFile: (file: File) => void;
  /** Ask the node for the signed list again. */
  readonly retry: () => void;
  readonly verdict: Verdict;
}

const UNREADABLE_MESSAGE =
  "The file could not be read. It may have been moved or deleted while Scholium was reading it.";

export function useFileCheck({
  initialId = "",
  loadManifest = loadVersionManifest,
}: FileCheckOptions = {}): FileCheck {
  const [idText, setIdTextState] = useState(initialId);
  // Whether the reader has finished with the id field, so its problems may be
  // shown. A link that arrives with an id in it should say if the id is wrong;
  // a field someone is editing should not scold them for every half-typed id.
  const [settledId, setSettledId] = useState(initialId.trim() !== "");
  const [attempt, setAttempt] = useState(0);

  const parsed = useMemo(
    () => (idText.trim() === "" ? null : parseVersionRef(idText)),
    [idText],
  );
  const ref = parsed !== null && parsed.ok ? parsed.ref : null;
  const idError = parsed !== null && !parsed.ok && settledId ? parsed.message : null;

  const setIdText = useCallback((text: string) => {
    setIdTextState(text);
    setSettledId(false);
  }, []);

  // ---- The signed file list ------------------------------------------------

  const [loaded, setLoaded] = useState<LoadedManifest | null>(null);
  const schId = ref?.schId ?? null;

  useEffect(() => {
    if (ref === null) {
      setLoaded(null);
      return;
    }
    const controller = new AbortController();
    setLoaded({ schId: ref.schId, state: { status: "loading" } });

    loadManifest(ref, controller.signal).then(
      (manifest) => {
        if (controller.signal.aborted) return;
        setLoaded({ schId: ref.schId, state: { status: "ready", manifest } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({
          schId: ref.schId,
          state: { status: "unavailable", message: describeManifestError(error, ref) },
        });
      },
    );
    return () => controller.abort();
    // `ref` is fully determined by `schId`, so the id is the dependency.
  }, [schId, loadManifest, attempt]);

  const manifest = manifestStateFor(ref, loaded);

  // ---- The reader's file ---------------------------------------------------

  const [file, setFile] = useState<FileState>({ status: "idle" });
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  const checkFile = useCallback((chosen: File) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;

    const { name, size } = chosen;
    // Choosing a file is moving on from the id field: say if it cannot be used.
    setSettledId(true);
    setFile({ status: "hashing", name, size, hashed: 0 });

    fingerprintBlob(chosen, {
      signal: controller.signal,
      onProgress: (hashed) => {
        if (!controller.signal.aborted) setFile({ status: "hashing", name, size, hashed });
      },
    }).then(
      (cid) => {
        if (!controller.signal.aborted) setFile({ status: "ready", file: { name, size, cid } });
      },
      (error: unknown) => {
        if (controller.signal.aborted || error instanceof FingerprintAborted) return;
        setFile({ status: "unreadable", name, message: UNREADABLE_MESSAGE });
      },
    );
  }, []);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const onIdBlur = useCallback(() => setSettledId(true), []);

  const verdict = useMemo(() => deriveVerdict({ ref, manifest, file }), [ref, manifest, file]);

  return { idText, setIdText, onIdBlur, idError, ref, manifest, file, checkFile, retry, verdict };
}
