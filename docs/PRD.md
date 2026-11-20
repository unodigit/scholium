# Scholium — Product Requirements Document (PRD)

| | |
| --- | --- |
| Product | **Scholium** (network: *Scholium Network*; operator brand: NextGenius) |
| Document | PRD v1.0 |
| Date | 2026-11-14 |
| Status | Draft for review |
| Companion docs | `tech_architect.md` (system architecture), `design.md` (UX/UI design) |

## 0. Name

**Scholium** replaces the working title "OpenResearch".

- Why the old name was dropped: "OpenResearch" is already used by a nonprofit research lab, by an open-source research-agent workspace from alphaXiv, and by a City of Amsterdam research platform. "OpenSearch" is an existing search engine project and is also a component in our own stack, so it cannot be a product name.
- Why Scholium: a *scholium* is an explanatory note written in the margin of a scholarly text. The product's core idea is that a paper lives together with its reviews, annotations and corrections.
- Identifier prefix: `sch:` (for example `sch:k3f9-q2xz-7mwd/v3`).
- Clearance status: the name and the domain were confirmed clear on 20 November 2026, so the brand can be used publicly. (Earlier, a web search had found no publishing or DeSci product using the name. The fallback names kept in reserve were *Scholium Commons*, *Marginalia Network* and *Peerfolio*.)

## 1. Summary

Scholium is a decentralized preprint and peer-review network. It does what arXiv does (free, permanent, versioned, citable papers with moderation) without a single operator who can lose, alter or withhold the record. Every paper, version, review and credential is a signed, content-addressed record that any node can store, verify and re-index.

One-line positioning: **the arXiv you can verify, review in the open, and never lose.**

## 2. Problem

| # | Problem today | Who feels it |
| --- | --- | --- |
| P1 | Preprint archives are single organisations. Funding, policy or legal pressure on one operator affects the whole record. | Authors, libraries |
| P2 | There is no cryptographic proof of who published what, and when. Priority disputes rely on trusting the operator's database. | Authors |
| P3 | Peer review is closed, slow and uncredited. Reviews are not portable and reviewers get no verifiable credit. | Reviewers, authors |
| P4 | Review quality is uneven; fabricated citations and paper-mill submissions pass unnoticed. | Readers, editors |
| P5 | Existing "DeSci" platforms tie quality signals to tradable tokens, which invites speculation and vote buying. | Institutions |
| P6 | Papers, code and data live in different places with no shared integrity guarantee. | Readers trying to reproduce |

## 3. Goals and non-goals

### Goals

1. **G1 Verifiable record.** Any reader can verify authorship, integrity and timestamp of any version offline.
2. **G2 Survivable.** The full archive can be rebuilt by a third party from public storage and one peer, with no help from the founding operator.
3. **G3 Open, structured review.** Post-publication formal reviews with accountable anonymity, plus open discussion.
4. **G4 Useful AI pre-review.** Every listed paper gets an evidence-linked advisory report within about one hour.
5. **G5 Portable reputation.** Authors and reviewers hold verifiable credentials they can take elsewhere.
6. **G6 Free to read and to publish.**

### Non-goals

- Not a journal: Scholium does not "accept" or "reject" science. It lists, reviews and badges.
- No tradable token in scope. No token-weighted votes on scientific questions, ever.
- Not a general social network; discussion is attached to papers.
- No storage of personal data or paper content on a blockchain.
- Not replacing arXiv on day one; cross-posting is supported and expected.

## 4. Users and personas

| Persona | Description | Top jobs to be done |
| --- | --- | --- |
| **Author (Mei, PhD student)** | Publishes 2–4 papers a year, posts to arXiv, wants feedback before conference deadlines | Publish fast; prove priority; get substantive reviews; cite a stable ID |
| **Reviewer (Dr. Okafor, senior researcher)** | Reviews 20+ papers a year unpaid and uncredited | Review anonymously but get credit; avoid conflicts; not waste time on spam |
| **Reader (Sam, ML engineer)** | Reads preprints to apply them | Find relevant work; know whether it has been checked; get code that runs |
| **Moderator (category editor)** | Volunteer subject expert | Clear the queue quickly; make consistent, defensible decisions |
| **Node operator (university library)** | Wants to preserve its researchers' output | Run a node with low effort; meet legal duties; prove preservation |
| **Integrity committee member** | Handles misconduct cases | See evidence; follow due process; publish reasoned decisions |

## 5. Scope by release

| Capability | Phase 1 MVP | Phase 2 | Phase 3 | Phase 4 |
| --- | --- | --- | --- | --- |
| Signed records, version chain, export | ✔ | | | |
| ORCID login, passkeys, tiers 0–3 | ✔ | | | |
| Upload, sanitize, moderate, list | ✔ | | | |
| Viewer, annotations, search | ✔ | | | |
| Discussion + formal review (escrowed anonymity) | ✔ | | | |
| AI multi-agent pre-review (advisory) | ✔ | | | |
| IPFS + cold storage, availability probes | | ✔ | | |
| On-chain anchoring and proofs | | ✔ | | |
| Verifiable credentials, ZK anonymous review | | ✔ | | |
| DOIs, OpenAlex/Crossref feeds | | ✔ | | |
| Governance (assembly, committees, timelock) | | | ✔ | |
| Reputation, credits, bounties | | | ✔ | |
| Integrity case workflow | | | ✔ | |
| Multi-node federation, open node registry | | | | ✔ |

## 6. Functional requirements

Priority: **P0** = must ship in the stated phase; **P1** = should; **P2** = could. Each requirement has an acceptance test (AT).

### 6.1 Identity and access (ID)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| ID-1 | A user can create an account with a passkey; a signing key is generated on the device and never leaves it | P0 | 1 | Account created in < 60 s; server holds no private key |
| ID-2 | A user can link ORCID via OAuth and receive a credential bound to their DID | P0 | 1 | Linked ORCID shown on profile; one ORCID maps to one active DID |
| ID-3 | Trust tiers 0–4 gate actions (read / discuss / submit / review / moderate) | P0 | 1 | Tier-1 user cannot submit; API returns 403 with reason |
| ID-4 | Key rotation and 3-of-5 social recovery | P0 | 1 | Lost-device test: account recovered, old key rejected after rotation |
| ID-5 | Endorsement: a tier-3 user can endorse a new author for a category | P0 | 1 | Endorsed user can submit in that category only |
| ID-6 | Institutional credential via eduGAIN/SAML | P1 | 2 | Affiliation credential issued and verifiable |
| ID-7 | Erasable profile (name, affiliation, email) separate from records | P0 | 1 | After erasure, records verify and show a pseudonymous DID |

### 6.2 Publishing (PUB)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| PUB-1 | Upload PDF and/or LaTeX source, optional code and data bundles (resumable) | P0 | 1 | 50 MB PDF and 2 GB bundle upload succeeds over a flaky connection |
| PUB-2 | Client computes content IDs and signs the version record locally | P0 | 1 | Server-recomputed IDs match; tampered upload rejected |
| PUB-3 | Every listed co-author must sign consent before listing | P0 | 1 | Version stays draft until all consents exist |
| PUB-4 | Files are sanitized and scanned in a sandbox before anyone can view them | P0 | 1 | Hostile-file corpus: 0 active payloads served |
| PUB-5 | Moderation decision (list / hold / reclassify / reject) with policy clause and reason, target 48 h | P0 | 1 | Decision is a public signed record; author is notified |
| PUB-6 | New versions link to the previous version; all versions stay resolvable | P0 | 1 | v1 URL still resolves after v3; diff/change note visible |
| PUB-7 | Withdrawal, correction and retraction as records with banners | P0 | 1 | Retracted paper shows banner on every version |
| PUB-8 | Stable short paper ID and per-version ID | P0 | 1 | `sch:xxxx-xxxx-xxxx/vN` resolves on any node |
| PUB-9 | Licence chosen at submission (default CC BY 4.0) | P0 | 1 | Licence stored inside the signed record |
| PUB-10 | Cross-post import from arXiv with author claiming | P1 | 1 | Imported paper marked "unclaimed" until an author signs |
| PUB-11 | DOI minting for listed versions | P1 | 2 | DOI resolves through two different nodes |
| PUB-12 | One-command submission from a Git tag (CLI / GitHub Action) | P2 | 2 | Tagged release appears as a new version |

### 6.3 Reading and discovery (READ)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| READ-1 | Paper page: abstract, authors, versions, status, files, reviews, discussion | P0 | 1 | Page loads < 2 s p95 |
| READ-2 | In-browser verification indicator (signatures, hash links, anchor) | P0 | 1 | Indicator result equals CLI verifier result |
| READ-3 | Full-text and semantic search with facets (category, date, status, code available) | P0 | 1 | Relevant paper in top 5 for 80% of test queries |
| READ-4 | Paragraph-level annotations anchored to a version | P0 | 1 | Annotation stays attached to the same paragraph on reload |
| READ-5 | Category feeds, saved searches, email digest, Atom/JSON | P1 | 1 | New paper appears in feed within 5 min of listing |
| READ-6 | Citation graph and "cited by reviewed papers" filter | P1 | 2 | Forward/backward citations shown |
| READ-7 | Export: BibTeX, RIS, full paper archive | P0 | 1 | Exported archive verifies offline |

### 6.4 Review and discussion (REV)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| REV-1 | Open discussion threads (tier 1+) with helpful votes that only order the thread | P0 | 1 | Votes never change paper status |
| REV-2 | Formal review against a rubric (soundness, evidence, reproducibility, novelty, clarity, limitations) with confidence and recommendation | P0 | 1 | Free-text-only formal review is rejected |
| REV-3 | Anonymous-but-accountable reviewers; one review per person per paper; conflict-of-interest check | P0 | 1 | Second review from same person is refused; co-author is refused |
| REV-4 | Commit–reveal: reports are hidden until 2 are committed or 21 days pass | P0 | 1 | Reviewer B cannot read A's report before reveal |
| REV-5 | Author point-by-point responses; reviewers can update against a new version | P0 | 1 | Response thread linked to each review item |
| REV-6 | Review quality rating by other tier-3 members | P1 | 1 | Rating affects reviewer reputation only |
| REV-7 | Computed status: Preprint, Under review, Reviewed, Contested, Corrected, Retracted | P0 | 1 | Two nodes compute the same status from the same records |
| REV-8 | Zero-knowledge reviewer credentials (operator cannot learn identity) | P0 | 2 | External cryptographic review passed |
| REV-9 | Appeals to a randomly drawn 3-member panel | P0 | 1 | Appeal produces a signed, reasoned decision |
| REV-10 | Signed (non-anonymous) review option with public credit | P1 | 1 | Signed review shown on reviewer profile |

### 6.5 AI pre-review (AI)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| AI-1 | Four specialist agents (methodology, literature, reproducibility, integrity) plus a meta-reviewer | P0 | 1 | Report produced within 60 min p90 |
| AI-2 | Every finding links to a quoted span, a resolved reference or a log line | P0 | 1 | 100% of findings have evidence; others are dropped |
| AI-3 | Report is labelled advisory and cannot change status, listing or reputation | P0 | 1 | No code path from AI output to status |
| AI-4 | Reproduction runs in an isolated sandbox with no network | P0 | 1 | Sandbox escape and exfiltration tests fail |
| AI-5 | Prompt-injection resistance | P0 | 1 | Adversarial paper set does not change conclusions |
| AI-6 | Authors can rebut each finding; reviewers can mark findings confirmed/wrong | P0 | 1 | Rebuttal visible next to finding |
| AI-7 | Signed report records model versions and prompt-set hash | P0 | 1 | Third party can re-run the same configuration |
| AI-8 | Private drafts are processed only by self-hosted models | P0 | 1 | No draft bytes leave the node (network audit) |

### 6.6 Storage, anchoring, federation (NET)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| NET-1 | Append-only, hash-chained event log per node | P0 | 1 | Rewriting history is detected by the verifier |
| NET-2 | Complete public export and independent rebuild | P0 | 1 | Third party rebuilds the archive (Gate 1) |
| NET-3 | Replication policy: ≥ 5 replicas, ≥ 3 operators, ≥ 2 jurisdictions for papers | P0 | 2 | Replica count shown per paper; pin-deletion drill recovers |
| NET-4 | Hourly on-chain anchoring with inclusion proofs | P0 | 2 | Proof verifies in the browser |
| NET-5 | Takedown via tombstone without breaking verification | P0 | 1 | Tombstoned content unavailable; history still verifies |
| NET-6 | Node-to-node sync, snapshot bootstrap | P0 | 4 | Two nodes converge after a 24 h partition |
| NET-7 | Equivocation detection and automatic suspension | P0 | 4 | Malicious test node is suspended |

### 6.7 Reputation, credentials, governance (GOV)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| GOV-1 | Non-transferable reputation computed by an open, deterministic function | P0 | 3 | Two nodes compute identical scores |
| GOV-2 | Contribution credentials (e.g. "reviewed N papers in category X") | P1 | 2 | Credential verifies in a third-party wallet |
| GOV-3 | Non-tradable research credits for reviews, reproductions, moderation | P1 | 3 | Credits cannot be transferred between users |
| GOV-4 | One-person-one-vote assembly with capped reputation bonus; timelocked execution | P0 | 3 | Parameter change executes after timelock |
| GOV-5 | Field academic committees and an integrity committee | P0 | 3 | First election held; decisions are signed records |
| GOV-6 | Reputation penalties only after a concluded integrity case with appeal | P0 | 3 | Negative review alone changes no author score |

### 6.8 Moderation and safety (MOD)

| ID | Requirement | Pri | Phase | Acceptance test |
| --- | --- | --- | --- | --- |
| MOD-1 | Moderator queue with automated check results (similarity, reference resolution, scan results) | P0 | 1 | Median decision time ≤ 48 h in pilot |
| MOD-2 | Flagging by any member; public, appealable decisions | P0 | 1 | Flag → decision → appeal path works end to end |
| MOD-3 | Rate limits per tier and per issuer | P0 | 1 | Burst from new accounts is throttled |
| MOD-4 | Review-ring and paper-mill signals routed to an integrity queue | P1 | 3 | Simulated ring flagged before badge |

## 7. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Security | No single compromised party can forge, alter, backdate or erase a record, or unmask an honest reviewer. Annual penetration test; contract audits before mainnet; bug bounty. |
| Privacy | No personal data on-chain. Erasure honoured within 30 days. Data-protection impact assessment before each phase. |
| Availability | Read path 99.9% monthly per node; readers can fail over to other nodes. Writes queue if the anchor chain is down. |
| Durability | Replication policy in NET-3; RPO 5 min, RTO 4 h per node; quarterly rebuild drill. |
| Performance | Paper page < 2 s p95; search < 500 ms p95; 10,000 submissions/day and 1,000 read req/s at Phase 4 scale. |
| Accessibility | WCAG 2.2 AA; HTML renditions of papers where LaTeX source exists. |
| Portability | Open record format and schemas; SDKs in TypeScript and Python; everything exportable. |
| Internationalisation | UI in English first; content in any language; Unicode-safe search. |
| Compatibility | Desktop and mobile browsers (latest two versions); CLI on macOS, Linux, Windows. |
| Cost | Free to read and publish. Target infrastructure cost published annually as cost per paper. |

## 8. Success metrics

Targets are proposals to be confirmed with the pilot community.

| Metric | Phase 1 target | Phase 2 target |
| --- | --- | --- |
| Active pilot researchers | 30–50 | 300 |
| Papers listed | 100 | 1,500 |
| Papers with ≥ 2 formal reviews within 30 days | 40% | 50% |
| Median moderation time | ≤ 48 h | ≤ 36 h |
| AI finding false-accusation rate (expert-labelled sample) | < 2% | < 1% |
| AI findings marked "confirmed" by human reviewers | ≥ 50% | ≥ 60% |
| Papers meeting full replication policy | n/a | 100% |
| Independent rebuilds of the archive by a third party | 1 | 2 |
| Security incidents with record integrity loss | 0 | 0 |

North-star metric: **number of paper versions that received at least two substantive formal reviews.**

## 9. Key user journeys

1. **Publish.** Mei signs in with a passkey → uploads PDF + source + code → co-authors approve from an email link → moderator lists the paper in 30 h → she shares `sch:…/v1` → AI pre-review arrives 40 min later.
2. **Review.** Dr. Okafor is invited → the client confirms no conflict and creates a one-time review key → he fills the rubric → the report is revealed when a second review is committed → Mei responds and posts v2 → he updates his recommendation → the paper earns "Reviewed".
3. **Verify.** Sam opens a paper → the page shows "Verified: 3 versions, 4 signatures, anchored 2027-03-02" → he downloads the code bundle and the reproduction log.
4. **Preserve.** A library runs an archive node → it bootstraps from a snapshot → its dashboard shows replica counts and probe results.
5. **Dispute.** A reader flags duplicated figures → the integrity agent report is attached → the committee opens a case → the author responds → a reasoned decision and a correction record are published.

## 10. Dependencies and assumptions

- ORCID API membership; DataCite (or partner) membership for DOIs (Phase 2).
- A legal entity (non-profit foundation or association) to hold memberships and sign the federation agreement.
- At least one named academic committee per launch category.
- Pilot community from the NeurIPS 2026 Sydney meetup cohort (AI/ML first).
- GPU or Apple-silicon capacity for self-hosted models.

## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Low adoption | Empty archive | One community first; arXiv cross-posting; Google Scholar/OpenAlex indexing early |
| Moderator shortage | Slow listing | Credits for moderation; limit categories to staffed ones |
| Wrong AI integrity flag | Harm to an author | Advisory label, evidence requirement, rebuttal, false-accusation gate |
| Key loss | Lost identity | Passkeys, social recovery, institutional custody option |
| ZK review complexity | Delay or flaw | Escrow model in Phase 1; audited library; external review |
| Legal takedown vs permanence | Liability | Quarantine before permanent storage; permanence opt-in |
| Name clearance fails | Rebrand cost | Closed: name and domain confirmed clear on 20 November 2026 (section 0) |

## 12. Open questions

1. Legal entity and jurisdiction.
2. First three categories and committee members.
3. Are non-commercial licences allowed?
4. Which model families run AI review; hosted vs self-hosted policy.
5. Target L2 for anchoring.
6. DOI route: direct DataCite membership or through a partner institution.
7. Launch DID method: `did:key` only, or rotatable from day one.

## 13. Release plan

| Phase | Window (target, not committed) | Exit gate |
| --- | --- | --- |
| 1 Community MVP | Nov 2026 – Jan 2027 | Third party re-verifies a full export |
| 2 Decentralized publishing | Feb – Apr 2027 | Audits closed; rebuild from cold storage passes |
| 3 Research DAO | May – Jul 2027 | First election held; admin keys retired |
| 4 Federation | H2 2027 onward | Second independent node in good standing |
