import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ChapterVideo, extractYouTubeId, formatVideoDuration } from "./chapter-video";
import type { ChapterVideoProps } from "./chapter-video";

afterEach(cleanup);

const ID = "dQw4w9WgXcQ";
const POSTER = { src: "/docs/posters/ch02-your-account.webp", width: 1280, height: 720 };
const TRANSCRIPT = [
  "Chapter two: your account.",
  "This chapter covers sign-in, account setup and trust tiers.",
];
const LABEL = "Watch the chapter video (4 min 33 s)";
/** Where the poster link goes before any JavaScript runs. */
const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`;
/** Where a click plays the video in place. */
const PLAYER_SRC = `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&cc_load_policy=1`;

function props(youtube: string, extra: Partial<ChapterVideoProps> = {}): ChapterVideoProps {
  return {
    title: "Your account",
    video: { youtube, duration_seconds: 273, poster: POSTER },
    transcript: TRANSCRIPT,
    ...extra,
  };
}

function view(youtube: string, extra: Partial<ChapterVideoProps> = {}) {
  return render(createElement(ChapterVideo, props(youtube, extra)));
}

function iframe(): HTMLIFrameElement | null {
  return document.querySelector("iframe");
}

/** The poster control: a link to the watch page, which JavaScript enhances. */
function link(): HTMLElement {
  return screen.getByRole("link", { name: LABEL });
}

describe("extractYouTubeId", () => {
  it.each([
    ["watch", `https://www.youtube.com/watch?v=${ID}`],
    ["watch with other parameters around v", `https://www.youtube.com/watch?feature=share&v=${ID}&t=30s`],
    ["watch on the bare domain", `https://youtube.com/watch?v=${ID}`],
    ["watch on the mobile site", `https://m.youtube.com/watch?v=${ID}`],
    ["watch over http", `http://www.youtube.com/watch?v=${ID}`],
    ["watch without a scheme", `youtube.com/watch?v=${ID}`],
    ["watch with surrounding spaces", `  https://www.youtube.com/watch?v=${ID}\n`],
    ["youtu.be", `https://youtu.be/${ID}`],
    ["youtu.be with tracking and a start time", `https://youtu.be/${ID}?si=abc123&t=12`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
    ["embed with a trailing slash and parameters", `https://www.youtube.com/embed/${ID}/?rel=0`],
    ["embed on the cookieless host", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["shorts on the bare domain", `https://youtube.com/shorts/${ID}?feature=share`],
  ])("finds the id in a %s address", (_form, url) => {
    expect(extractYouTubeId(url)).toBe(ID);
  });

  it("accepts every character an id can hold", () => {
    expect(extractYouTubeId("https://youtu.be/a-b_c-d_e-f")).toBe("a-b_c-d_e-f");
    expect(extractYouTubeId("https://youtu.be/ABCxyz09_-Z")).toBe("ABCxyz09_-Z");
  });

  it.each([
    ["an empty string", ""],
    ["only spaces", "   "],
    ["text that is not an address", "not a url"],
    ["an address on another host", `https://example.com/watch?v=${ID}`],
    ["a host that only ends like YouTube's", `https://notyoutube.com/watch?v=${ID}`],
    ["a host that only starts like YouTube's", `https://www.youtube.com.example.org/watch?v=${ID}`],
    ["a short link on another host", `https://youtu.be.example.org/${ID}`],
    ["an id that is too short", "https://www.youtube.com/watch?v=abc"],
    ["an id that is too long", `https://www.youtube.com/watch?v=${ID}x`],
    ["an id with a character it cannot hold", "https://www.youtube.com/watch?v=dQw4w9WgXc!"],
    ["a watch address with no v", "https://www.youtube.com/watch"],
    ["a watch address with an empty v", "https://www.youtube.com/watch?v="],
    ["a watch address with a path after watch", `https://www.youtube.com/watch/${ID}`],
    ["a playlist", "https://www.youtube.com/playlist?list=PLabcdefghijk"],
    ["a playlist embed", "https://www.youtube.com/embed/videoseries?list=PLabcdefghijk"],
    ["a live stream embed", "https://www.youtube.com/embed/live_stream?channel=UCabc"],
    ["a channel page", "https://www.youtube.com/@scholium"],
    ["a short link with no id", "https://youtu.be/"],
    ["a short link with a longer path", `https://youtu.be/${ID}/more`],
    ["a watch page on the embed-only host", `https://www.youtube-nocookie.com/watch?v=${ID}`],
    ["a shorts page on the embed-only host", `https://www.youtube-nocookie.com/shorts/${ID}`],
    ["a javascript: address", `javascript:alert("${ID}")`],
    ["an ftp address", `ftp://youtu.be/${ID}`],
  ])("gives null for %s", (_what, url) => {
    expect(extractYouTubeId(url)).toBeNull();
  });

  it("gives null when there is no string at all", () => {
    expect(extractYouTubeId(undefined)).toBeNull();
    expect(extractYouTubeId(null)).toBeNull();
  });
});

describe("formatVideoDuration", () => {
  it("writes minutes and seconds", () => {
    expect(formatVideoDuration(273)).toBe("4 min 33 s");
    expect(formatVideoDuration(447)).toBe("7 min 27 s");
    expect(formatVideoDuration(61)).toBe("1 min 1 s");
  });

  it("leaves out a zero part", () => {
    expect(formatVideoDuration(300)).toBe("5 min");
    expect(formatVideoDuration(45)).toBe("45 s");
  });

  it("rounds to the second", () => {
    expect(formatVideoDuration(272.6)).toBe("4 min 33 s");
  });

  it("gives null for a value that is not a positive duration", () => {
    for (const value of [0, -5, 0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatVideoDuration(value), String(value)).toBeNull();
    }
  });
});

describe("ChapterVideo without JavaScript", () => {
  it("serves a poster link to the watch page, and no player", () => {
    const markup = renderToString(createElement(ChapterVideo, props(`https://youtu.be/${ID}`)));

    // The server markup alone reaches the video: a plain link, same tab.
    expect(markup).toMatch(
      /<a [^>]*href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/,
    );
    expect(markup).not.toMatch(/<a [^>]*target=/);
    expect(markup).toContain(LABEL);

    // Nothing is fetched from YouTube before the click: no frame, no embed
    // address, no autoplay hint.
    expect(markup).not.toMatch(/<iframe/i);
    expect(markup).not.toMatch(/youtube-nocookie/i);
    expect(markup).not.toMatch(/\/embed\//);
    expect(markup).not.toMatch(/autoplay/i);

    // What the reader sees instead: the poster behind the link.
    expect(markup).toContain(POSTER.src);
  });
});

describe("ChapterVideo before the click", () => {
  it("has no player in the document either, whichever address form the owner pasted", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
    ]) {
      const { container, unmount } = view(url);
      expect(iframe(), url).toBeNull();
      expect(container.innerHTML, url).not.toMatch(/youtube-nocookie/i);
      expect(container.innerHTML, url).not.toMatch(/\/embed\//);
      // Every form becomes the same canonical watch page.
      expect(link().getAttribute("href"), url).toBe(WATCH_URL);
      unmount();
    }
  });

  it("shows the poster, a play icon and the label inside one link", () => {
    const { container } = view(`https://youtu.be/${ID}`);
    const anchor = link();
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBe(WATCH_URL);
    expect(anchor.hasAttribute("target")).toBe(false);

    const poster = anchor.parentElement?.querySelector("img");
    expect(poster?.getAttribute("src")).toBe(POSTER.src);
    expect(poster?.getAttribute("width")).toBe("1280");
    expect(poster?.getAttribute("height")).toBe("720");
    expect(poster?.getAttribute("alt")).toBe("");

    const icon = anchor.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");

    expect(anchor.textContent).toBe(LABEL);
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("ready");
    expect(screen.queryByText("Video coming soon")).toBeNull();
  });

  it("writes the duration from duration_seconds into the label", () => {
    view(`https://youtu.be/${ID}`, {
      video: { youtube: `https://youtu.be/${ID}`, duration_seconds: 356, poster: POSTER },
    });
    expect(screen.getByRole("link", { name: "Watch the chapter video (5 min 56 s)" })).toBeTruthy();
  });

  it("drops the parentheses when the duration is not usable", () => {
    view(`https://youtu.be/${ID}`, {
      video: { youtube: `https://youtu.be/${ID}`, duration_seconds: 0, poster: POSTER },
    });
    expect(screen.getByRole("link", { name: "Watch the chapter video" })).toBeTruthy();
  });

  it("holds the poster in a 16:9 frame", () => {
    const markup = renderToString(createElement(ChapterVideo, props(`https://youtu.be/${ID}`)));
    expect(markup).toMatch(/style="aspect-ratio:16 \/ 9"/);
  });
});

describe("ChapterVideo after the click", () => {
  it("opens the player in place on a plain click instead of following the link", () => {
    const { container } = view(`https://www.youtube.com/watch?v=${ID}`);
    let defaultPrevented: boolean | null = null;
    document.addEventListener(
      "click",
      (event) => {
        // Read after React's handler at the root has had its say.
        defaultPrevented = event.defaultPrevented;
      },
      { once: true },
    );

    fireEvent.click(link());

    // The reader asked for the video, not for YouTube's page.
    expect(defaultPrevented).toBe(true);
    expect(iframe()?.getAttribute("src")).toBe(PLAYER_SRC);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("leaves a modified click to the browser, so the watch page can open in a new tab", () => {
    view(`https://youtu.be/${ID}`);
    let defaultPrevented: boolean | null = null;
    document.addEventListener(
      "click",
      (event) => {
        defaultPrevented = event.defaultPrevented;
      },
      { once: true },
    );

    fireEvent.click(link(), { metaKey: true });

    expect(defaultPrevented).toBe(false);
    expect(iframe()).toBeNull();
  });

  it("replaces the link with the player iframe", () => {
    const { container } = view(`https://www.youtube.com/watch?v=${ID}`);
    fireEvent.click(link());

    expect(screen.queryByRole("link")).toBeNull();
    const frame = iframe();
    expect(frame).not.toBeNull();
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("playing");
  });

  it("embeds the cookieless player with autoplay, no related videos and captions on", () => {
    view(`https://youtu.be/${ID}?si=tracking`);
    fireEvent.click(link());

    expect(iframe()?.getAttribute("src")).toBe(PLAYER_SRC);
  });

  it("titles, permits and refers the iframe as specified", () => {
    view(`https://www.youtube.com/shorts/${ID}`);
    fireEvent.click(link());

    const frame = iframe();
    expect(frame?.getAttribute("title")).toBe("Chapter video: Your account");
    expect(frame?.getAttribute("allow")).toBe(
      "autoplay; encrypted-media; picture-in-picture; fullscreen",
    );
    expect(frame?.hasAttribute("allowfullscreen")).toBe(true);
    expect(frame?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the title as text, whatever characters it holds", () => {
    view(`https://youtu.be/${ID}`, { title: `Fish & "chips" <b>` });
    fireEvent.click(link());
    expect(iframe()?.title).toBe(`Chapter video: Fish & "chips" <b>`);
  });

  it("keeps the poster behind the player and the frame 16:9", () => {
    const { container } = view(`https://youtu.be/${ID}`);
    fireEvent.click(link());

    const frame = iframe()!;
    expect(frame.parentElement?.querySelector("img")?.getAttribute("src")).toBe(POSTER.src);
    expect(frame.parentElement?.getAttribute("style") ?? "").toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("moves keyboard focus into the player when the link disappears", () => {
    view(`https://youtu.be/${ID}`);
    const anchor = link();
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    fireEvent.click(anchor);
    expect(document.activeElement).toBe(iframe());
  });

  it("does not load another chapter's video when the instance is reused for it", () => {
    const { rerender } = view(`https://youtu.be/${ID}`);
    fireEvent.click(link());
    expect(iframe()).not.toBeNull();

    rerender(createElement(ChapterVideo, props("https://youtu.be/abcdefghijk")));
    expect(iframe()).toBeNull();
    expect(screen.getByRole("link", { name: LABEL })).toBeTruthy();
  });

  it("does not play on its own after a re-render with the same video", () => {
    const { rerender } = view(`https://youtu.be/${ID}`);
    rerender(createElement(ChapterVideo, props(`https://www.youtube.com/watch?v=${ID}&t=5`)));
    expect(iframe()).toBeNull();
  });
});

describe("ChapterVideo with no usable address", () => {
  it.each([
    ["an empty", ""],
    ["a blank", "   "],
    ["an invalid", "https://example.com/not-a-video"],
    ["a malformed", "not a url"],
    ["a playlist", "https://www.youtube.com/playlist?list=PLabcdefghijk"],
  ])("shows the poster and the coming-soon note, and no control, for %s address", (_what, url) => {
    const { container } = view(url);

    expect(screen.getByText("Video coming soon")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(POSTER.src);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(iframe()).toBeNull();
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("unavailable");
    expect(container.innerHTML).not.toMatch(/youtube/i);
    expect(screen.queryByText(/Watch the chapter video/)).toBeNull();
  });

  it("has nothing to click: the note and the poster are not interactive", () => {
    const { container } = view("");
    fireEvent.click(screen.getByText("Video coming soon"));
    fireEvent.click(container.querySelector("img")!);
    expect(iframe()).toBeNull();
  });

  it("renders the same 16:9 frame", () => {
    const markup = renderToString(createElement(ChapterVideo, props("")));
    expect(markup).toMatch(/style="aspect-ratio:16 \/ 9"/);
    expect(markup).toContain("Video coming soon");
  });
});

describe("the transcript disclosure", () => {
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ["before the click", `https://youtu.be/${ID}`, false],
    ["after the click", `https://youtu.be/${ID}`, true],
    ["when the video is coming soon", "", false],
  ];

  it.each(cases)("holds the transcript %s", (_when, url, clicked) => {
    const { container } = view(url);
    if (clicked) fireEvent.click(link());

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Read the transcript");

    const paragraphs = Array.from(details?.querySelectorAll("p") ?? []).map((p) => p.textContent);
    expect(paragraphs).toEqual(TRANSCRIPT);
  });

  it("is in the server-rendered markup, so it works before the page hydrates", () => {
    for (const url of [`https://youtu.be/${ID}`, ""]) {
      const markup = renderToString(createElement(ChapterVideo, props(url)));
      expect(markup).toMatch(/<details[^>]*>\s*<summary[^>]*>.*Read the transcript<\/summary>/s);
      for (const paragraph of TRANSCRIPT) expect(markup).toContain(paragraph);
      expect(markup).not.toMatch(/<details[^>]*\sopen/);
    }
  });

  it("opens and closes from its summary", () => {
    const { container } = view(`https://youtu.be/${ID}`);
    const details = container.querySelector("details")!;
    const summary = container.querySelector("summary")!;
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it("stays as it was when the video starts", () => {
    const { container } = view(`https://youtu.be/${ID}`);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent.click(link());
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  });

  it("is still there, and says so, when no transcript was given", () => {
    for (const url of [`https://youtu.be/${ID}`, ""]) {
      for (const transcript of [[], undefined]) {
        const { container, unmount } = view(url, { transcript });
        const details = container.querySelector("details");
        expect(details?.querySelector("summary")?.textContent).toBe("Read the transcript");
        expect(Array.from(details?.querySelectorAll("p") ?? []).map((p) => p.textContent)).toEqual([
          "The transcript is not available yet.",
        ]);
        unmount();
      }
    }
  });

  it("renders transcript text as text, not as markup", () => {
    const { container } = view("", { transcript: ["Use <b>bold</b> & <script>x</script>."] });
    expect(container.querySelector("details b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("details p")?.textContent).toBe(
      "Use <b>bold</b> & <script>x</script>.",
    );
  });
});

describe("ChapterVideo outer element", () => {
  it("takes extra classes from the page and keeps its own", () => {
    const { container } = view("", { className: "mt-6" });
    const root = container.firstElementChild;
    expect(root?.classList.contains("chapter-video")).toBe(true);
    expect(root?.classList.contains("mt-6")).toBe(true);
  });
});
