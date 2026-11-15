---
description: Turn a `claw-forge analyze` rebuild verdict into reviewed PRD/architecture/design documents and a journey contract
allowed-tools: [Read, Write, Bash]
---

# /rebuild-extract

Turn an `analyze` verdict of `rebuild` into documents an owner can review and
a journey contract that proves the new app matches the old one. Model and
browser work happens here, in this session — a CLI child process has neither
a model credential nor browser-harness reliably, so the deterministic half of
this work (`claw-forge rebuild check|approve|start|parity`) is a separate CLI
and this command is the only place the two meet.

## Step 1 — Read the analysis

Read `<state dir>/analyze/analysis.md`, `<state dir>/analyze/verdict.json`,
and `<state dir>/analyze/graph.json`. Refuse to continue if no verdict
exists yet — tell the user to run `claw-forge analyze` first. If a verdict
exists but it is not `rebuild`, warn (this command is only built for the
rebuild path) and ask whether to continue anyway.

## Step 2 — Ask before starting

Do not launch into this silently: it starts the old app, opens a browser
tab, walks every journey with screenshots, and then drafts four documents —
real time and, if this session is metered, real cost. Present a short plan
(what verdict you read, which journeys you expect to re-verify, where
documents will be written) and get a yes before Step 3.

## Step 3 — Start the old app, or stop

Start the old app the project's own way (its README, `package.json`
scripts, whatever the project actually uses). Record the command and URL.
**If it cannot start, that is finding #1** — stop here and report it; there
is no rebuild contract without a running old app to verify journeys
against.

## Step 4 — Archive old journeys, then write and verify new ones

If `<state dir>/journeys/` already holds files from an earlier verify pass,
move them to `<state dir>/journeys/_archive/<timestamp>/` first — **never
delete them** — and list what was archived in the plan from Step 2.

Write one journey file per user goal using the exact template in
`.claude/commands/verify-journeys.md` (its Phase 1 — do not copy the
template here, reference that file so the two never drift). Then verify
each journey on the **old** app, with browser-harness, saving screenshot
evidence to `<state dir>/journeys/screenshots/<id>/` the same way
`verify-journeys.md`'s Phase 2 does.

- `pass` → list its id in `<state dir>/rebuild/contract-candidates.json`:
  `{"journeys": ["<id>", "<id>", ...]}`.
- `fail` / `blocked` → record it in `<state dir>/rebuild/known-defects.md`
  instead — it does not become part of the contract. A defect in the old
  app is not something the rebuild is obligated to reproduce.

## Step 5 — Scaffold and write the documents

Copy the shipped document templates into `<state dir>/rebuild/` with:

```bash
claw-forge rebuild init-docs
```

(`init-docs` refuses to overwrite anything already there, so it is safe to
re-run.) This writes `PRD.md`, `ARCHITECTURE.md`, and
`design/{data-model,api,ui-design-system}.md`, each with the required `##`
headings already in place and HTML-comment guidance under each — no claim
text yet, so `rebuild check` reports each document as having no claim lines
until you write real content in.

Fill in every required heading (this is the exact, complete list `rebuild
check` verifies — `claw_forge/rebuild/check.py`'s `REQUIRED_HEADINGS`, not a
summary of it):

- `PRD.md`: `## Product`, `## Users`, `## Capabilities`, `## User journeys`,
  `## Non-functional requirements`, `## Out of scope`, `## Open questions`
- `ARCHITECTURE.md`: `## Context`, `## As found`,
  `## Why it is not compatible`, `## Proposed architecture`,
  `## Zones and plugins`, `## Data flow`, `## Decisions`, `## Open questions`
- `design/data-model.md`: `## Entities`, `## Relationships`,
  `## Migrations`
- `design/api.md`: `## Endpoints`, `## Auth`, `## Errors`
- `design/ui-design-system.md`: `## Colours`, `## Typography`,
  `## Components`, `## Screens`

Write from what you actually read, not from habit:

- **PRD** — product, users, capabilities, user journeys (cite the contract
  journeys you just verified), non-functional requirements, out of scope.
- **ARCHITECTURE** — split *As found* from *Proposed* and do not blur them:
  *As found* is what `graph.json`/`analysis.md` actually show (hubs, cycles,
  the metrics that drove the `rebuild` verdict) — every claim here is a
  citation into the old codebase. *Proposed* is your recommendation (a
  plugin/core zone division claw-forge can run in parallel) — mark it as a
  recommendation, not a fact, and tag anything you could not ground in the
  old code `[inferred]`.
- **design/data-model.md**, **design/api.md** — entities, relationships,
  endpoints, auth, errors, cited to the old code that defines them.
- **design/ui-design-system.md** — colours, typography, components, screens
  — cited to the old app's CSS and the screenshots you just took.

### The citation rule (spec §8.3)

A **claim line** is any non-empty line outside front matter, fenced code
blocks and HTML comments that is not a heading, a table header/separator
row, or a line inside a section titled `Open questions`. Table body rows
ARE claim lines. **An untagged claim line is an error in `rebuild check`.**
Every claim line must end with one or more tags:
`[src: path:line]` or `[src: path:start-end]`,
`[shot: journeys/screenshots/…png]`, `[journey: <id>]`, or `[inferred]`.
This is the evidence rule, not a confidence score: the source gets checked,
your confidence does not.

## Step 6 — Check until clean

```bash
claw-forge rebuild check
```

Fix every reported error — a missing heading, an untagged claim, a `src:`
path or line range that does not exist in the old project, a `shot:`/
`journey:` reference with nothing behind it, or a `contract-candidates.json`
naming a journey that is not `status: pass` with real evidence. A warning
(a document's `[inferred]` share over 30%) does not have to go to zero, but
look at it — a document that is mostly guesses is not yet reviewable.
Repeat until `rebuild check` reports no errors.

## Step 7 — Stop

**Stop here.** Do not run `rebuild approve` yourself. Tell the owner:

- where the documents are (`<state dir>/rebuild/`) and that `rebuild check`
  is clean;
- to review and edit them — this is their one chance to correct the record
  before it gets hashed and locked in;
- that once they are satisfied, they run `claw-forge rebuild approve`
  themselves, which hashes every document plus the contract journeys so
  `claw-forge rebuild start <new-dir>` can refuse if anything changes
  underneath the approval.

After `rebuild approve`, `rebuild start <new-dir>` prints its own next
steps (`/create-spec`, `claw-forge plan`, `claw-forge run`,
`/verify-journeys`, `claw-forge rebuild parity`) — this command's job ends
at the stop above.
