# Record body JSON Schemas

One [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12/schema)
document per Phase 1 record type, named `<record-type>.json`. The
`type` field of a signed record envelope selects the schema that its
`body` must satisfy.

| Record type | Body highlights |
| --- | --- |
| `paper.genesis` | title, categories, licence, initial authors |
| `paper.version` | paper, n, title, abstract, authors, manifest, licence, changeNote |
| `manifest` | files with path, cid, size, mediaType, role |
| `coauthor.consent` | version, role, decision accept/decline |
| `review.commit` | target, commitment, nullifier, review key |
| `review.formal` | six rubric scores, confidence, recommendation, report |
| `review.response` | review, point-by-point items keyed by dimension |
| `review.rating` | review, rating 1-5 |
| `discussion.post` | target, anchor, text, parent |
| `ai.review` | target, agents, models, promptSetHash, findings with evidence |
| `rendition` | source version, sanitized files, tool versions |
| `endorsement` | endorsee, category, expiry |
| `moderation.decision` | target, action, clause, reason |
| `appeal` | target decision, grounds |
| `appeal.decision` | target appeal, outcome, reasons |
| `retraction` | target, reason, replacement |
| `correction` | target, reason, replacement |
| `withdrawal` | target, reason |
| `key.rotation` | oldKey, newKey, recoveryProof |
| `erasure.request` | content CIDs, basis |
| `external.mirror` | source, metadata, manifest |
| `flag` | target, reason category |

The Python record core loads these with
`scholium_record_core.validate_body(record_type, body)`, which returns
a list of error messages (empty when the body is valid). The schemas
are also usable by the TypeScript port and any standard JSON Schema
validator.

Schemas are intentionally forward-compatible: unknown additional body
properties are allowed, so later phases can add fields without
invalidating Phase 1 records.
