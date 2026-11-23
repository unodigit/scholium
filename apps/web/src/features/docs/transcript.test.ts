import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chapters } from "./handbook";
import {
  MAX_CUES_PER_PARAGRAPH,
  groupParagraphs,
  loadTranscript,
  parseCues,
  parseTranscript,
} from "./transcript";

/** A small file with every kind of block a WebVTT file can hold. */
const SAMPLE = `WEBVTT - Chapter two: your account
Kind: captions
Language: en

NOTE
This block is a comment and never spoken.

STYLE
::cue { color: white }

1
00:00:00.000 --> 00:00:01.613
Chapter two: your account.

2
00:00:01.613 --> 00:00:05.272 align:start position:0%
This chapter covers sign-in,
account setup and trust tiers.

3
00:00:05.272 --> 00:00:09.000
To sign in,

4
00:00:09.000 --> 00:00:12.000
<v Narrator>choose <i>Sign in</i> with a passkey</v>

5
00:00:12.000 --> 00:00:14.000
Fish &amp; chips &lt;b&gt; at <00:00:13.000>no cost?

6
00:00:14.000 --> 00:00:16.000
Yes!

7
00:00:16.000 --> 00:00:18.000
It is free…
`;

describe("parseCues", () => {
  it("drops the header, notes, styles, cue numbers and timings", () => {
    expect(parseCues(SAMPLE)).toEqual([
      "Chapter two: your account.",
      "This chapter covers sign-in, account setup and trust tiers.",
      "To sign in,",
      "choose Sign in with a passkey",
      "Fish & chips <b> at no cost?",
      "Yes!",
      "It is free…",
    ]);
  });

  it("reads unnumbered cues, hour timings and cue settings the same way", () => {
    const vtt = "WEBVTT\n\n01:00:00.000 --> 01:00:02.500 line:90%\nOne hour in.\n";
    expect(parseCues(vtt)).toEqual(["One hour in."]);
  });

  it("reads CRLF line endings and a byte order mark", () => {
    const vtt = "﻿WEBVTT\r\n\r\n1\r\n00:00:00.000 --> 00:00:01.000\r\nHello,\r\nworld.\r\n";
    expect(parseCues(vtt)).toEqual(["Hello, world."]);
  });

  it("tolerates runs of blank lines and a header with no blank line after it", () => {
    const vtt =
      "WEBVTT\n00:00:00.000 --> 00:00:01.000\nFirst.\n\n\n   \n00:00:01.000 --> 00:00:02.000\nSecond.";
    expect(parseCues(vtt)).toEqual(["First.", "Second."]);
  });

  it("skips a cue with no text", () => {
    const vtt =
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<i></i>\n\n00:00:01.000 --> 00:00:02.000\nKept.\n";
    expect(parseCues(vtt)).toEqual(["Kept."]);
  });

  it("decodes each character reference once", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&amp;lt; and&nbsp;&lrm;done\n";
    expect(parseCues(vtt)).toEqual(["&lt; and done"]);
  });

  it("returns nothing for a file with only a header, or no text at all", () => {
    expect(parseCues("WEBVTT\n")).toEqual([]);
    expect(parseCues("")).toEqual([]);
  });
});

describe("parseTranscript: the paragraphs of the sample file", () => {
  it("starts a new paragraph after a cue that ends a sentence", () => {
    expect(parseTranscript(SAMPLE)).toEqual([
      "Chapter two: your account.",
      "This chapter covers sign-in, account setup and trust tiers.",
      // "To sign in," and the next cue do not end a sentence; the "?" does.
      "To sign in, choose Sign in with a passkey Fish & chips <b> at no cost?",
      "Yes!",
      "It is free…",
    ]);
  });

  it("keeps the same paragraphs when the file uses CRLF line endings", () => {
    expect(parseTranscript(SAMPLE.replace(/\n/g, "\r\n"))).toEqual(parseTranscript(SAMPLE));
  });
});

describe("groupParagraphs", () => {
  it("treats . ! ? and … as sentence ends, also before a closing quote or bracket", () => {
    for (const end of [".", "!", "?", "…", '."', "?)", "!”", ".’", ".]"]) {
      expect(groupParagraphs([`one${end}`, "two"]), `ending ${end}`).toEqual([`one${end}`, "two"]);
    }
  });

  it("does not end a paragraph at a comma, colon, semicolon or dash", () => {
    for (const end of [",", ":", ";", " -", "…and"]) {
      expect(groupParagraphs([`one${end}`, "two."]), `ending ${end}`).toEqual([`one${end} two.`]);
    }
  });

  it("breaks after 6 cues when no cue ends a sentence", () => {
    expect(MAX_CUES_PER_PARAGRAPH).toBe(6);
    const cues = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(groupParagraphs(cues)).toEqual(["a b c d e f", "g h"]);
  });

  it("counts the cues from the last break, not from the start of the file", () => {
    const cues = ["a", "b", "c.", "d", "e", "f", "g", "h", "i", "j"];
    expect(groupParagraphs(cues)).toEqual(["a b c.", "d e f g h i", "j"]);
  });

  it("closes a paragraph when its sixth cue also ends a sentence", () => {
    expect(groupParagraphs(["a", "b", "c", "d", "e", "f.", "g"])).toEqual(["a b c d e f.", "g"]);
  });

  it("returns no paragraphs for no cues", () => {
    expect(groupParagraphs([])).toEqual([]);
  });
});

describe("loadTranscript", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function handbookWith(file: string, contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "transcript-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, file), contents);
    return dir;
  }

  it("reads a file relative to the given directory", () => {
    const dir = handbookWith("one.vtt", SAMPLE);
    expect(loadTranscript("one.vtt", dir)).toEqual(parseTranscript(SAMPLE));
  });

  it("gives no paragraphs for an empty path", () => {
    expect(loadTranscript("")).toEqual([]);
  });

  it("refuses a path that leaves the directory", () => {
    const dir = handbookWith("one.vtt", SAMPLE);
    expect(() => loadTranscript("../one.vtt", dir)).toThrow(/outside/);
    expect(() => loadTranscript(path.join(dir, "one.vtt"), path.join(dir, "sub"))).toThrow(
      /outside/,
    );
    expect(() => loadTranscript(".", dir)).toThrow(/outside/);
  });

  it("fails for a transcript that does not exist", () => {
    expect(() => loadTranscript("missing.vtt", handbookWith("one.vtt", SAMPLE))).toThrow(/ENOENT/);
  });

  it("parses the real transcript of every chapter that has a video", () => {
    const withVideo = chapters.filter((chapter) => chapter.video !== null);
    expect(withVideo.length).toBe(11);
    for (const chapter of withVideo) {
      const paragraphs = loadTranscript(chapter.video!.transcript);
      expect(paragraphs.length, `chapter ${chapter.number}`).toBeGreaterThan(5);
      for (const paragraph of paragraphs) {
        expect(paragraph.trim(), `chapter ${chapter.number}`).toBe(paragraph);
        expect(paragraph).not.toMatch(/-->|WEBVTT|\d{2}:\d{2}[.,]\d{3}|<[^>]+>/);
      }
    }
  });

  it("starts chapter 2's transcript with its spoken introduction", () => {
    const chapter = chapters.find((item) => item.number === 2)!;
    const paragraphs = loadTranscript(chapter.video!.transcript);
    expect(paragraphs.slice(0, 2)).toEqual([
      "Chapter two: your account.",
      "This chapter covers sign-in, account setup and trust tiers.",
    ]);
  });
});
