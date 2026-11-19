# 9. Moderation, appeals and reports

Scholium does not accept or reject science. Moderators decide only whether a submission belongs on the network under published rules. Every decision cites a rule, gives a reason, is public, and can be appealed once.

## How moderation works

- Moderators are experienced members at **tier 4**, appointed by the node operator.
- Every new version, and every reported paper or post, reaches them in the moderation queue.
- Each decision **must cite a policy clause** and **must give a reason** the author will see.
- Each decision is a **public signed record**. Its banner links to the record and the clause.
- **/network** shows how many decisions have been made under each clause.

## The policy clauses

The full text is on **/policies**. Each clause has its own link, for example `/policies#MOD-02`.

| Clause | Title | In short |
| --- | --- | --- |
| MOD-01 | Out of scope | Not scholarly work, or outside every open category: reclassified if a category fits, otherwise rejected. |
| MOD-02 | Plagiarism and unattributed overlap | Overlap that is neither quoted nor cited: held for explanation, rejected or delisted if it is copying. |
| MOD-03 | Fabrication and paper mills | Fabricated results or paper-mill output is removed. |
| MOD-04 | Hostile files | Files with an active payload are rejected. |
| MOD-05 | Unlawful content | Delisted and removed. The record of its existence remains. |
| MOD-06 | Privacy and personal data | Personal data about others without a lawful basis: held for redaction, delisted if it cannot be removed. |
| MOD-07 | Unresolved misconduct allegations | May be held while a credible allegation is investigated. |
| MOD-08 | Identity and consent | Only real, consenting authors. Held until consent is signed; rejected if it cannot be. |
| MOD-09 | Spam and promotion | Advertising or link farming is rejected. |
| MOD-10 | Misclassification | Moved to the right category. Content never changes. |

Node operators can publish their own version of these clauses; the **/policies** page always shows the ones in force.

## Decisions

| Decision | Applies to | Result |
| --- | --- | --- |
| List the paper | New versions | Listed and public |
| Hold from listing | Versions | Not listed until fixed. A hold on a listed paper makes it **Contested**. |
| Reclassify to another category | Versions | Categories change; content does not |
| Reject the paper | Versions | Not listed |
| Delist the paper | Listed papers | Removed from the catalogue |
| Dismiss the flag | Reports | The report is closed with no action |
| Hide from public reads | Reported posts, annotations and reviews | Hidden from readers; shown as "Hidden by moderation" |
| Legal takedown (tombstone) | Any content | Files deleted; a notice of removal remains |

## For moderators: the console

Moderators find the queue at **/mod**. It lists waiting items, oldest first, with:

- the paper and its category, and how long it has waited;
- the **similarity** percentage and the number of **unresolved references**;
- the **scan result**;
- a **new account** flag for authors whose accounts are under 90 days old.

Open an item (**/mod/{id}**) to see the paper beside the decision form:

1. Choose the action.
2. Choose the **policy clause** (required).
3. Write the **reason** ("Write the reason the author will see."). Reclassify also needs the new category.
4. Read the **Preview of what the author will see**.
5. Choose **Sign decision**. The form reminds you: "This decision is a public signed record."

Only versions that have finished co-author consent and the safety scan can be decided. Versions held by the safety scan wait for the author to submit a fixed version.

## Appeals

If moderation holds or rejects your paper, you can ask for a fresh look from a panel of your peers.

**Who can appeal:** an author of the paper (the person who submitted it, the signer of a version, or a co-author who accepted). For a hidden post or review, its author.

**Your own hidden posts.** Other readers see only the placeholder, but you see "Your post was hidden: {reason}." with the start of your post, **Show my post** to read all of it, and the appeal control beside it. That way you can tell which post was hidden.

**How often:** **once per decision**. One appeal covers all the co-authors, so agree among yourselves before filing.

**How to appeal:**

1. On your paper page, choose **File an appeal**. It appears when the latest decision is a hold or a rejection.
2. Explain your grounds. They are required.
3. The page shows "Appeal filed on {date} — awaiting panel."

### The appeal panel

- Three members at tier 3 or tier 4 form the panel.
- These people are excluded: the moderator who decided, you, every author of the paper, the author of the decided item, and anyone who reported it.
- The server draws the panel by a fixed procedure, so no one can hand-pick it.
- The panel has **14 days** to vote.

Each panel member votes one of:

| Vote | Meaning |
| --- | --- |
| Uphold the decision | The decision stands. |
| Overturn the decision | The decision is reversed and the paper returns to its earlier state automatically. |
| Modify the decision | A different decision is needed; moderators act on it. |
| Send it back to the moderators | Moderators look at it again. |

**Two matching votes decide.** The outcome is a public signed record with the panel's reasons. You are notified, for example "The appeal panel upheld the decision to…", or with an **Appeal outcome** notice when it is overturned.

**If there are not enough eligible members**, the appeal shows "panel not yet formed". Scholium tries again every day, and whenever someone new becomes eligible. After the deadline, an uninvolved moderator may decide the appeal without a panel.

### If you are on a panel

Panel duties appear in **Needs your attention** on your dashboard. Read the decision, the paper and the grounds, then vote with a reason. Your reason is published.

## Reporting content

Any signed-in member can report a paper or a discussion post with **Report** (**⚑ Report** on posts).

| Reporting a… | Reasons offered |
| --- | --- |
| Paper | Research misconduct · Plagiarism · Duplicated figures · Spam or advertising · Off topic · Something else |
| Post | Spam or advertising · Harassment or abuse · Off topic · Misleading or false · Legal problem · Something else |

After reporting you see "Reported" and "A moderator reviews every report. You will be told what was decided." When a moderator decides, you get a notice of the outcome with the moderator's note, for example that the paper "was reviewed and kept listed."

Reports are private: only you and the moderators can read yours.

## Legal removal

When content must be removed for legal reasons, a moderator issues a **legal takedown**. The files are deleted and can no longer be downloaded. The paper page shows "Content removed for legal reasons … The record of its existence remains." The signed history still verifies, so the network's record stays complete and honest about what was removed.
