# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-11

First public release. A bridge that lets you @mention your Claude
Code agent in a Linear issue and have it run locally against your
configured repo — streaming thinking, tool use, plan checklist, and
final results back into the Linear thread.

### Added
- **Kanban Agent Bridge MVP**: Linear webhook → local Claude Code CLI
  → Linear agent session activities (`thought`, `action`, `response`,
  `error`).
- **OAuth installation flow** for Linear workspaces, with token
  storage and automatic refresh.
- **Follow-up session resumption**: thread replies continue the same
  Claude Code session via `--resume`, preserving context across turns.
- **Workdir resolution with multi-key matching**: `PROJECT_DIRS`
  entries match (case-insensitive) against `projectId` / `projectName`
  / `teamId` / `teamKey` / `teamName`. Most users will key by team key
  (e.g. `FAT=/path/to/repo`) or by project name.
- **Linear API fallback for missing project**: on `prompted` webhooks
  Linear omits project info; the bridge queries `issue(id) { project }`
  on memory miss and caches the result.
- **Stop-signal handling**: clicking stop in Linear immediately kills
  the running Claude Code subprocess, drops queued follow-ups for the
  same session, and posts a `Stopped.` activity.
- **Agent session plan sync**: Claude Code's internal `TodoWrite` tool
  calls are mirrored to Linear's `agentSession.plan` via
  `agentSessionUpdate`, rendering a live checklist in the thread.
  (Linear's agent plan API is marked technology preview.)
- **Thinking activities**: Claude Code thinking messages are posted as
  Linear `thought` content (previously were miscategorized as actions).
- **Configurable Claude Code permission mode** via
  `CLAUDE_CODE_PERMISSION_MODE` — defaults to `bypassPermissions` since
  the bridge is non-interactive.
- **Dispatcher diagnostics**: startup logs dispatcher config
  (`timeoutMs`, `defaultWorkDir`, mapping keys) and warns loudly when
  `DEFAULT_WORK_DIR === $HOME`.

### Changed
- **Default `TIMEOUT_MS` lowered from 20 min → 8 min**. A hung task
  now blocks the queue for at most 8 minutes instead of 20.
- **Default bridge port changed to 3010** to reduce local conflicts.
- **Initial `Processing your request...` acknowledgement removed**.
  It was an ephemeral activity that never got replaced by the final
  response and ended up stuck in the thread.

### Fixed
- **Stop signal was a no-op** — previously logged as
  `Received stop signal` but did nothing, so tasks ran to the 20 min
  timeout.
- **Workdir fell back to home directory on thread replies** because
  Linear's `prompted` webhooks don't carry project info and the old
  in-memory cache didn't survive restarts.
- **Thinking events were sent as `action` instead of `thought`**, so
  they rendered as tool use in Linear's UI.
- **Duplicate replies** on webhook retries (from a prior fix, carried
  forward).

[0.1.0]: https://github.com/fatwang2/kanban/releases/tag/v0.1.0
