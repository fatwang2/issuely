# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-11

First public release of **Issuely**. @mention your Claude
Code agent in a Linear issue and it runs locally against the repo you
map that issue to — streaming thinking, tool use, a live plan
checklist, and final results back into the Linear agent thread.
Follow-up replies in the same thread continue the same Claude Code
session, with full context preserved.

This release consolidates everything from the original MVP through
all follow-up fixes and feature work.

### Highlights

- **Linear ↔ Claude Code, end to end**: OAuth installation, webhook
  handling, task dispatch, activity streaming, session resume.
- **Live plan checklist**: Claude Code's internal `TodoWrite` state is
  mirrored to Linear's agent session `plan`, so you watch the agent's
  step-by-step progress in the thread.
- **Real stop button**: clicking stop in Linear actually kills the
  running agent subprocess and clears the queue for that session.
- **Per-issue repo routing**: map Linear projects or teams to local
  directories with flexible, case-insensitive keys; a Linear API
  fallback keeps follow-up replies routed correctly even across bridge
  restarts.

### Added

- **Bridge MVP** (from the initial integration work):
  - Linear OAuth installation flow with token storage and refresh.
  - Webhook receiver for `AgentSessionEvent` (`created` and
    `prompted`), with signature verification, dedup on
    session/activity id, and quick 200 OK responses.
  - Task dispatcher with a pluggable agent registry, queueing,
    per-task timeout, and graceful SIGINT/SIGTERM shutdown.
  - Claude Code agent backend built on `claude -p` with stream-json
    parsing for `text` / `thinking` / `tool_use` blocks.
  - Linear activity posting for `thought`, `action`, `response`, and
    `error` content types via `agentActivityCreate`.
- **Follow-up session resumption**: `prompted` webhooks continue the
  same Claude Code session via `--resume <sessionId>`, so conversation
  context survives across thread replies.
- **Workdir mapping with multi-key matching**: `PROJECT_DIRS` entries
  are matched case-insensitively against the incoming issue's
  `projectId`, `projectName`, `teamId`, `teamKey`, and `teamName`.
  Team key (e.g. `FAT`) and project name are the most practical keys.
- **Linear API fallback for missing project info**: Linear omits the
  `project` field on `prompted` webhooks, so the bridge resolves it
  from an in-memory cache first and, on miss, queries
  `issue(id) { project { id name } }` via GraphQL. The result is
  cached so follow-ups stay free.
- **Stop-signal handling**: a `stop` signal from Linear is routed to
  the dispatcher, which marks the task as user-aborted, kills the
  Claude Code subprocess, drops any queued follow-ups for the same
  session, and posts a short `Stopped.` activity instead of a
  misleading timeout error.
- **Agent session plan sync**: Claude Code `TodoWrite` tool calls are
  intercepted and pushed to Linear's `agentSession.plan` via
  `agentSessionUpdate`. Statuses map `pending / in_progress /
  completed` → `pending / inProgress / completed`. Short tasks that
  don't use `TodoWrite` simply have no plan. (Linear's agent plan API
  is marked technology preview and the rendering UI may still evolve.)
- **Thinking activities**: Claude Code thinking messages are posted as
  Linear `thought` content, with summaries capped at 500 characters.
- **Configurable Claude Code permission mode** via
  `CLAUDE_CODE_PERMISSION_MODE` (`default` / `acceptEdits` / `plan` /
  `bypassPermissions`). Defaults to `bypassPermissions` since the
  bridge is non-interactive.
- **Dispatcher diagnostics**: on startup the bridge logs its full
  dispatcher config (`maxConcurrent`, `timeoutMs`, `defaultWorkDir`,
  configured mapping keys) and warns loudly when `DEFAULT_WORK_DIR`
  equals `$HOME`.
- **Task tracing**: every workdir resolution logs which field matched
  (`projectId` / `projectName` / `teamKey` / etc.) and which mapping
  key won, so routing misses are obvious from a single log line.

### Changed

- **Default bridge port changed from 3000 → 3010** to avoid conflicts
  with common local dev servers.
- **Default `TIMEOUT_MS` lowered from 20 min → 8 min**. A hung task
  now blocks the queue for at most 8 minutes instead of 20. Override
  via environment if you need longer.
- **Initial `Processing your request...` acknowledgement removed**.
  It was a well-meaning ephemeral activity that ended up permanently
  pinned to the thread, because ephemeral activities only get replaced
  by the next ephemeral activity, and the final `response` is not
  ephemeral.
- **Progress updates are no longer ephemeral by default**. `TaskUpdate`
  now carries an optional `ephemeral` flag; the Linear source only
  sends `ephemeral: true` when explicitly requested (and only for
  `thought` / `action` types, which are the only ones Linear allows).

### Fixed

- **Stop signal was a no-op**. Previously the bridge logged
  `Received stop signal` and did nothing — the task ran until the full
  20 min timeout, and any queued follow-ups waited with it. Fixed end
  to end: Linear → dispatcher → agent subprocess.
- **Workdir fell back to the home directory on thread replies**. On
  `prompted` webhooks, Linear doesn't send project info, and the old
  in-memory cache couldn't survive bridge restarts — so Claude Code
  was launched in `$HOME` without any repo context, producing slow,
  confused answers. Fixed via multi-key matching + Linear API fallback.
- **Thinking events rendered as tool use** because `throttledProgress`
  hardcoded `type: "progress"` (→ Linear `action`) for every streamed
  event. Thinking now flows through as `thought`.
- **Duplicate replies** on webhook retries: sessions were sometimes
  processed twice when Linear retried a delivery (fix from an earlier
  iteration, carried forward).
- **Linear OAuth tokens now auto-refresh on outgoing API calls**.
  `postUpdate`, `updateSessionPlan`, and `fetchIssueProject` route
  through a `getValidTokens` helper that tries `refreshAccessToken`
  first and falls back to the stored token, so long-running bridges
  don't start silently failing once the initial access token expires.
  Webhook signature mismatches are also logged as warnings instead of
  returning a bare `false`.
- **`tsc --noEmit` passes cleanly** across all modules.

### Known limitations

- **One concurrent task per bridge** by default (`MAX_CONCURRENT=1`).
  Long tasks queue follow-ups; raise only if your agent usage is
  genuinely parallelizable.
- **Agent session plan is technology preview on Linear's side**. The
  JSON shape currently matches Linear's public docs, but may change.
  If it does, `LinearSource.updateSessionPlan` is the single update
  point.
- **`claude -p` is one-shot**, so requests that try to launch a
  long-running local dev server will hang until the task timeout. Use
  the stop button (it now works) or avoid asking for persistent
  processes via the bridge.

[0.1.0]: https://github.com/fatwang2/kanban/releases/tag/v0.1.0
