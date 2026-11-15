# claw-forge status

Display a full project status card — zero-friction re-entry after leaving a session.

## What it shows

- **Project header**: name, spec file, model, and budget usage
- **Progress by phase**: progress bars, done/total counts, and phase health icons
- **Agent status**: current task, runtime
- **Next action**: the one thing you should do next (intervene, retry, start, etc.)

## Usage

```bash
claw-forge status
claw-forge status --config path/to/claw-forge.yaml
```

## Requirements

Live data comes from the state service that `claw-forge run` (or `claw-forge ui`) starts and owns. Without one, the command reads `state.db` directly, prints a `DISPATCHER OFFLINE` warning, and exits cleanly.

If it reports offline, do **not** start a service with `claw-forge state` — that can put a second service on a live `state.db`. First check whether a run is live (`ps`, and the `/info` `project_path` on ports 8420–8424, since the service falls back to the next free port). If none is, follow the command's own advice (`claw-forge run`). See the `claw-forge-ops` skill.
