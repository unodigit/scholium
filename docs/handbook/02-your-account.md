# 2. Your account

This chapter covers signing in, setting up your account, the trust tiers that decide what you can do, and how to protect your account if you lose your device.

## Sign in with a passkey

Go to **/signin** and choose **Sign in with passkey**.

- **Your first sign-in creates your account.** Your browser makes a signing key on your device and protects it with a passkey (Face ID, Touch ID, Windows Hello or a security key). The key cannot be copied out of the browser, and Scholium never sees it. The page says so: "Use your passkey to sign in. Scholium never sees your key."
- **Your account's public identifier is a DID**, a string that starts with `did:key:`. It appears on your public profile and in every record you sign. You will need it when people endorse you or name you as a recovery guardian.
- **New accounts go to onboarding** (next section). Returning users go back to the page they came from, or to the paper list (**/papers**).

> **Use one browser on one device.** In this release an account belongs to the browser and device where you created it. There is no "add a device" feature yet. Signing in from a different browser or computer creates a separate, new account.

### How long you stay signed in

You stay signed in for 30 days, and every visit restarts the 30 days. **Sign out** in the navigation bar ends the session in this browser only.

### If sign-in fails

| Message | What it means | What to do |
| --- | --- | --- |
| "Scholium couldn't verify that sign-in. Please try again." | The signature check failed, or the sign-in took longer than 5 minutes. | Try again. |
| "Too many attempts. Wait a moment and try again." | Too many sign-in attempts from your network. | Wait a few minutes. |
| "Lost your device? Recover your account" | This link is always shown on the sign-in page. | See [Recover a lost account](#recover-a-lost-account). |

## Set up your account (onboarding)

After your first sign-in, **/onboarding** walks you through five steps:

| Step | What you do | Required? |
| --- | --- | --- |
| 1. Create your passkey | Done automatically when you signed in. | — |
| 2. Add your name | Name (required), affiliation (optional), email (required). Your email is "used to verify your account. It is never shown on your public profile." | Yes |
| 3. Link your ORCID iD | Connect your ORCID record. | Needed for tier 1 |
| 4. Pick categories to follow | Their new papers appear in your **Following** feed and daily digest. | No |
| 5. Set recovery guardians | Name five people who can help you recover your account. | Strongly recommended |

The **Start reading Scholium** button stays disabled until you save your guardians. **Skip for now** is always available, and you can come back to `/onboarding` later. Without guardians you cannot recover your account if you lose this device.

Your onboarding progress is saved in this browser only. **To change your name, affiliation or email later, go back to `/onboarding`.** It is the only place in this release where you can edit your profile.

## Confirm your email

When you save your profile, Scholium emails you a confirmation link.

- The link is valid for **24 hours**. If it expires you will see "The email verification link is invalid or has expired." Use **Resend verification email** to get a new one.
- Until you confirm, your dashboard shows "Confirm your email address."
- If you change your email address, you must confirm the new one.

## Link your ORCID iD

Linking ORCID proves who you are as a researcher. It gives you:

- the step up to **tier 1 (Member)**, together with a confirmed email;
- a **✓ ORCID** chip on your public profile;
- the only way to **recover your account** if you lose your device.

Rules:

- One ORCID iD can belong to one Scholium account only.
- You cannot unlink or re-link an ORCID iD in this release.
- You have 10 minutes to finish the round trip to orcid.org.

> **Tier 1 needs both steps, in either order.** You move to tier 1 as soon as your email is confirmed and your ORCID iD is linked, whichever you finish last.

## Trust tiers

Every account has a trust tier from 0 to 4. Each tier adds to the one below it.

| Tier | Name | What it adds | How you get it |
| --- | --- | --- | --- |
| 0 | Reader | Read everything; report content; appeal decisions on your papers; sign co-author consents | Your first sign-in |
| 1 | Member | Post in discussions; annotate paragraphs; vote posts helpful; upload files | Confirmed email **and** linked ORCID iD |
| 2 | Author | Start papers and publish new versions; rebut AI findings on your papers | Receive an endorsement in any category |
| 3 | Reviewer | Write formal reviews; rate review quality; mark AI findings confirmed or wrong; endorse authors | Granted by the node operator |
| 4 | Moderator | Moderation queue and decisions; import papers from arXiv; endorse in any category | Granted by the node operator |

If you try something your tier does not allow, Scholium tells you exactly what is missing, for example: "This action requires tier 2 (Author) or higher; the caller is tier 1 (Member)." A tier change takes effect within 15 minutes, the next time your session refreshes.

**Two more rules for authors:**

- To submit a paper you need an active endorsement in **every category the paper lists**, whatever your tier.
- An author account younger than 90 days can start **one new paper per 7 days**. New versions of an existing paper do not count toward this.

> **For node operators:** tiers 3 and 4 are set from the command line: `python -m app.modules.admin set-tier <did> <0-4 | reader | member | author | reviewer | moderator>`. See `docs/deploy.md`.

## Endorsements

An endorsement is a signed statement from an experienced member that you may publish in a category. It is how you reach tier 2.

**Who can endorse you:**

- a **reviewer (tier 3)** who is endorsed in that same category, or
- a **moderator (tier 4)**, in any category.

**How to ask for one:**

1. Open your dashboard (**/me**). On the **Credentials** card, choose **View public profile**.
2. Send that profile link to someone who can endorse you.
3. They open it and choose **Endorse in {category}**. The button only appears for people allowed to endorse.

One endorsement, in any category, moves you to tier 2. Each category you want to publish in needs its own endorsement.

## Daily limits

Every account can write (post, submit, review, vote and so on) a limited number of times in any rolling 24 hours. Only accepted writes count.

| Account | Writes per 24 hours |
| --- | --- |
| Any account younger than 90 days | 20 |
| Tier 0 Reader | 20 |
| Tier 1 Member | 100 |
| Tier 2 Author | 200 |
| Tier 3 Reviewer | 300 |
| Tier 4 Moderator | 1,000 |

When you reach the limit, Scholium tells you when you can write again, for example "New accounts can write 20 times a day, and that is used up. Try again in 3 hours 12 minutes." Some screens show a shorter message such as "You are going too fast."

## Recovery guardians

Because your key lives on one device, losing that device would mean losing your account. Recovery guardians prevent that.

- You name **exactly five** guardians. Each must be another Scholium account, entered by its DID. People find theirs in the address of their public profile (`/u/{DID}`), or on their dashboard **Credentials** card (the **Account** line if the card shows one, otherwise the key under "You sign with this key").
- If you lose your device, **three of the five** must approve before you get your account back.
- After the third approval there is a **72-hour safety window** before the new key takes over. Until the window ends, you can cancel a recovery you did not start (see [A recovery you did not start](#a-recovery-you-did-not-start)).

Pick five people you trust and can reach, such as colleagues, a supervisor or co-authors.

### Change your guardians

1. On **/me/security**, under **Recovery guardians**, choose **Change guardians**.
2. Replace any of the five DIDs.
3. Choose **Save guardians**. Scholium asks for your passkey: your device signs the new list with your account's key, so a stolen session alone cannot redirect your recovery.

You see "Guardians updated", and Scholium sends you a notification about the change. Once your guardians are saved, `/onboarding` shows them with a **Change them on Security** link to this page.

### Recover a lost account

1. On a new device, go to **/recover** (or **Recover your account** on the sign-in page).
2. Enter the **ORCID iD** linked to your account and choose **Start recovery**.
3. Your guardians are notified, and so is the account itself: a notification in Scholium, and an email if the account's email is confirmed. Each guardian opens the request on their dashboard and chooses **Approve**.
4. Use **Check for approvals** to follow progress ("2 of 3 approvals").
5. After three approvals and the 72-hour safety window, your new device holds your account.

If you see "We couldn't find an account linked to that ORCID iD", the ORCID was never linked. If you see "That account hasn't set recovery guardians yet", recovery is not possible. In both cases contact the node operator.

### A recovery you did not start

When anyone starts a recovery of your account, you get a **Recovery of your account** notification ("Someone started a recovery of your account. Unless you cancel it, it can complete after {date}."), and an email if your email is confirmed. If you did not start it:

1. Sign in and open **/me/security** (the notification links there).
2. In the **Recovery in progress** section, choose **Cancel this recovery**.

You can cancel until the 72-hour safety window ends, including after a key rotation. Also tell your guardians not to approve: without three approvals the recovery never completes.

A recovery can also be cancelled from **/recover?request={request id}** on a device that holds your passkey: choose **Cancel this recovery**, which asks for your passkey.

> **Known issue:** while a recovery of your own account is open, your dashboard also lists it as if you were a guardian: "Approve the recovery of {your name}" under **Needs your attention**, and an entry under **Recovery requests** on `/me/security`. Do not approve it. Cancel it as described above.

### If you are someone's guardian

A recovery request appears in **Needs your attention** on your dashboard and as a notification. Open it at `/me/recovery/{id}`. Approve only if you have confirmed with the person, by a channel you trust, that they really lost their device.

## Security settings

**/me/security** has these sections:

| Section | What it does |
| --- | --- |
| Devices | Shows the key held by this device. |
| Recovery in progress | Appears only while someone is recovering your account. **Cancel this recovery** stops it. |
| Recovery guardians | Shows your five guardians. **Change guardians** replaces them (see [Change your guardians](#change-your-guardians)). |
| Recovery requests | Recovery requests waiting for your approval as someone's guardian. |
| Key rotation | **Rotate key** replaces your signing key. It asks for your passkey twice, signs you out everywhere else, and "can't be undone". Afterwards Scholium takes you to sign-in: "Your key was rotated. Sign in with this device to continue." Your account, DID and tier stay the same. |
| Erase my profile | Removes your personal details (see below). |

## Your public profile

Your profile is at **/u/{your DID}**. It shows your name (or a short form of your DID), affiliation, ORCID chip, trust tier, your DID with a copy button, your endorsements, your papers and your **Signed reviews** (each names the paper and version, with its recommendation and confidence). Your email is never shown.

## Erase your profile

Choose **Erase my profile** on `/me/security`. Scholium asks "Erase your profile?" and says what is erased and what stays. Choose **Erase my profile** again to erase, or **Cancel**. Erasure can't be undone.

| Erased | Kept |
| --- | --- |
| Your name, affiliation and email (the key that decrypts them is destroyed) | Your account, DID and trust tier |
| Your email confirmation | Your signed reviews and other records |
| | Your ORCID link (hidden on your profile, but recovery still works) |

After erasure your profile says "This profile has been erased." and your name is replaced by a short form of your DID wherever it appears. The erasure itself is recorded in the public log.

Names and ORCID iDs typed into a paper's author list are part of that paper's signed record. Erasing your profile does not remove them. If you later save your profile again at `/onboarding`, it shows the details you enter then; the erased ones cannot be brought back.

## Your dashboard

**/me** collects everything that concerns you:

| Card | Contents |
| --- | --- |
| Needs your attention | Consents to sign, review invitations, author replies, moderation outcomes, appeal panels you sit on, email confirmation, recovery requests where you are a guardian |
| My papers | Your papers and their status |
| My reviews | Your reviews: sealed, revealed or awaiting a reply |
| Saved searches | Searches you saved from the search page. **Delete** removes one. |
| Credentials | The key you sign with ("You sign with this key"), your **Account** DID if you have rotated your key, your ORCID iD and **View public profile** |
| Security | Link to `/me/security` |
| Notifications | Your notifications (the bell in the navigation bar opens this) |
| Follows | Categories you follow |
