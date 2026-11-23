import { readFileSync } from "node:fs";
import path from "node:path";

import { HANDBOOK_DIR } from "./handbook";

/**
 * A chapter's video transcript: the WebVTT file in `docs/handbook/transcripts/`
 * turned into paragraphs of plain text for the "Read the transcript"
 * disclosure.
 *
 * This module reads files, so it belongs on the server: the chapter page loads
 * the paragraphs while it is statically generated and hands them to
 * `<ChapterVideo>` as a prop. Nothing here is imported by a client component,
 * which keeps `node:fs` out of the browser bundle.
 *
 * What is dropped from the file: the `WEBVTT` header block (and any header
 * metadata under it), `NOTE`, `STYLE` and `REGION` blocks, cue numbers (cue
 * identifiers), cue timings with their settings, and the markup inside a cue
 * (`<v Speaker>`, `<i>`, `<c.class>`, `<00:00:01.000>`). What is kept is the
 * spoken text, one string per cue.
 */

/** A paragraph never spans more than this many cues. */
export const MAX_CUES_PER_PARAGRAPH = 6;

/**
 * A cue timing line: `[hh:]mm:ss.ttt --> [hh:]mm:ss.ttt`, optionally followed
 * by cue settings (`align:start position:0%`). A comma before the milliseconds
 * (SubRip style) is accepted too, so a file exported by a tool that mixes the
 * two formats still parses.
 */
const CUE_TIMING =
  /^[ \t]*(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}[ \t]+-->[ \t]+(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}(?:[ \t].*)?$/;

/** Cue markup: `<v Speaker>`, `</v>`, `<c.loud>`, `<i>`, and `<00:00:01.000>`. */
const CUE_TAGS = /<\/?[a-zA-Z][^>]*>|<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/g;

/** The only character references WebVTT defines. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lrm: "",
  rlm: "",
};

/**
 * A sentence ends with `.`, `!`, `?` or `…`, possibly followed by closing
 * quotes or brackets (`He said "stop."`).
 */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/** The plain text of one cue's payload lines. */
function cueText(payload: readonly string[]): string {
  return (
    payload
      .join(" ")
      // Tags go first, so an escaped `&lt;b&gt;` stays literal text.
      .replace(CUE_TAGS, "")
      // One pass over the references, so `&amp;lt;` decodes to `&lt;`, not `<`.
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_match, name: string) => ENTITIES[name] ?? "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The text of every cue in a WebVTT document, in order, one string per cue
 * (a cue on several lines is joined with spaces). A block is a cue when it
 * holds a timing line; whatever sits above that line is the cue's identifier
 * and is dropped, so numbered and unnumbered files read the same. Cues with no
 * text are skipped.
 */
export function parseCues(vtt: string): string[] {
  const source = vtt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s+/, "");

  const cues: string[] = [];
  // Blocks are separated by one or more blank (or whitespace-only) lines.
  for (const block of source.split(/\n(?:[ \t]*\n)+/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => CUE_TIMING.test(line));
    // No timing line: the WEBVTT header, a NOTE, a STYLE or a REGION block.
    if (timing === -1) continue;
    const text = cueText(lines.slice(timing + 1));
    if (text !== "") cues.push(text);
  }
  return cues;
}

/** Whether a cue's text finishes a sentence. */
function endsSentence(cue: string): boolean {
  return SENTENCE_END.test(cue);
}

/**
 * Group cue texts into paragraphs: a paragraph ends after a cue that ends a
 * sentence, and after {@link MAX_CUES_PER_PARAGRAPH} cues whether or not the
 * sentence is finished, so captions that run on without punctuation still
 * break up.
 */
export function groupParagraphs(cues: readonly string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const cue of cues) {
    current.push(cue);
    if (endsSentence(cue) || current.length >= MAX_CUES_PER_PARAGRAPH) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** The paragraphs of a WebVTT document. */
export function parseTranscript(vtt: string): string[] {
  return groupParagraphs(parseCues(vtt));
}

/**
 * Read and parse a chapter's transcript.
 *
 * @param file The path from videos.json's `transcript` field, relative to
 *   `docs/handbook/` (e.g. `transcripts/ch02-your-account.vtt`). An empty path
 *   means the chapter has no transcript and gives no paragraphs.
 * @param baseDir The directory `file` is relative to; the handbook directory
 *   unless a test points it elsewhere.
 * @throws When the file cannot be read or resolves outside `baseDir`: the
 *   docs are built from the handbook, so a missing transcript should fail the
 *   build rather than ship a chapter without it.
 */
export function loadTranscript(file: string, baseDir: string = HANDBOOK_DIR): string[] {
  if (file.trim() === "") return [];
  const resolved = path.resolve(baseDir, file);
  const relative = path.relative(baseDir, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`The transcript path ${JSON.stringify(file)} is outside ${baseDir}`);
  }
  return parseTranscript(readFileSync(resolved, "utf8"));
}
