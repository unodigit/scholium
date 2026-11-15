import type { Metadata } from "next";

import { ModConsole } from "../../../features/mod-console/mod-console";

export const metadata: Metadata = {
  title: "Moderation console · Scholium",
  description:
    "The moderation queue: papers waiting for a decision, with their automated check signals.",
};

/**
 * `/mod` — the moderation console (tier 4).
 *
 * The queue needs the signed-in account's bearer token, which only exists in
 * the browser, so unlike `/policies` there is nothing to fetch on the server:
 * the console fetches on the client and the API decides who may see it.
 */
export default function ModRoutePage() {
  return <ModConsole />;
}
