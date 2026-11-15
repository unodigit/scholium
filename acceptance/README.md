# Acceptance tests

Each folder in `acceptance/` holds the acceptance tests for one feature of this
project. They are written from that feature's acceptance criteria in the app
spec by a separate agent, before the feature is built, so the code is never
graded by the agent that wrote it.

## Why some of these tests fail

A feature's tests are merged first and must fail at that point; claw-forge checks
that they do. They stay red until the feature lands. While acceptance checks
are enforced (`agent.acceptance_criteria: enforce`, the default), a feature
cannot merge until its acceptance tests pass.

## Why the normal test command skips them

The file names avoid every default test-discovery pattern: `acceptance_*.py`
for Python, `*.acceptance.ts` / `.js` for JavaScript and TypeScript, and a
`//go:build acceptance` tag for Go. A feature that is not built yet therefore
never turns the project's own test suite red.

## How to run them

`acceptance/<feature>/acceptance.json` gives the command for that feature's
tests. Run it from the repository root.

## Before you edit them

These tests define what each feature must do. claw-forge stops feature agents from
changing them and runs every merged feature's acceptance tests again at the
end of each run. Change a test by hand only when the requirement changes.

claw-forge wrote this file and never overwrites it. You may edit it. If you delete
it, the next acceptance task writes it again.
