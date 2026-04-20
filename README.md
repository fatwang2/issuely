# Issuely

English | [简体中文](README.zh-CN.md)

**Make Claude Code or Codex a member of your Linear team.**

@mention it on a Linear issue to assign a task. It runs on your local Claude Code or Codex subscription, discusses the problem with you, edits code in your local repo, and posts the result back as a comment when it's done.

- **No new project management tool**: keep using your existing Linear — no new platform, no migration cost
- **Subscription, not API**: runs on the Claude Code (Pro / Max) or Codex (ChatGPT Plus / Pro / Team) you're already logged into locally — no API key required
- **Swap agents in one line**: set `DEFAULT_AGENT=claude-code` or `DEFAULT_AGENT=codex`; both backends share the same dispatcher, plan-sync, stop-signal, and session-resume plumbing
- **Fully local execution**: the agent touches code on your own machine; sessions, permissions, and files stay with you

## Architecture

```
Linear (webhook) → Issuely Bridge → Claude Code / Codex (local) → Linear (comment)
```

Three layers:

- **Issue Tracker Adapter** — currently Linear: listens to webhooks, normalizes events into TaskRequests
- **Task Dispatcher** — queues tasks, controls concurrency, forwards progress updates
- **Agent Adapter** — Claude Code CLI or Codex (via [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk), which bundles the Rust `codex` binary per platform): spawns the agent, streams output back

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- At least one local agent logged in:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude login`), and/or
  - [Codex CLI](https://github.com/openai/codex) (`codex login`) — the bundled binary is installed automatically via `@openai/codex-sdk`
- A Linear workspace (admin access required to set up the OAuth app)
- A public URL reachable by Linear — [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is recommended

### Setup

1. **Install dependencies:**
  ```bash
   bun install
  ```
2. **Set up Cloudflare Tunnel** (fixed domain, free):
  ```bash
   # Install cloudflared if you haven't
   brew install cloudflare/cloudflare/cloudflared

   # Login to Cloudflare
   cloudflared tunnel login

   # Create a tunnel (one-time)
   cloudflared tunnel create issuely

   # Point the tunnel at localhost:3010
   # Edit ~/.cloudflared/config.yml:
   #   tunnel: <TUNNEL_ID>
   #   credentials-file: ~/.cloudflared/credentials/<TUNNEL_ID>.json
   #   ingress:
   #     - hostname: issuely.yourdomain.com
   #       service: http://localhost:3010
   #     - service: http_status:404

   # Route DNS (one-time)
   cloudflared tunnel route dns issuely issuely.yourdomain.com

   # Start the tunnel
   cloudflared tunnel run issuely
  ```
   If you just want to try it without binding a domain:
3. **Create a Linear OAuth application:**
  - Go to [https://linear.app/settings/api](https://linear.app/settings/api)
  - Create a new application
  - Set redirect URL to `https://issuely.yourdomain.com/oauth/callback`
  - Subscribe to **Agent session** webhook events
  - Set webhook URL to `https://issuely.yourdomain.com/webhook`
4. **Configure environment:**
  ```bash
   cp .env.example .env
   # Edit .env with your credentials
   # Remember to set BASE_URL=https://issuely.yourdomain.com
  ```
5. **Start Issuely Bridge:**
  ```bash
   bun run dev
  ```
6. **Authorize with Linear:**
  - Visit `http://localhost:3010/oauth/authorize`
  - Complete the OAuth flow

### Usage

@mention your agent app in any Linear issue. Issuely Bridge will:

1. Receive the webhook event
2. Dispatch the task to the configured agent (Claude Code or Codex)
3. Stream progress (thinking, tool use, plan) back to Linear
4. Post the final result as a response activity

Follow-up replies in the same thread automatically resume the previous session (`claude --resume` or `codex.resumeThread()`), so context is preserved.

### Project Directory Mapping

Map Linear projects to local repos via `PROJECT_DIRS`:

```bash
PROJECT_DIRS=DesignSystem=/Users/you/repos/ds,Website=/Users/you/repos/web
```

The key is the **Linear project name**, case-insensitive.

### Choosing the Agent Backend

Set `DEFAULT_AGENT` in `.env`:

- `claude-code` (default) — drives Claude Code CLI
- `codex` — drives Codex via `@openai/codex-sdk`

Both backends are registered at startup and detected independently; an unavailable backend is logged as a warning but doesn't block the other.

### Claude Code Permission Mode

Issuely Bridge runs Claude Code CLI non-interactively, so it passes `--permission-mode` on every invocation. Configure via `CLAUDE_CODE_PERMISSION_MODE` in `.env`:


| Mode                | Behavior                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `default`           | Prompts for confirmation on sensitive tools — **not usable** in webhook mode (no one to confirm) |
| `acceptEdits`       | Auto-accepts file edits (Edit/Write); still prompts for other sensitive ops                      |
| `plan`              | Read-only planning mode; no file writes or command execution                                     |
| `bypassPermissions` | Skips all permission checks (equivalent to `--dangerously-skip-permissions`)                     |


**Default: `bypassPermissions`**, since Issuely Bridge is non-interactive anyway. Switch to `acceptEdits` for a safer middle ground.

### Codex Approval Policy & Sandbox

Codex is also driven non-interactively. Configure via `.env`:

| Variable                | Values                                                                   | Default             |
| ----------------------- | ------------------------------------------------------------------------ | ------------------- |
| `CODEX_APPROVAL_POLICY` | `never` / `on-request` / `on-failure` / `untrusted`                      | `never`             |
| `CODEX_SANDBOX_MODE`    | `read-only` / `workspace-write` / `danger-full-access`                   | `workspace-write`   |
| `CODEX_MODEL`           | Any model accepted by your Codex CLI                                     | CLI default         |
| `CODEX_API_KEY`         | Set to bypass ChatGPT-subscription OAuth and use a pay-as-you-go API key | unset (uses OAuth)  |

`never` matches Claude Code's `bypassPermissions` — anything stricter will stall the webhook flow since no TTY is available to answer approval prompts. Per-tool runtime callbacks (`canUseTool`) aren't exposed by the Codex SDK today; use `~/.codex/hooks.json` `PreToolUse` hooks if you need a gate.

## Development

```bash
bun run dev    # Start with hot reload
bun run start  # Start without hot reload
```

## Adding New Agents

Implement the `AgentBackend` interface in `src/agents/`:

```typescript
import type { AgentBackend, AgentSession, ExecOptions } from "./types";

export class MyAgentBackend implements AgentBackend {
  readonly name = "my-agent";

  async isAvailable(): Promise<boolean> { /* check CLI exists */ }

  execute(prompt: string, opts: ExecOptions): AgentSession { /* spawn CLI, stream output */ }
}
```

Then register it in `src/main.ts`:

```typescript
agents.register(new MyAgentBackend());
```

## Adding New Issue Tracker Sources

Implement the `IssueTrackerSource` interface in `src/issue-tracker/`:

```typescript
import type { IssueTrackerSource, TaskRequest, TaskUpdate } from "./types";

export class MyIssueTrackerSource implements IssueTrackerSource {
  readonly name = "my-tracker";

  async start() { /* start listening for events */ }
  onTaskRequest(handler) { /* register handler */ }
  async postUpdate(task, update) { /* post results back */ }
  async stop() { /* cleanup */ }
}
```

