# 10. FAQ and known limitations

## Frequently asked questions

### Is Scholium free?

Yes, free to read and free to publish.

### Is Scholium a journal? Does listing mean my paper is accepted?

No. Scholium lists, reviews and badges papers. Listing means a moderator found the submission in scope and within the policies, not that the science is correct. Formal reviews, shown openly next to the paper, are where the work is judged.

### Can I post a paper that is also on arXiv, or submit it to a journal?

Cross-posting is expected. Choose a licence your target journal accepts; the licence picker says which ones most journals accept ([Chapter 5](05-publishing-a-paper.md#step-2-details)).

### Can I change my paper after it is published?

Not the version itself: a signed version is permanent. Publish a **new version** with a change note. Every earlier version stays available.

### Can I delete my paper?

No. Scholium keeps a permanent record. You can issue a **withdrawal** or **retraction** notice, which is shown alongside the paper. Content that must be removed for legal reasons is taken down by a moderator; a notice of its removal remains.

### Why does every paper say "anchor pending"?

Public blockchain timestamps are planned for a later release. Signatures, history and files are still checked in full. "Signed · anchor pending" is the best result in this release and is not a warning.

### My badge says "Could not check". Is the paper fake?

No. It means your browser could not finish the check, usually because you are offline or the server is busy. Choose **Re-run check** later. Only **Verification failed** (red ✕) means something does not match.

### Who can see my email address?

Nobody else. It is used to confirm your account and send you emails, and it is never shown on your profile. Your name, affiliation and email are stored encrypted, and you can erase them ([Chapter 2](02-your-account.md#erase-your-profile)).

### Will authors know who reviewed their paper?

Not if you review anonymously, the default. Your review appears as "Reviewer A", and your identity is held in escrow for misconduct cases only. If you choose **Sign with my name instead**, your review is listed on your public profile.

### Why can't I see the reviews on a paper yet?

Reviews are sealed until a second reviewer commits or 21 days pass, and then each reviewer reveals their own. The Reviews tab says when a report is still sealed.

### Does the AI pre-review affect my paper's status?

No. It is advisory only and there is no path from AI output to status. You can rebut any finding.

### I lost my phone or laptop. What do I do?

Go to **/recover** on a new device and start recovery with your ORCID iD. Three of your five guardians must approve, then there is a 72-hour safety window ([Chapter 2](02-your-account.md#recover-a-lost-account)). Without a linked ORCID iD and saved guardians, recovery is not possible, so set both up early.

### How do I become a reviewer or moderator?

Tiers 3 and 4 are granted by the node operator. Contact them.

### What emails will I get?

Email confirmation, co-author consent requests, the daily digest, and the notice that someone started a recovery of your account (if your email is confirmed). Everything else, including moderation outcomes, report outcomes, appeal notices and recovery requests you are asked to approve as a guardian, appears as a notification in Scholium (the bell, or **/me**).

## Known limitations in this release

These are deliberate limits of the first release. Plan around them.

**Accounts**

- **One browser, one account.** You cannot add a second device. Signing in from another browser creates a new, separate account.
- **Profile editing** is only available at `/onboarding`.
- **ORCID** cannot be unlinked or re-linked.

**Publishing**

- **Co-authors** must be added by their DID. Lookup by ORCID iD or email is not available yet.
- **Submission drafts** are saved in your browser only, not on the server.
- **The abstract** is not read from your file; paste it in.
- **Claiming** a paper imported from arXiv is not available yet.

**Reviewing**

- Review drafts cannot be saved; complete the form in one sitting.
- **Revealing** is manual. Come back and choose **Reveal review** when the gate opens.
- **Your review key** lives in the browser where you committed. Export the review key file if you might switch browsers.
- **Invitations** cannot be accepted or declined.
- **Review ratings** are recorded but not yet used for anything.

**Discussion**

- Posts cannot be edited or deleted, and helpful votes cannot be withdrawn.
- There is no blocking, and no muting from the web app.
- Annotations attach to a whole paragraph and do not carry over to new versions.

**Network**

- Public timestamps (anchoring) are not enabled: every paper shows **anchor pending**.
- Each server keeps one local copy of each paper; multi-operator replication comes later.

## Known issues

None at the moment. Known gaps that are deliberate are listed under [Known limitations in this release](#known-limitations-in-this-release).
