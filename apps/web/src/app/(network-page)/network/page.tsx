import type { Metadata } from "next";

import { NetworkPage } from "../../../features/network-page/network-page";
import {
  describeNetworkError,
  loadNetworkStatus,
  type NetworkStatus,
} from "../../../features/network-page/network";

export const metadata: Metadata = {
  title: "Network",
  description:
    "What this Scholium node says about itself, in public: its standing, log head, anchor status, replicas and moderation record.",
};

/**
 * The page is fetched fresh on every request: the log head moves with every
 * record the node accepts, and a cached page would present an old head as the
 * current one. `force-dynamic` also keeps `next build` from trying to bake an
 * error state when the API is not running at build time.
 */
export const dynamic = "force-dynamic";

/**
 * `/network` — this node's public transparency document, from
 * `GET /v1/network`.
 *
 * Fetching on the server puts the whole status in the first HTML response
 * (and avoids a cross-origin request from the browser). The document is a
 * public read, so no account is needed. A failure is rendered as a retryable
 * notice rather than thrown, so the page shell and navigation still work; the
 * client component retries in the browser.
 */
export default async function NetworkRoutePage() {
  let initialStatus: NetworkStatus | undefined;
  let initialError: string | undefined;

  try {
    initialStatus = await loadNetworkStatus();
  } catch (error) {
    initialError = describeNetworkError(error);
  }

  return <NetworkPage initialStatus={initialStatus} initialError={initialError} />;
}
