# 4. Checking a paper is genuine

Every paper, version, review and decision on Scholium is a **signed record**. Your browser can check those signatures itself, so you do not have to trust the website that shows you the paper. This chapter explains what the checks mean and how to run them yourself.

## What is checked

When you open a paper, your browser downloads its signed records and checks:

1. **Signatures.** Every listed author signed the version, and each signature matches that author's public key.
2. **History.** Each version links to the one before it, and nothing in the chain has been changed or removed.
3. **Files.** The PDF, source, code and data files you can download are exactly the files the authors signed. Your browser fingerprints each file and compares it with the signed record.
4. **Public log.** The version is recorded in the server's public, append-only log.
5. **Notices.** Whether a retraction or correction is on record.

## The verification badge

The badge at the top of the margin panel shows the result. It has five states:

| Badge | What it means |
| --- | --- |
| **Verified** (green ✓) | Every check passed and the public timestamp is in place. |
| **Signed · anchor pending** (amber ◔) | All signatures and files check out. The public timestamp has not been added. In this release this is the **best result you will see**: anchoring is not enabled yet. With the counts known it reads, for example, "Verified · 4 author signatures across 2 versions". |
| **Checking…** | The check is running in your browser. |
| **Could not check** (grey ?) | You may be offline, or the proof is not available. **This is not a failure.** Try again later. |
| **Verification failed** (red ✕) | A file or signature does not match what the authors signed. "Do not rely on it." |

> **Why "anchor pending"?** Scholium is designed to timestamp its public log on a public blockchain every hour, so that nobody, including the server operator, can backdate a record. That is planned for a later release. Until then, every paper shows "Timestamp anchor pending: anchoring is not enabled on this node yet". Signatures and history are still fully checked.

## The Proof tab

Choose the badge or **Details ›** to open the **Proof** tab. It shows the checks as a plain-language checklist headed "Verified in your browser":

- "Signed by all 4 listed authors"
- The version history is intact
- "Files match what the authors signed (3 files)"
- "Recorded in the node's public log (entry #1234)"
- "Timestamp anchor pending: anchoring is not enabled on this node yet"
- "No retraction or correction on record"
- "Preserved: 1 of 1 local copy"

**Re-run check** runs everything again. **Technical details** shows the record identifiers for people who want them.

Two details:

- **Large files.** Your browser fingerprints up to 32 MiB of files. A file it skips shows a warning, never a pass.
- **Retracted papers** still verify. A retraction is an extra signed record, not a change to the paper, so the checklist shows "Retracted: a retraction notice applies. The signed history still verifies."

## Check a file you already have

If someone sends you a PDF and you want to know whether it is the genuine paper, use **/verify** ("Verify a file", linked in the footer).

1. Drop the file on the page, or choose **Choose a file**.
2. Your browser fingerprints it. "The file never leaves your device." Only the fingerprint is sent.
3. Scholium tells you whether the file matches a signed version:

| Result | Meaning |
| --- | --- |
| "This file matches what the authors signed" | The file is byte-for-byte a file the authors signed. The page names the paper and version. |
| "This file does not match what the authors signed" | The file differs from every signed file, or from the version you named. |
| "Could not check" | The server could not be reached. |
| "Could not read this file" | Your browser could not open the file. |

To check against one particular version, open `/verify?id=sch:k3f9-q2xz-7mwd/v2`. The **Verify a file** page checks the file's fingerprint, not the signatures. Use the paper's Proof tab or the command-line verifier for those.

## Check offline with the command-line verifier

For full independence from any Scholium server, download a paper's archive (**Download ▾ → Paper archive** on the paper page). This saves a `.car` file holding every signed record and file. Then check it with the `scholium` command-line tool:

```text
scholium verify sch-k3f9-q2xz-7mwd.car
```

The last line of the output is the verdict:

| Output | Exit code |
| --- | --- |
| `Result: VERIFIED` | 0 |
| `Result: VERIFIED (status: retracted)` | 0 |
| `Result: NOT VERIFIED (N checks failed)` | 1 |
| The tool could not run | 2 |

Other commands:

| Command | What it does |
| --- | --- |
| `scholium verify sch:k3f9-q2xz-7mwd --node https://…` | Fetch a paper's records from a server and verify them |
| `scholium verify-file paper.pdf sch:k3f9-q2xz-7mwd/v2 --archive paper.car` | Check one file against one version in an archive |
| `scholium rebuild archive.car --db rebuilt.db` | Check a whole-server archive and rebuild its paper catalogue into a fresh database |
| `scholium --version` | Print the version |

> **Getting the tool:** in this release the verifier is not published as a separate download. It ships in the Scholium source code: from a checkout, run `cd apps/api && uv run --all-packages scholium --help`.

## The whole archive

Scholium is built so that its whole public record can be copied and rebuilt by anyone. **Public export · CAR archive** in the footer (also on the **/network** page) downloads every public record on the server. Removed and unlisted content is left out. Anyone can check that archive with `scholium verify` and rebuild the catalogue from it with `scholium rebuild`.

## The network page

**/network** is the server's public transparency page:

| Card | Shows |
| --- | --- |
| This node | Operator, software version, standing, the server's own DID |
| Log head | The latest entry in the public log |
| Public timestamp | "Anchor pending" (anchoring is not enabled yet) |
| Probe pass rate | Results of availability checks, once they run |
| Replication | "1 of 1 local", against the policy target of 5 replicas, 3 operators and 2 jurisdictions |
| Moderation | Decisions so far, counted by policy clause |
| Incident log | Published incidents |
| Public export | The archive link and the commands to verify and rebuild it |
