"use client";

/**
 * The signed-in reviewer's own reviews, as a hook (see `my-reviews.ts`).
 *
 * The read is made only while `enabled`: a signed-out reader, or a page with
 * nothing to ask about, costs no request. A failed read is `failed`, not an
 * error: the caller then offers only what it can without knowing.
 */

import { useEffect, useRef, useState } from "react";

import {
  loadMyReviews,
  type LoadMyReviews,
  type MyReview,
} from "./my-reviews";

/** Where the read stands. */
export type MyReviewsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly reviews: readonly MyReview[] }
  | { readonly status: "failed" };

const IDLE: MyReviewsState = { status: "idle" };
const LOADING: MyReviewsState = { status: "loading" };
const FAILED: MyReviewsState = { status: "failed" };

/**
 * The reviewer's reviews, read when `enabled` turns true.
 *
 * @param key Changes when the question does (another paper, another sign-in):
 *   the read starts over rather than showing the earlier answer.
 */
export function useMyReviews(
  enabled: boolean,
  key = "",
  load: LoadMyReviews = loadMyReviews,
): MyReviewsState {
  const [state, setState] = useState<{ key: string; value: MyReviewsState }>({
    key: "",
    value: IDLE,
  });

  // The latest loader, without making an inline function restart the read.
  const loadRef = useRef<LoadMyReviews>(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ key, value: LOADING });
    loadRef.current(controller.signal).then(
      (reviews) => {
        if (!controller.signal.aborted) {
          setState({ key, value: { status: "ready", reviews } });
        }
      },
      () => {
        if (!controller.signal.aborted) setState({ key, value: FAILED });
      },
    );
    return () => controller.abort();
  }, [enabled, key]);

  if (!enabled) return IDLE;
  // The render in which `enabled` flips has no read yet (the effect has not
  // run): that is loading, not idle.
  return state.key === key && state.value.status !== "idle" ? state.value : LOADING;
}
