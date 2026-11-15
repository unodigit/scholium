"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSubmitDraftStorage,
  type SubmitDraft,
  type SubmitDraftStorage,
} from "./submit-draft-storage";

export interface UseSubmitDraftOptions {
  storage?: SubmitDraftStorage;
  factory?: IDBFactory;
}

export interface UseSubmitDraftResult {
  draft: SubmitDraft | null;
  status: "idle" | "loading" | "saving" | "saved" | "error";
  save(draft: SubmitDraft): Promise<void>;
  clear(): Promise<void>;
}

export function useSubmitDraft(options: UseSubmitDraftOptions = {}): UseSubmitDraftResult {
  const storage = useRef<SubmitDraftStorage>(
    options.storage ?? createSubmitDraftStorage(options.factory ? { factory: options.factory } : {}),
  );
  const [draft, setDraft] = useState<SubmitDraft | null>(null);
  const [status, setStatus] = useState<UseSubmitDraftResult["status"]>("loading");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await storage.current.get();
        if (!active) return;
        setDraft(loaded ? { step: loaded.step, details: loaded.details, authors: loaded.authors, files: loaded.files } : null);
        setStatus("idle");
      } catch {
        if (active) setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (next: SubmitDraft) => {
    setStatus("saving");
    try {
      await storage.current.put(next);
      setDraft(next);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await storage.current.delete();
    } catch {
      // ignore
    }
    setDraft(null);
    setStatus("idle");
  }, []);

  return { draft, status, save, clear };
}
