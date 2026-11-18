# System tests: the shipped programs, end to end

```sh
npm run test:system                      # everything, about three minutes
npm run test:system -- -m "not web"      # without the Next.js build, about two
npm run test:system -- -k migration      # extra arguments go to pytest
npm run test:system -- -m "not web" -n 4 --dist loadfile   # modules are independent: about 45 seconds
```

Not part of `npm test`: they start many processes and take minutes. They need no
container, no network beyond loopback and no credential. Run them after changing
anything that wires processes together: the composition root (`app.main`,
`app.module_loader`), settings, the worker, the object store, the sandbox, the
migration tool, `compose.yaml`, the web build.

## What "end to end" means here

The unit suites (`apps/api`, `apps/web`) and the in-process journeys in
`apps/api/tests/e2e` assemble the application themselves. These tests never do:
nothing under `tests/e2e` imports `app` or builds a `FastAPI` object. Every test
starts a **program** the way an operator starts it and talks to it from outside:

| Program | Started as |
| --- | --- |
| the API | `python -m app` |
| the worker | `python -m app.worker` (`--once`) |
| the sandbox service | `python -m app.sandbox_service` |
| provisioning | `python -m app.modules.admin init-node / set-tier / seed-demo` |
| the stack's smoke check | `python -m app.smoke` |
| the migration | `python -m app.migrate_backend` |
| a third party's verifier | `python -m scholium_cli.main verify` |
| the web app | `npm run build`, then `npm run start` |

so a module that is not discovered, a setting that nothing reads, a job handler
only one process registers, or a build that fails shows up here and nowhere else.

The only stand-ins are the *neighbours* a node talks to in a deployment, run in
the test process on loopback ports (`e2e_harness.py`): `FakeS3` (what MinIO is in
`compose.yaml`), `SmtpSink` (Mailpit) and `FakeClamd` (the antivirus daemon;
archives are refused when none is configured).

## What is covered

| File | What it proves |
| --- | --- |
| `test_entrypoint.py` | `python -m app` with *no configuration* boots on SQLite, mounts every route the spec lists, answers its probes, returns problem documents, applies CORS and shuts down gracefully. |
| `test_startup_config.py` | Mistyped backends and unsafe production settings stop the process with the reasons; a complete production configuration boots; `NODE_KEY` alone makes a node able to sign; an unreachable or mis-credentialed object store fails `/readyz` and not `/healthz`. |
| `test_journey_publish.py` | Publishing and reading a paper on two deployments of the same code (`fs+worker`: SQLite, files, a separate worker process; `s3+thread`: S3 bucket, in-process jobs): catalog, extracted text, search, content served by CID with its security headers, the ledger and its append-only guard, the AI pre-review, an archive a third party verifies offline, a restart. |
| `test_journey_review.py` | The review escrow on both deployments: sealed commits, the report gate, reveal, the commitment check, one review per person. |
| `test_worker_process.py` | `JOBS_MODE=external`: the API leaves jobs queued, only a separate worker runs them (the smoke check fails without one and passes with one), periodic jobs are not queued twice, SIGTERM and `--once`. |
| `test_openai_compatible_review.py` | `AI_PROVIDER=openai` against a stub chat-completions server on a loopback port (the neighbour; no network, no real key): a node with `JOBS_MODE=thread` lists a paper, the `ai_review` job calls `POST /v1/chat/completions` with the bearer key and `AI_HOSTED_MODEL`, and `GET /v1/papers/{id}/ai-reviews` names provider `openai` and model `stub-model`. The paper text reaches the stub only as quoted data, and the key appears in no log, review or archive. |
| `test_sandbox_service.py` | The sandbox service alone (token, refusals, a run to a result) and the cloud shape: an API with `SANDBOX_BACKEND=remote` sends a paper's bundle to a separate service that reads it from the shared bucket. |
| `test_backend_migration.py` | A node moved from SQLite and files to a new database and S3 *is* the same node: same papers, same sync head, a byte-identical archive. A non-empty target, a damaged blob and a broken hash chain are refused. |
| `test_demo_node.py` | `seed-demo` then `python -m app`: what was seeded is served, pre-listing bytes stay hidden. |
| `test_delivery_wiring.py` | `compose.yaml`, the Containerfiles and `package.json` agree with the code: commands exist, every variable compose passes is read, images are not root, no secrets, no cloud SDK but boto3, no provider names under `apps/`. |
| `test_web_entrypoint.py` (`-m web`) | The production build succeeds; `next start` serves every page with the security headers and the CSP naming the API; server-rendered pages show what the API holds. |

## What is *not* here

* **PostgreSQL.** `npm run test:pg` runs the whole API suite on it.
* **The container stack** (`npm run stack:up`, `stack:smoke`) and **OpenTofu**
  (`npm run infra:check`): they need an engine or `tofu`.
* **A real browser**: `npm run test:e2e` (Playwright).
* **A real S3 service or ClamAV.** The stand-ins speak the protocol the node uses.
  `FakeS3` implements put, ranged get, head, delete and list; multipart upload is
  not implemented (no test blob is large enough to need it).

## Writing a test

* Get nodes from the `nodes` fixture (`nodes.make(storage=..., jobs=...)`); it gives
  each one its own data directory and port and stops everything when the module ends.
  The `node`, `http` and `paper` fixtures in `conftest.py` give a running node on each
  deployment and a published paper on it.
* Provision like an operator (`node.init_key()`, `node.set_tier(...)`) and act like a
  person (`Actor`: a fresh `did:key`, signs in, signs records). Read mail from
  `node.smtp`, not from the node.
* Wait for jobs with `poll(...)`, never `sleep`.
* A failing test prints the logs of every process of its node.
* Do not skip. A test that cannot run in an environment should fail with a message
  that says what to install.
