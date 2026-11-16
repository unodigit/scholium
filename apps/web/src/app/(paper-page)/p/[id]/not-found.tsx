import { PaperAccess } from "../../../../features/paper-page";

/**
 * `/p/{id}` when the catalog has no such paper *for this render*.
 *
 * The server render holds no token (the access token lives in browser memory),
 * so the catalog also answers `404` for a version that is in moderation, held
 * before listing or awaiting co-author consent — even for its own author. The
 * response is still `404` for everyone, and the first HTML is the plain
 * not-found page. Once the page runs, `PaperAccess` restores the session and
 * asks again with the reader's token: an author or a moderator then sees the
 * paper with its status banner and the actions that apply; everyone else keeps
 * this page. See `features/paper-page/paper-access.tsx`.
 */
export default function PaperNotFound() {
  return <PaperAccess />;
}
