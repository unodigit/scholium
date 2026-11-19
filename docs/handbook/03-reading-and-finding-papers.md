# 3. Reading and finding papers

Anyone can read Scholium without an account. This chapter covers the feed, search, following categories, the paper page and citing.

## The home feed

The home page (**/**) lists papers with three tabs:

| Tab | Shows |
| --- | --- |
| Latest | Newly listed papers |
| Reviewed | Papers whose status is **Reviewed** |
| Following | Papers in categories you follow (sign in first) |

Sort by **Newest**, **Recently reviewed** or **Recently updated**, and filter by category. Load more with **Show more papers**.

Each row shows the title, authors, categories, version (`v2`), age, the first two lines of the abstract and one **status chip**. There are no like counts, vote counts or popularity rankings anywhere on Scholium. Quality is shown by reviews, not popularity.

### Status chips

| Chip | Meaning |
| --- | --- |
| Preprint | Listed, no formal reviews yet |
| Under review | At least one formal review has been committed |
| Reviewed | Two or more reviewers have published reviews, and every one is positive |
| Contested | A reviewer judged it fundamentally flawed, or a moderator put it on hold |
| Corrected | The authors or a moderator issued a correction notice |
| Retracted | A retraction notice is on record |

Chapter 6 explains [exactly how status is worked out](06-reviewing-a-paper.md#how-paper-status-is-decided).

## Categories

Papers are filed under arXiv-style categories such as `cs.LG` (Machine learning). Authors choose from 23 categories in seven fields; the [full list is in Chapter 5](05-publishing-a-paper.md#step-2-details).

The **Categories** menu in the navigation bar lists the three launch categories:

| ID | Name |
| --- | --- |
| `cs.AI` | Artificial Intelligence |
| `cs.LG` | Machine Learning |
| `cs.MA` | Multiagent Systems |

Every category with papers has a page at `/c/{id}`, for example `/c/stat.ML`. A category page lists its papers and has a **+ Follow** button and an **Atom feed** link.

## Search

Use the search field in the navigation bar, or go to **/search**.

- **Keyword search** (the default) matches every word you type in titles, abstracts and full text. There is no special syntax: quotes and wildcards are treated as ordinary characters.
- **Semantic search**: switch the toggle from **Keyword** to **Semantic** to find papers by related wording. Filters are not available in this mode.
- **Jump straight to a paper**: type a Scholium ID such as `sch:k3f9-q2xz-7mwd` or `sch:k3f9-q2xz-7mwd/v2` and Scholium opens that paper.

Narrow keyword results with the filters on the left:

| Filter | Options |
| --- | --- |
| Category | Each category, with a count |
| Date listed | From and To dates |
| Status | Each status, with a count |
| Code | **Code available** shows only papers with a code bundle |

### Save a search

Choose **Save this search** on the results page. Your saved searches are listed on your dashboard, and new matches arrive in your daily digest. In this release every saved search is included in the digest, whether or not you tick **Email me new matches in the daily digest**.

## Following and the daily digest

Follow a category with **+ Follow** on its page or during onboarding. Its new papers then appear in your **Following** tab.

Once a day (06:00 UTC), Scholium emails a digest of new papers in the categories you follow and new matches for your saved searches. It covers up to 50 papers from the last 7 days. You receive it only if your email address is confirmed, and only on days when there is something new.

## Atom and JSON feeds

Every category has a machine-readable feed for feed readers and scripts:

- Atom: `{API}/v1/feeds/cs.AI`
- JSON Feed: `{API}/v1/feeds/cs.AI?format=json`
- Add `&limit=` with a number from 1 to 100 (default 50).

`{API}` is the address of your Scholium server's API. Feed readers can also find the Atom feed automatically from the category page.

## The paper page

A paper lives at **/p/{id}**, for example `/p/k3f9-q2xz-7mwd`. That address always shows the newest version. A specific version is at `/p/{id}/v{n}`.

### The header

- **Back link** to the paper's main category, the **title**, and the **authors** (each links to their profile).
- The **status chip**, the version (`v2 of 2`), and the **licence**.
- Actions: **PDF**, **HTML**, **Cite**, **Download ▾**, **+ Follow** and **Report**.
- Authors of the paper also see **Invite reviewer**, **New version**, **Issue notice** and, after a moderation hold or rejection, **File an appeal**.

### Banners

A full-width banner above the title tells you when something important applies:

| Banner | Text |
| --- | --- |
| Retracted | "A retraction notice is on record. Every version carries it." |
| Corrected | "A correction notice is on record." |
| Newer version | "You are reading an older version. The newest is v3." with **Go to v3** |
| Removed | "Content removed for legal reasons … The record of its existence remains." |

Each banner links to **View record** (the signed record behind it) and, where one applies, the policy clause.

### Reading the paper

- **HTML** is the default reading view. Mathematics is typeset and also available to screen readers.
- **PDF** shows the PDF inside the page. On phones the PDF opens in your device's own viewer.

### The margin

Beside the text (or below it, on smaller screens) is the margin panel. At its top are the **verification badge** and **Details ›**, the paper's **ID** (click to copy) and the timestamp line. Below them are six tabs:

| Tab | What it shows | Chapter |
| --- | --- | --- |
| Reviews | Formal peer reviews, rubric scores, author replies | [6](06-reviewing-a-paper.md) |
| AI | The advisory AI pre-review | [8](08-ai-pre-review.md) |
| Discussion | Open discussion threads and paragraph annotations | [7](07-discussion-and-annotations.md) |
| Versions | Every version with its change note and **Compare** links | below |
| Files | PDF, source, code and data files with size, licence and scan status | below |
| Proof | The verification checklist | [4](04-checking-a-paper-is-genuine.md) |

Each tab has its own address, so you can link to it: add `#reviews`, `#ai`, `#discussion`, `#versions`, `#files` or `#proof` to the paper's address. Each tab is also available as a page of its own, for example `/reviews/{id}`, `/ai/{id}`, `/discussion/{id}`, `/meta/{id}` (versions and files) and `/proof/{id}`.

### Versions and comparing them

Papers are never edited after they are published. Authors publish a **new version** instead, and every earlier version stays available at its own address.

The **Versions** tab lists every version with its change note. Mark **Viewing** shows the one you are reading and **Latest** the newest. Choose **Compare vA with vB** to see what changed, or go to `/p/{id}/compare/1..2`.

### Files and downloads

The **Files** tab lists each file with its role, size, licence and safety scan result: **Scan passed**, **Scanning**, **Scan failed**, **Not available** or **Scan unknown**. You can only download a file whose scan passed. Others explain why, for example "Download opens when the scan finishes."

## Cite a paper

Choose **Cite** to open "Cite this paper", with **BibTeX** and **RIS** versions. Each has **Copy** and a download button. Citations of a retracted paper include a retraction note.

## Download the paper archive

**Download ▾ → Paper archive** saves a `.car` file containing every version, file and signed record of the paper. Anyone can check it offline with the Scholium verifier, without trusting this website. See [Chapter 4](04-checking-a-paper-is-genuine.md#check-offline-with-the-command-line-verifier).

## Keyboard and accessibility

| Where | Keys |
| --- | --- |
| Paper text | Move to a paragraph with Tab and press **A** to annotate it |
| Margin tabs | Arrow keys, Home and End move between tabs |
| Download menu | Enter, Space or arrow keys open it; Escape closes it |
| Dialogs and menus | Escape closes them |

Status is always shown with an icon and a word, never by colour alone. The site follows your system's dark mode and reduced-motion settings. The feed, search, category pages and paper header work without JavaScript.
