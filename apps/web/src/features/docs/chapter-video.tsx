"use client";

import { useEffect, useRef, useState } from "react";

import type { HandbookVideo } from "./handbook";

/**
 * A handbook chapter's explainer video, behind a click.
 *
 * Nothing from YouTube is requested until the reader asks for the video: the
 * page shows the chapter's own poster (a file under `public/docs/posters/`)
 * inside a button, and only a click swaps in the player, an iframe of the
 * cookieless embed host. The markup before the click holds no iframe and no
 * YouTube address, and the CSP (`frame-src`, next.config.js) allows exactly
 * that host.
 *
 * - A valid video id in `video.youtube`: the poster is a button, "Watch the
 *   chapter video (4 min 33 s)", with a play icon.
 * - An empty or invalid address (the owner has not uploaded the video yet):
 *   the poster with the note "Video coming soon" and no button.
 * - Either way a "Read the transcript" disclosure holds the transcript, so the
 *   chapter is usable without playing anything. It is a native `details`
 *   element, so it works before the page hydrates. Given no paragraphs it
 *   still renders, saying the transcript is not available yet.
 *
 * The transcript arrives as paragraphs because reading the WebVTT file needs
 * the file system: the chapter page calls `loadTranscript(video.transcript)`
 * (transcript.ts) and passes the result in.
 *
 * ```tsx
 * <ChapterVideo
 *   title={chapter.title}
 *   video={chapter.video}
 *   transcript={loadTranscript(chapter.video.transcript)}
 * />
 * ```
 *
 * This is a client module, so a server component may render `<ChapterVideo>`
 * but cannot call `extractYouTubeId` or `formatVideoDuration` from here: those
 * are exported for client code and for the tests.
 *
 * Styling is token utilities from the Tailwind bridge (`styles/theme.css`) and
 * the shared `material-chrome` glass from `styles/base.css`, which already
 * falls back to a solid surface when transparency is reduced or
 * `backdrop-filter` is missing. Focus rings and the reduced-motion rule come
 * from `base.css` too.
 */

const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** The `allow` list of the player iframe. */
const EMBED_ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";

/** A YouTube video id: 11 characters of base64url. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Path words that fill the id position of an embed address but name a
 * playlist or a channel's live stream, not a video. Both happen to be 11
 * characters long.
 */
const NOT_VIDEO_IDS = new Set(["videoseries", "live_stream"]);

const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const EMBED_ONLY_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_LINK_HOST = "youtu.be";

/**
 * The video id in a YouTube address, or null when there is none.
 *
 * Understood forms (a missing `https://` is tolerated, and any other query
 * parameter such as `t=30` or `si=…` is ignored):
 *
 * - `https://www.youtube.com/watch?v=ID`
 * - `https://youtu.be/ID`
 * - `https://www.youtube.com/embed/ID` (also on youtube-nocookie.com)
 * - `https://www.youtube.com/shorts/ID`
 *
 * The id must be exactly 11 characters from `A-Z a-z 0-9 _ -`; an address on
 * any other host, another kind of YouTube page (a playlist, a channel) or a
 * non-http(s) scheme gives null.
 */
export function extractYouTubeId(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname;
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");

  let candidate: string | null = null;
  if (host === SHORT_LINK_HOST) {
    if (segments.length === 1) candidate = segments[0];
  } else if (WATCH_HOSTS.has(host) || EMBED_ONLY_HOSTS.has(host)) {
    const kind = segments[0];
    if (kind === "embed" || (kind === "shorts" && WATCH_HOSTS.has(host))) {
      if (segments.length === 2) candidate = segments[1];
    } else if (kind === "watch" && WATCH_HOSTS.has(host)) {
      if (segments.length === 1) candidate = parsed.searchParams.get("v");
    }
  }

  if (candidate === null || NOT_VIDEO_IDS.has(candidate)) return null;
  return VIDEO_ID.test(candidate) ? candidate : null;
}

/**
 * A duration as the label shows it: `273` is `4 min 33 s`, `300` is `5 min`,
 * `45` is `45 s`. Null when the value is not a positive number of seconds.
 */
export function formatVideoDuration(seconds: number): string | null {
  const total = Math.round(seconds);
  if (!Number.isFinite(total) || total < 1) return null;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The player address for a video id; the only YouTube address in the app. */
function embedUrl(id: string): string {
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&cc_load_policy=1`;
}

export type ChapterVideoProps = {
  /** The chapter title without its number, e.g. `Your account`. */
  title: string;
  /** The chapter's entry from `videos.json`. */
  video: Pick<HandbookVideo, "youtube" | "duration_seconds" | "poster">;
  /** The transcript's paragraphs; without any, the disclosure says there is none yet. */
  transcript?: readonly string[];
  /** Extra classes for the outer element, e.g. spacing from the page. */
  className?: string;
};

/**
 * The glass pill that carries the label over the poster: the shared chrome
 * material, a hairline rim, and a lit top edge. The poster is a dark card in
 * both themes and the pill is a theme surface with `ink` text, so the label
 * keeps its contrast whichever theme is on.
 *
 * On a phone the frame is about 190 px tall and the poster's text runs down to
 * two thirds of it, so the pill is a single compact line there (13 px type,
 * 44 px tall, 12 px in from the corner) and only grows from 640 px up.
 */
const PILL =
  "material-chrome absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] sm:bottom-4 sm:left-4 sm:max-w-[calc(100%-2rem)] " +
  "rounded-pill border border-rule text-meta font-medium text-ink sm:text-ui " +
  "shadow-[inset_0_1px_0_var(--glass-hi),var(--shadow-glass)]";

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M9 6.5v11l9-5.5z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-2 motion-safe:transition-transform group-open/transcript:rotate-90"
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChapterVideo({ title, video, transcript = [], className }: ChapterVideoProps) {
  const id = extractYouTubeId(video.youtube);

  // The id the reader asked for, not a bare flag: if this instance is reused
  // for another chapter (client-side navigation), that chapter's video is not
  // loaded by a click on the previous one.
  const [startedId, setStartedId] = useState<string | null>(null);
  const playing = id !== null && startedId === id;

  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // The button the reader pressed is gone; keep keyboard focus in the player
    // instead of dropping it to the page.
    if (playing) frameRef.current?.focus();
  }, [playing]);

  const state = id === null ? "unavailable" : playing ? "playing" : "ready";
  const duration = formatVideoDuration(video.duration_seconds);
  const label = duration === null ? "Watch the chapter video" : `Watch the chapter video (${duration})`;

  return (
    <div className={className ? `chapter-video ${className}` : "chapter-video"} data-state={state}>
      {/* The frame's children are all absolutely positioned, so its 16:9 shape
          must not wait for a stylesheet: it is set inline. */}
      <div
        className="relative w-full overflow-hidden rounded-card bg-surface ring-1 ring-rule"
        style={{ aspectRatio: "16 / 9" }}
      >
        {/* Decorative: the label or the note says what this is, and the
            chapter's own heading carries the title. */}
        <img
          src={video.poster.src}
          width={video.poster.width}
          height={video.poster.height}
          alt=""
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {state === "ready" && (
          <button
            type="button"
            onClick={() => setStartedId(id)}
            className="group/play absolute inset-0 block h-full w-full cursor-pointer text-left"
          >
            <span
              className={`${PILL} flex items-center gap-2 py-1 pr-4 pl-1 sm:gap-3 sm:py-2 sm:pr-5 sm:pl-2 motion-safe:transition-transform group-hover/play:scale-[1.02] group-active/play:scale-[0.98]`}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
                <PlayIcon />
              </span>
              <span className="text-balance">{label}</span>
            </span>
          </button>
        )}

        {state === "unavailable" && <p className={`${PILL} m-0 px-4 py-2`}>Video coming soon</p>}

        {state === "playing" && id !== null && (
          <iframe
            ref={frameRef}
            src={embedUrl(id)}
            title={`Chapter video: ${title}`}
            allow={EMBED_ALLOW}
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full border-0"
          />
        )}
      </div>

      <details className="group/transcript mt-4">
        <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-control text-ui font-medium text-ink [&::-webkit-details-marker]:hidden">
          <ChevronIcon />
          Read the transcript
        </summary>
        <div className="mt-2 max-w-measure space-y-3 font-serif text-reading text-ink">
          {transcript.length > 0 ? (
            transcript.map((paragraph, index) => (
              <p key={index} className="m-0">
                {paragraph}
              </p>
            ))
          ) : (
            <p className="m-0 text-ink-2">The transcript is not available yet.</p>
          )}
        </div>
      </details>
    </div>
  );
}
