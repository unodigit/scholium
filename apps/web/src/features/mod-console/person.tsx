"use client";

/**
 * A person behind a DID, as the moderation console shows them.
 *
 * The console reads DIDs — the flag's reporter, the record's author, the
 * appeal's appellant — but a DID is a key, not a name, and the node usually
 * knows the person: `GET /v1/profiles/{did}` is the public profile every
 * member has. Wherever a name exists the console shows it, with the DID kept
 * as secondary text so the signed record is still one glance away; where it
 * does not (an erased profile, a pseudonymous review key, a DID this node has
 * no profile for) the DID stands in alone and nothing is hidden.
 */

import { useEffect, useState } from "react";

import { api, type ApiClient } from "../../lib/api";
import { loadProfile } from "../search-page/paper";
import { shortenDid } from "./decision";
import "./mod-console.css";

/** Anything that can read a profile; the shared client by default. */
export type PersonClient = Pick<ApiClient, "get">;

/** Reads a DID's public display name; replaceable in tests. */
export type LoadPersonName = (did: string) => Promise<string | null>;

/**
 * Read one DID's public display name, or `null` when there is none.
 *
 * The profile is a public read and always optional to the page: a missing
 * profile, a transport failure and an unreadable body each read as "no name",
 * so the caller keeps showing the DID rather than an error.
 */
export async function loadPersonName(
  did: string,
  client: PersonClient = api,
): Promise<string | null> {
  try {
    const profile = await loadProfile(did, client);
    const name = profile.name;
    return name !== null && name.trim() !== "" ? name.trim() : null;
  } catch {
    return null;
  }
}

/** Props for {@link PersonName}. */
export interface PersonNameProps {
  /** The DID the console is naming. An empty DID renders nothing. */
  readonly did: string;
  /** Replace the name loader, for tests or an alternate API client. */
  readonly loadName?: LoadPersonName;
  /** Extra classes for the wrapping span. */
  readonly className?: string;
}

/**
 * A DID's name, with the DID as secondary text; the DID alone when unnamed.
 *
 * The DID shows first and is replaced by the name once the profile answers,
 * so the first paint is always truthful and never blank.
 */
export function PersonName({ did, loadName = loadPersonName, className }: PersonNameProps) {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setName(null);
    if (did === "") {
      return;
    }
    loadName(did).then(
      (resolved) => {
        if (!cancelled) setName(resolved);
      },
      () => {
        if (!cancelled) setName(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [did, loadName]);

  if (did === "") {
    return null;
  }
  if (name === null) {
    return <span className={className}>{shortenDid(did)}</span>;
  }
  return (
    <span className={className}>
      {name}{" "}
      <span className="mc-person-did mono-id" title={did}>
        {shortenDid(did)}
      </span>
    </span>
  );
}

export default PersonName;
