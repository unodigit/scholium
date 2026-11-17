# Paper discussion (the Discussion tab)

`DiscussionTab` is the Discussion tab of the paper page (`docs/design.md`
§5.2): threads **ordered by helpful votes**, a **reply form** and a **Report**
action on **every** post. The paper page mounts it in its 360 px margin panel;
`/discussion/{id}[/v{n}]` shows it on a page of its own.

```tsx
import { DiscussionTab } from "@/features/paper-discussion";

<DiscussionTab paperId="sch:6sel-2dio-orm6" versionCid={version.cid} />
```

```text
5 posts · most helpful first
[Start a thread]
did:key:z6Mkalic…AAAAAA                              5 Jan 2026
The proof of Lemma 2 skips the case n = 0.
4 members found this helpful
[Mark helpful] [Reply] [⚑ Report]
  └ did:key:z6Mkbob…BBBBBB                           7 Jan 2026
    Good catch, fixed in v2.
    [Mark helpful] [Reply] [⚑ Report]
```

## Order

**Most helpful first, then oldest first**, with the server's arrival order
breaking a tie — the same key the API sorts by (`discussion` plugin,
`_sort_key`). It applies at every level: replies are ordered among themselves
the same way.

The tab sorts again itself (`orderThreads`) rather than trusting the order it
was handed, so a server answer, a stale `initial` and an optimistic update
cannot leave the list out of order. A post this browser has just signed has no
arrival order yet and sorts after posts from the same second, which is where
the server will put it.

A helpful mark **only orders the thread**. It is about usefulness, never about
the paper, and the API guarantees it cannot change `papers.status`
(`docs/PRD.md` REV-1).

## Every post has Reply and Report

A reply is a post, so replies carry both actions too. Each button's accessible
name includes the author ("Report post by did:key:z6Mk…"), so a list of twenty
buttons is not twenty identical "Report"s.

| Action | Call | Needs |
| --- | --- | --- |
| Start a thread / Reply | sign a `discussion.post`, `POST /v1/papers/{id}/threads` | signed in, tier 1 |
| Mark helpful | `POST /v1/posts/{cid}/helpful` (`201`; a repeat is `409`) | signed in, tier 1 |
| Report | `POST /v1/flags` `{ target: <post cid>, reason: <category> }` | signed in |

Signed-out readers can read everything. Where a form would be, they are told to
sign in (`/signin?next=…`, back to the paper page unless `signInHref` says
otherwise). The buttons are always present, so the action is findable; pressing
one says what to do.

### Posting is signing

A thread or reply is a `discussion.post` record, signed on this device behind a
passkey prompt (`signRecord` from `web-auth`) and then submitted:

```json
{
  "type": "discussion.post",
  "prev": null,
  "body": {
    "target": "<version cid | genesis cid | the parent's target>",
    "anchor": "<same as target>",
    "text": "…",
    "parent": "<parent post cid | null>"
  }
}
```

- `prev` is `null`: a post starts its own chain.
- `target` is, in order: the **parent's** target (a reply is about what its
  parent is about), then the `versionCid` the paper page passes, then the
  paper's genesis cid from the thread list. With none of them the tab refuses
  to sign and says so, rather than sending a record that cannot be attached.
- `anchor` is the target itself: a post about the whole paper, not a paragraph.
  Paragraph annotations are feature 150.
- The signed record is checked (right `type`, `prev` is `null`) **before**
  anything is sent, so a broken signer cannot post something the reader did not
  write. Text is trimmed, must be non-empty and at most 4 000 characters.

The form says **Sign and submit** and, under it, "You're signing with your
passkey. Scholium never sees your key." (`docs/design.md` §8). While the prompt
is open the form is disabled, so one tap cannot post twice.

### After an action

The tab trusts the server's answer and updates in place; it does **not**
re-fetch the thread list. A new post appears at once (under its parent, or as a
thread), a helpful mark re-orders at once using the server's new count, and a
reported post shows "Reported". Other people's new posts arrive with the next
load. (Re-fetching in the background would race with the reader's own next
action and could briefly drop a post they had just made.)

### Failures are words, and say whether anything was sent

`describeActionError` turns every failure into one sentence:

- a dismissed passkey prompt is a choice: "Signing was cancelled, so nothing was
  sent." — what the reader typed stays;
- no device key, a failed passkey, an invalid record;
- `401` — "Your session has ended" with a **Sign in** link;
- `403` — the trust level (tier 1) for posting and voting; a plain refusal for a
  report;
- `409` on a helpful mark — "You have already marked this post helpful." This is
  information, not an error (`role="status"`), and the button becomes "Marked
  helpful";
- `422` — the server's own `detail`;
- `429` — "You are going too fast. Try again in 2 minutes." from `Retry-After`
  (`docs/design.md` §11: rate-limit feedback is explicit);
- a lost connection, and anything unknown.

Nothing reads like a stack trace, and no action message echoes an unexpected
`Error`'s text (only the server's own `detail` on a `422`).

### Report

A fieldset of reasons — **none chosen for the reader** — and **Send report**:

| Reason (`id`) | Label |
| --- | --- |
| `spam` | Spam or advertising |
| `abuse` | Harassment or abuse |
| `off-topic` | Off topic |
| `misleading` | Misleading or false |
| `legal` | Legal problem |
| `other` | Something else |

`POST /v1/flags` accepts any non-empty `reason`; this list is this feature's
own. A report with no reason is refused in words before anything is sent. Once
filed the card says "You reported this post as “…”. A moderator will review it,
and you will be told what was decided." — the reporter is notified when the flag
is decided (`flags` plugin, `flag.outcome`), with the outcome in words and a
link to the item, which is how "the reporter sees the outcome"
(`docs/design.md` §11) is met without polling.

## Where the data comes from

`GET /v1/papers/{id}/threads` (feature 99), through the shared API client:

```json
{
  "paper": "sch:6sel-2dio-orm6",
  "paper_cid": "bafyrei…",
  "count": 3,
  "threads": [
    { "post_cid": "bafyrei…", "author": "did:key:…", "text": "…", "helpful": 2,
      "created": "2026-01-02T03:04:05Z", "seq": 7, "target": "bafyrei…",
      "parent_cid": null, "anchor": "bafyrei…", "replies": [ … ] }
  ]
}
```

`/discussion/…` fetches it on the server and passes it as `initial`, so the
first HTML already has the discussion, in order, with every Reply and Report.
A failed read is handed down as `initialError`: the tab says what happened and
offers **Try again**, which fetches in the browser. It does **not** retry by
itself on hydration, so the message the server reported is not replaced by a
spinner. Hosts without server data can leave both out; the tab loads on mount.

The server read is anonymous, so it cannot apply the reader's mutes (feature
102: the API leaves out posts by DIDs the caller has muted when the request
carries a valid token). A tab that loads in the browser sends the stored token
and gets them.

`/discussion/…` also reads the version list (`GET /v1/papers/{id}/versions`,
through `paper-meta`) to find the record id of the version in the URL (else the
newest), which is where new threads attach. If that read fails the page still
works and threads attach to the paper itself.

### Reading a node's answer

`parseThreads` accepts the API's camelCase and snake_case spellings, and:

- a body that is not a thread list is an **error**, never an empty tab —
  "nobody has posted" would be a lie when the truth is "we don't know";
- one unreadable post (no id) is **dropped**, so a single bad row cannot take
  the tab down; a post listed twice is shown once;
- a post whose text is held elsewhere (`textCid`) says so rather than showing a
  blank;
- an annotation (feature 150) shows the passage it quotes;
- nesting is bounded (64 levels), so a hostile answer cannot overflow the stack;
- text is rendered as **text**, with the reader's line breaks and never as
  HTML or Markdown.

## Accessibility

- Every post's actions are real buttons in a labelled group, at least 44 px
  tall; Reply and Report are `aria-expanded` and name the panel they open.
- Focus is kept: a reply form takes focus when it opens and returns it to Reply
  when it closes; after a helpful mark moves a post, focus lands on that post;
  after a report, on the confirmation.
- A problem is words in a `role="alert"` with a `--critical` rule beside it,
  never colour alone; status colour is on icons and borders, never on text (the
  4.5:1 rule in `src/styles/README.md`).
- A polite live region announces "Your reply was posted.", "Marked helpful…",
  "Reported…".
- The textarea has a real `<label>`; its count, hint and problem are tied to it
  with `aria-describedby`.
- Spinners stop under `prefers-reduced-motion`; forced-colours maps icons,
  links and borders to system colours.
- Replies nest but stop indenting after four levels: a 360 px panel has no room
  for a staircase.

## Not here

- **Muting** (feature 102, `POST /v1/me/mutes`) has no control yet; the API
  already honours a mute when the tab loads in the browser.
- **Margin markers and creating an annotation with `A`** are feature 150. The
  tab already shows an annotation's quote when the API returns one.
- **Refresh**: the tab does not poll. Reload to see others' posts.

## Files

| File | Responsibility |
| --- | --- |
| `discussion-tab.tsx` | The tab: loading and retry, ordering, the optimistic updates, Start a thread. |
| `post-card.tsx` | One post and its replies: author, text, helpful, Reply, Report, focus. |
| `compose-form.tsx` | The textarea and **Sign and submit**, for a thread or a reply. |
| `report-panel.tsx` | The reasons fieldset and **Send report**. |
| `notes.tsx` | `FailureText` and `SignInNote`, said the same way everywhere. |
| `flag-icon.tsx` | The Report glyph (the shared icon set has no flag). |
| `discussion.ts` | Wire shapes, parsers, order, tree updates, endpoints, loaders, sign/submit, helpful, report, error words and formats. Pure. |
| `paper-discussion.css` | Styles; every value is a design token, prefixed `pd-`. |
| `index.ts` | Public surface for the paper page. |
| `*.test.ts(x)` | Parsers, order, actions and error words; the tab (including SSR); the route; the CSS contract. |
| `app/(paper-discussion)/layout.tsx`, `discussion.css` | Global nav + page shell for `/discussion/…`. |
| `app/(paper-discussion)/discussion/[...ref]/page.tsx` | The `/discussion/{id}[/v{n}]` route: metadata, ref parsing, server fetch, bad-id notice. |
