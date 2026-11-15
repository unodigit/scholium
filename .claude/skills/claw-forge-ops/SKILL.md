---
name: claw-forge-ops
description: >-
  Operate a claw-forge project and route between its workflows. Use when
  asked what the run is doing, whether it is stuck, why a task failed or was
  dropped, to pause, resume, reset, skip or stop it, to recover lost work,
  or when unsure which claw-forge skill applies to a request.
---

# Operating claw-forge (the hub)

This skill owns the live run and decides which sibling skill takes over.
It carries the rules that cause harm when forgotten; procedure lives in
the commands it points at.

## Route first

| The user wants… | Go to |
|---|---|
| a new feature, page, endpoint, module | `claw-forge-feature` |
| a defect fixed (one or several) | `claw-forge-bug` |
| to know whether the finished app works | `claw-forge-verify` |
| status, a stuck run, a failure, recovery, pause/stop | stay here |

Hand-offs run both ways: `feature`/`bug` end by sending you here to
monitor the run; a failed run here that needs new work goes back out to
`bug` (defect) or `feature` (missing capability); a run that just
finished goes to `verify`. **Never start `claw-forge run` without an
explicit yes** — it spawns agents, writes git and spends tokens for hours.

## Reading state (all read-only)

Read `.claude/commands/claw-forge-status.md` and execute it. For the
provider pool, read `.claude/commands/pool-status.md`. Also read-only:
`claw-forge worktrees list`, `claw-forge stash list`, `claw-forge evidence`,
`claw-forge doctor`.

- **Never assume port 8420.** The service falls back to `port+1…+4` and
  records it nowhere; `status` finds it by matching `/info.project_path`.
- `claw-forge state` is **not one of them** — it starts a server. Never run it here.
- `status` and `export` read `state.db` directly; `pause`, `resume`,
  `input` and `reset` need the service.
- Progress bars on running cards are an animation capped at 90%, not a
  measurement. `pool-status` zero cost/latency/rpm is normal on the SDK path.
- `blocked` is written by nothing: dependents of a terminal task stay
  `pending` and are reported as *stranded*.
- A `needs_human` task is in no Kanban column — answer it with
  `claw-forge input`.
- `DISPATCHER STARTING` is normal at boot. After an upgrade, a service on
  an older version is normal and is never restarted under a live dispatcher.

## `DISPATCHER OFFLINE` is not proof

Confirm the reading belongs to this project's service (`/info`
`project_path`, every port) before acting. A second `claw-forge run` on
live worktrees corrupts a healthy run on another port. Never advise
"resume with `claw-forge run`" on an unconfirmed reading. When in doubt,
show the user what you see and ask. `run --dry-run` is **not** a no-op: it
still runs session init, which re-pends orphaned `running` tasks.

## Pause is not Stop

- **`claw-forge pause`** — soft drain: in-flight agents finish, nothing new
  starts, no task status written. `claw-forge resume` undoes it.
- **Stop All** (Kanban) — hard stop: every agent coroutine is cancelled
  within ~2 s and tasks become `paused`. The worktree and checkpoint
  commits **survive**; only the in-flight turn is lost, and `resume`
  re-queues with a resume preamble.
- After Stop All, run `claw-forge resume` *before* `claw-forge run`, or the
  paused tasks and their dependents never dispatch.

Say which one you are doing. Never call a hard stop a pause. Stop the
service with `POST /shutdown`, never `kill -9` or `kill $(lsof …)`.

## Re-running failed work

- `claw-forge reset` gives every matched task a **fresh retry budget**
  (fresh spend) and clears `error_message`, `failure_scope`, `gate_verdict`.
  Narrow it: `--status failed`, `--error-pattern '%rate_limit%'`. A
  merge-failed parent needs `--status completed --error-pattern 'merge_failed:%'`.
  Don't spam it. A live run re-admits reset tasks within ~30 s.
- `claw-forge skip <id>` — honest "do not run this" (undo: `reset --status
  skipped`); refused on `running`; dependents stay `pending`.
- `claw-forge satisfy <task> --by <task|sha> --reason …` — delivered
  elsewhere (`empty_branch`); only a human decides this.
- `claw-forge widen <task> --path … --reason …`, then `reset --status
  failed` — for `shared_edit_blocked:`.
- Resetting a terminal parent re-arms its whole `pending` subtree.
- `fix`, `plan-bugs`, `pr-feedback` **queue**; only `run` dispatches.

## Diagnosing a failure

`claw-forge status` reports `failure_scope` per failed task:

| Scope | Meaning | Budget |
|---|---|---|
| `agent` | the agent's work was wrong | `agent.agent_retry_attempts` (2) |
| `infrastructure` | box, provider or environment failed | `agent.infra_retry_attempts` (2) |
| `integration` | merge / worktree-sync conflict | `git.merge_retry_attempts` (3); never re-pended elsewhere |
| `unknown` | ambiguous — both patterns matched | agent budget |

A heuristic, not an oracle. Common prefixes: `resume_conflict:` (the agent
never ran — fix the preserved worktree, then `reset`), `merge_failed:`
(completed but unmerged — resolve, then `claw-forge merge`), `empty_branch:`
(no commits; can be a false positive), `agent_stream_idle:` and
`agent_command_stuck:` (hung provider / looping command).

**Gate verdicts** (`Task.gate_verdict`): `PASSED`, `PASSED:agent_run`,
`FAILED`, `SKIPPED:<reason>`, `FORGIVEN:red_baseline|inherited_only`.
`NULL` means *never consulted* — never read it as "passed". A task failing
on tests it never touched: suspect a stale or red baseline before the agent.

## Providers and credentials

A missing credential is run-fatal (dispatcher drains, tasks stay `pending`);
a rejected one is quarantined for the run and rotation continues. 429/5xx/
network/subscription caps rotate; 400/403/404 fail fast. The pool is built
once: a mid-run config or overlay edit is reported, not applied.

## Recovering what a sweep or leak took

Startup stashes dirty tracked files (`claw-forge-auto-<ts>`) and **archives
untracked files to `.claw-forge/orphans/<ts>/`, not the stash** — not data
loss. `.claw-forge/sweeps/<ts>.json` records both. Look in order:
`worktrees list`, `stash list`, `orphans/`, `git log --grep 'Task-ID:'`.

Restore with `claw-forge stash apply <sha>` — never an index, never `pop`.
**Never restore while a run is live**; the leak watch re-sweeps it onto an
innocent task.

## Destructive — ask first

`worktrees prune --discard` (loses committed work) and `--force` (pulls the
checkout from a live agent), `stash drop` (permanent), `traces prune`,
`claw-forge merge` (writes the target branch), `claw-forge upgrade`.

## Never, under any circumstance

- `bypassPermissions` on the dispatcher; stacking isolation layers (macOS
  exit 71); a second dispatcher on the same session.
- Calling queued work "running", or reporting a gate-off run as verified.
