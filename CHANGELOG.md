# Changelog

All notable changes to this project are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0](https://github.com/fatwang2/kanban/releases/tag/v0.3.0) — 2026-05-02

Issuely now speaks **Cursor** alongside Claude Code and Codex. Same
bridge, same Linear thread, same plan checklist — pick your agent with
a single environment variable.

### Highlights

- **Cursor backend** via the standalone [`cursor-agent` CLI](https://cursor.com/docs/cli)
in `--print --output-format stream-json` mode. Authentication is
handled by the CLI itself — `cursor-agent login` (OAuth, recommended)
or `CURSOR_API_KEY` fallback.
- **Three-way agent switch**: `DEFAULT_AGENT=claude-code`, `codex`,
or `cursor`. All three backends are registered at startup and probed
independently.
- **Subscription billing**: OAuth login ties the CLI to your Cursor
account, so usage draws from your Pro subscription's included quota
before any pay-as-you-go charges.

### Added

- **`CursorBackend`** (`src/agents/cursor.ts`) implementing the
existing `AgentBackend` interface. Spawns `cursor-agent` as a
subprocess and parses its stream-json stdout, matching the
`ClaudeCodeBackend` pattern. Event mapping:
  - `assistant.message.content[].text` → `text`
  - `tool_call` (started) → `tool_use`, with `read` → `Read`,
    `edit`/`write` → `Edit` / `Write`, `shell` → `Bash`,
    `updateTodos` → `TodoWrite`, `grep` / `glob` / `ls` /
    `semSearch` / `task` / `mcp` mapped to their Claude Code
    equivalents. The `TodoWrite` mapping converts
    `TODO_STATUS_PENDING / IN_PROGRESS / COMPLETED` to Claude Code's
    `pending / in_progress / completed` and synthesizes `activeForm`
    so the dispatcher's `parseTodoWritePlan` syncs Cursor plans to
    Linear without knowing the source backend.
  - `result.is_error` → `failed` status on the resulting `AgentResult`
- **Session resume for Cursor** via `cursor-agent --resume <session_id>`.
The session_id is captured from `system.init` and `result` events
and returned as `AgentResult.sessionId`.
- **Cursor configuration** via new env vars: `CURSOR_AGENT_PATH`
(override the default PATH lookup), `CURSOR_MODEL` (passed to
`--model`). `CURSOR_API_KEY` is also respected, but the CLI itself
reads it — Issuely no longer plumbs auth into the backend.
- **Abort wiring**: `AgentSession.abort()` sends `SIGTERM` to the
live `cursor-agent` subprocess so the Linear stop button kills
in-flight Cursor turns.

### Why CLI and not SDK

The first cut of this backend used [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk),
but it failed end to end under Bun: the SDK's local runtime talks
to its embedded binary over connect-rpc/HTTP/2, which hits an
unresolved bug in Bun's `node:http2` (`NGHTTP2_FRAME_SIZE_ERROR` —
[oven-sh/bun#25589](https://github.com/oven-sh/bun/issues/25589) and
related). The agent-side conversation streamed correctly, but every
tool RPC silently failed, so the agent could chat but couldn't read
or edit files. Switching to the CLI (subprocess + stdio) takes
Bun's HTTP/2 stack out of the loop and makes tool execution work
reliably, with the bonus of OAuth as the default auth path.

### Known limitations

- **No system prompt support.** Unlike Claude Code's
`--append-system-prompt`, `cursor-agent` doesn't expose a
system-prompt option. Issuely's guardrail prompt is dropped on
Cursor turns; project-level context still loads from `.cursor/`
rules in the working directory.
- **Tool inventory differs from Claude Code.** Cursor exposes
`semSearch`, `createPlan`, and `task` (subagent) tools that Claude
Code doesn't, and vice versa. We map known tools by name and
forward unknown ones with their CLI name as the tool label, so
Linear surfaces them without crashing the parser.

## [0.2.0](https://github.com/fatwang2/kanban/releases/tag/v0.2.0) — 2026-04-20

Issuely now speaks **Codex** as well as Claude Code. Same bridge, same
Linear thread, same plan checklist — pick your agent with a single
environment variable.

### Highlights

- **Codex backend** via [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk),
which bundles the Rust `codex` binary per platform. Runs on your
local `codex login` — your ChatGPT Plus / Pro / Team subscription,
no API key needed.
- **One-variable agent switch**: `DEFAULT_AGENT=claude-code` or
`DEFAULT_AGENT=codex`. Both backends are registered at startup and
probed independently; an unavailable backend is logged and skipped.
- **Shared machinery**: plan-sync, stop signals, session resume,
workdir mapping, OAuth token refresh — every behavior that already
worked for Claude Code works for Codex with no extra code.

### Added

- **`CodexBackend`** (`src/agents/codex.ts`) implementing the existing
`AgentBackend` interface. Maps Codex `ThreadEvent` / `ThreadItem`
onto the canonical `AgentMessage` union:
  - `agent_message` → `text`
  - `reasoning` → `thinking`
  - `command_execution` → `tool_use` (`Bash`)
  - `file_change` → `tool_use` (`Edit` / `MultiEdit`)
  - `mcp_tool_call` → `tool_use` (`mcp:<server>:<tool>`)
  - `web_search` → `tool_use` (`WebSearch`)
  - `todo_list` → `tool_use` (`TodoWrite`) — deliberately matching
    Claude Code's shape so the dispatcher's existing
    `parseTodoWritePlan` syncs Codex plans to Linear without knowing
    which backend produced them.
  - `error` → `error`
- **Session resume for Codex** via `codex.resumeThread(threadId)`;
`thread.started` events are captured and returned as `AgentResult.sessionId`,
so follow-up replies continue the same Codex thread the same way
Claude Code sessions already do.
- **Codex configuration** via new env vars: `CODEX_API_KEY`,
`CODEX_PATH`, `CODEX_MODEL`, `CODEX_APPROVAL_POLICY`
(`never` / `on-request` / `on-failure` / `untrusted`),
`CODEX_SANDBOX_MODE` (`read-only` / `workspace-write` /
`danger-full-access`). Approval defaults to `never` to match
Claude Code's `bypassPermissions` — anything stricter would stall
without a TTY.
- **Abort wiring**: the `AgentSession.abort()` path threads into an
`AbortController` passed to `thread.runStreamed({ signal })`, so the
Linear stop button kills in-flight Codex turns the same way it kills
Claude Code subprocesses.

### Changed

- **`isAvailable()` switched to dynamic `import()`** under Bun —
`require.resolve` returns module-not-found for workspace packages in
the ESM loader, which caused Codex to be marked unavailable even
when the SDK and binary were installed.
- **README / README.zh-CN**: updated tagline, prerequisites,
architecture diagram, and a new section documenting the Codex
approval policy and sandbox modes.

### Known limitations

- **No `canUseTool` callback on Codex**. The SDK exposes approval
policies and sandbox modes but not per-tool runtime interception.
For a programmatic gate, use Codex's `~/.codex/hooks.json`
`PreToolUse` hook (external command, exit code decides).
- **ChatGPT subscription rate limits**. Bursty webhook traffic can
hit per-hour / per-day caps; fall back to `CODEX_API_KEY` for
pay-as-you-go if that becomes an issue.
- **No `--append-system-prompt` on Codex**. Issuely inlines its
guardrail system prompt into the user prompt on the first turn; this
costs a handful of extra input tokens per new session.

## [0.1.0](https://github.com/fatwang2/kanban/releases/tag/v0.1.0) — 2026-04-11

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
`agentSessionUpdate`. Statuses map `pending / in_progress / completed` → `pending / inProgress / completed`. Short tasks that
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
- **Type-check passes** — `tsc --noEmit` runs cleanly across all modules.

### Known limitations

- **One concurrent task per bridge** by default (`MAX_CONCURRENT=1`).
Long tasks queue follow-ups; raise only if your agent usage is
genuinely parallelizable.
- **Agent session plan is technology preview on Linear's side**. The
JSON shape currently matches Linear's public docs, but may change.
If it does, `LinearSource.updateSessionPlan` is the single update
point.
- **Claude's headless mode is one-shot** — `claude -p` will hang on
requests that try to launch a long-running local dev server until the
task timeout. Use the stop button (it now works) or avoid asking for
persistent processes via the bridge.

