import type { Metadata } from "next";

import { ModCases } from "../../../features/mod-console/mod-cases";
import { ModConsole } from "../../../features/mod-console/mod-console";

export const metadata: Metadata = {
  title: "Moderation console · Scholium",
  description:
    "The moderation queue, flags and appeals: papers waiting for a decision with their automated check signals, reports to review, and the panel vote on contested decisions.",
};

/**
 * `/mod` — the moderation console (tier 4).
 *
 * The queue needs the signed-in account's bearer token, which only exists in
 * the browser, so unlike `/policies` there is nothing to fetch on the server:
 * the console fetches on the client and the API decides who may see it.
 *
 * Flags and appeals follow the queue as a sibling, not inside it, so a `403`
 * on the queue (a tier-3 panel member is not a moderator) does not hide the
 * appeals that member may have to vote on.
 */
export default function ModRoutePage() {
  return (
    <>
      <ModConsole />
      <ModCases />
    </>
  );
}
