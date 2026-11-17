"use client";

/**
 * The render-side half of {@link resolveProfileNames}: keeps a DID→name map in
 * step with the byline currently on screen. A read that is aborted (the author
 * leaves the step, or the byline changes) never overwrites a newer answer.
 */

import { useEffect, useMemo, useState } from "react";

import { resolveProfileNames, type FetchProfileName, type ProfileNames } from "./profile-names";

export interface UseProfileNamesOptions {
  /** Replaces the public profile request, for tests and callers with their own client. */
  fetcher?: FetchProfileName;
}

/** The public names of `dids`, as they load; `{}` until then and for DIDs with no name. */
export function useProfileNames(
  dids: readonly string[],
  options: UseProfileNamesOptions = {},
): ProfileNames {
  const fetcher = options.fetcher;
  // A stable key, so a fresh array with the same DIDs does not refetch.
  const key = useMemo(
    () =>
      [...new Set(dids.filter((did): did is string => typeof did === "string" && did !== ""))]
        .sort()
        .join("\n"),
    [dids],
  );
  const [names, setNames] = useState<ProfileNames>({});

  useEffect(() => {
    const wanted = key === "" ? [] : key.split("\n");
    if (wanted.length === 0) {
      // Drop names of people who are no longer on the byline.
      setNames((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }
    const controller = new AbortController();
    void resolveProfileNames(wanted, fetcher, controller.signal).then((resolved) => {
      if (!controller.signal.aborted) {
        setNames(resolved);
      }
    });
    return () => controller.abort();
  }, [key, fetcher]);

  return names;
}
