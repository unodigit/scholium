# The Scholium Handbook

This handbook explains how Scholium works and how to use it, for readers, authors, reviewers and moderators. It describes the first release (Phase 1, the community pilot) as built.

Operators who run a Scholium server should read [`docs/deploy.md`](../deploy.md) instead.

## Chapters

| # | Chapter | Read it if you want to… |
| --- | --- | --- |
| 1 | [How Scholium works](01-how-scholium-works.md) | Understand the ideas, the roles and the life of a paper |
| 2 | [Your account](02-your-account.md) | Sign in, set up your account, move up the trust tiers, protect your account |
| 3 | [Reading and finding papers](03-reading-and-finding-papers.md) | Browse, search, follow, read and cite |
| 4 | [Checking a paper is genuine](04-checking-a-paper-is-genuine.md) | Understand the Verified badge and check files yourself |
| 5 | [Publishing a paper](05-publishing-a-paper.md) | Submit a paper, get co-author consent, through moderation to listing |
| 6 | [Reviewing a paper](06-reviewing-a-paper.md) | Write a formal review; understand how status is decided |
| 7 | [Discussion and annotations](07-discussion-and-annotations.md) | Comment on papers and annotate paragraphs |
| 8 | [AI pre-review](08-ai-pre-review.md) | Read and respond to the advisory AI report |
| 9 | [Moderation, appeals and reports](09-moderation-appeals-and-reports.md) | Understand decisions, appeal one, report content, moderate |
| 10 | [FAQ and known limitations](10-faq-and-known-limitations.md) | Find quick answers and what this release cannot do yet |
| 11 | [Glossary](11-glossary.md) | Look up a term |

## Quick start by role

### I want to read papers

1. Open **Papers** (**/papers**), or **Browse papers** on the home page. No account is needed.
2. Search by keywords, or paste a `sch:` ID to jump straight to a paper.
3. On a paper, check the badge at the top of the margin. **Signed · anchor pending** means the paper verified ([why "pending"](04-checking-a-paper-is-genuine.md#the-verification-badge)).
4. Read the **Reviews** tab for peer review and the **AI** tab for the advisory pre-review.
5. Use **Cite** for BibTeX or RIS.

### I want to publish my first paper

1. **Sign in** with a passkey on the device you will keep using ([2](02-your-account.md#sign-in-with-a-passkey)).
2. In onboarding, add your name and email, **confirm your email** and **link ORCID**, in either order. Now you are tier 1 ([2](02-your-account.md#link-your-orcid-id)).
3. **Set your five recovery guardians** ([2](02-your-account.md#recovery-guardians)).
4. **Get endorsed** in each category you will publish in. Send your profile link to a reviewer in that category ([2](02-your-account.md#endorsements)).
5. **Collect your co-authors' DIDs.** Each co-author needs a Scholium account.
6. Run the **submit wizard**: Files → Details → Authors → Checks → Sign ([5](05-publishing-a-paper.md#the-submit-wizard)).
7. **Sign your own consent**, and make sure every co-author signs theirs.
8. Wait for **moderation** (target 48 hours). Once listed, share your `sch:` ID.

### A colleague listed me as a co-author

1. Open the consent link from your email or notifications (`/consent/…`).
2. Read the details and choose **Accept authorship** or **Decline authorship**. Your answer is final ([5](05-publishing-a-paper.md#co-author-consent)).

### I am a reviewer

1. On the paper's **Reviews** tab choose **Review this paper**. Check the conflict results honestly.
2. Fill all six rubric dimensions with justifications, your confidence and a recommendation.
3. **Commit review**. It stays sealed. **Export your review key file.**
4. Come back when a second review is committed or 21 days have passed, and choose **Reveal review** ([6](06-reviewing-a-paper.md)).

### I am a moderator

1. Open **/mod** and work through the queue, oldest first.
2. For each item choose an action, a policy clause and a reason the author will see, then **Sign decision** ([9](09-moderation-appeals-and-reports.md#for-moderators-the-console)).

### I lost my device

Go to **/recover**, enter your ORCID iD and choose **Start recovery**. Ask your guardians to approve ([2](02-your-account.md#recover-a-lost-account)).

## How this handbook is kept accurate

Every statement in this handbook was checked against the application code at the time of writing (November 2026), not against design documents. Where the product differs from `docs/PRD.md` or `docs/design.md`, the handbook describes the product. When a feature changes, update the chapter that describes it in the same change.
