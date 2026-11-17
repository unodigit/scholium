/**
 * People are shown by name, with the DID as secondary text.
 *
 * A signed `paper.version` lists authors by DID, and the name is optional:
 * an author added by DID is signed with no name at all. The public profile
 * route (`GET /v1/profiles/{did}`) is where the name lives, so the Sign
 * summary, the consent page and the trackers ask it for every byline entry
 * they do not already have a name for. A DID that has no profile (or a name
 * it erased) stays a DID -- that is the only identity the node can vouch for.
 *
 * No React here; `use-profile-names.ts` binds the lookup to a render.
 */

import { api } from "../../lib/api";

/** The part of `GET /v1/profiles/{did}` this module reads. */
interface ProfileNameBody {
  name?: unknown;
}

/** Looks up one DID's public name; `null` when there is none to show. */
export type FetchProfileName = (did: string, signal?: AbortSignal) => Promise<string | null>;

/** A DID's public name, or `null`. A failed read is "no name", never an error. */
export const fetchProfileName: FetchProfileName = async (did, signal) => {
  try {
    const body = await api.get<ProfileNameBody>(`/profiles/${encodeURIComponent(did)}`, {
      auth: false,
      cache: "no-store",
      signal,
    });
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    return name === "" ? null : name;
  } catch {
    return null;
  }
};

/** Names keyed by DID, ready to merge into a display author. */
export type ProfileNames = Readonly<Record<string, string>>;

/**
 * Resolves the names of `dids` in parallel. DIDs that cannot be read are left
 * out of the map rather than mapped to a placeholder, so a caller falls back to
 * the identifier it already has.
 */
export async function resolveProfileNames(
  dids: readonly string[],
  fetcher: FetchProfileName = fetchProfileName,
  signal?: AbortSignal,
): Promise<ProfileNames> {
  const unique = [...new Set(dids.filter((did): did is string => typeof did === "string" && did !== ""))];
  const resolved = await Promise.all(
    unique.map(async (did) => [did, await fetcher(did, signal)] as const),
  );
  const names: Record<string, string> = {};
  for (const [did, name] of resolved) {
    if (name !== null && name !== "") {
      names[did] = name;
    }
  }
  return names;
}

/** `authors` with every blank name filled from `names`, keeping what was typed. */
export function withProfileNames<T extends { did: string | null; name: string }>(
  authors: readonly T[],
  names: ProfileNames,
): T[] {
  return authors.map((author) => {
    if (author.name.trim() !== "" || author.did === null) {
      return author;
    }
    const name = names[author.did];
    return name === undefined ? author : { ...author, name };
  });
}
