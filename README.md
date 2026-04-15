# Issuely

Bridge between issue trackers (Linear, GitHub Issues, Jira) and local AI agents (Claude Code, Codex CLI).

**Core idea:** @mention an agent in a Linear issue, it runs locally using your existing subscription, and posts results back as a comment.

## Architecture

```
Linear (webhook) → Bridge Server → Local Agent (Claude Code CLI) → Linear (comment)
```

Three layers:
- **Kanban Adapter** — Normalizes events from Linear (future: GitHub, Jira) into TaskRequests
- **Task Dispatcher** — Queues tasks, manages concurrency, forwards progress updates
- **Agent Adapter** — Executes prompts via local CLI tools, streams output

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Linear workspace (admin access for OAuth app setup)
- A public URL for webhooks via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)

### Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Set up Cloudflare Tunnel** (fixed domain, free):
   ```bash
   # Install cloudflared if not already installed
   brew install cloudflare/cloudflare/cloudflared

   # Login to Cloudflare
   cloudflared tunnel login

   # Create a tunnel (one-time)
   cloudflared tunnel create issuely

   # Configure the tunnel to point to localhost:3010
   # Add to ~/.cloudflared/config.yml:
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

   Or for quick testing without a domain:
   ```bash
   cloudflared tunnel --url http://localhost:3010
   ```

3. **Create a Linear OAuth application:**
   - Go to https://linear.app/settings/api/applications
   - Create a new application
   - Set redirect URL to `https://issuely.yourdomain.com/oauth/callback`
   - Subscribe to **Agent session** webhook events
   - Set webhook URL to `https://issuely.yourdomain.com/webhook`

4. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   # Set BASE_URL=https://issuely.yourdomain.com
   ```

5. **Start the bridge:**
   ```bash
   bun run dev
   ```

6. **Authorize with Linear:**
   - Visit `http://localhost:3010/oauth/authorize`
   - Complete the OAuth flow

### Usage

In any Linear issue, @mention your agent app. The bridge will:
1. Receive the webhook event
2. Dispatch the task to Claude Code CLI
3. Stream progress updates (thinking, tool use, plan) back to Linear
4. Post the final result as a response activity

Follow-up replies in the same thread automatically resume the previous
Claude Code session via `--resume`, so conversation context is preserved.

### Project Directory Mapping

Map Linear issues to local directories via `PROJECT_DIRS`:

```bash
PROJECT_DIRS=KEY=/path/to/repo,KEY=/path/to/repo
```

Each `KEY` is matched (case-insensitive) against the incoming issue's
`projectId`, `projectName`, `teamId`, `teamKey`, and `teamName` —
whichever hits first wins. The most intuitive keys in practice:

- **Team key** (the issue-id prefix, e.g. `FAT` for `FAT-505`) — good when
  one team maps to one repo.
- **Project name** — good when one team has multiple projects and each
  project maps to a different repo.

Example:

```bash
PROJECT_DIRS=FAT=/Users/you/repos/main,DesignSystem=/Users/you/repos/ds
```

On follow-up replies Linear's webhook omits project info. The bridge
falls back to an in-memory cache (seeded from the original `created`
event) and, if still empty, queries the Linear GraphQL API to resolve
the issue's project. No extra configuration needed — it just works
after the first resolution per issue.

Override per-request by including `dir:/path/to/repo` in your message.

### Stopping a Running Task

Clicking the stop button in a Linear agent thread sends a `stop`
signal to the bridge, which immediately kills the running Claude Code
subprocess and drops any queued follow-ups for the same session.
Linear then shows a `Stopped.` activity in the thread.

### Agent Session Plan

If Claude Code uses its internal `TodoWrite` tool during a task, the
bridge mirrors the todo list to Linear's **agent session plan** via
`agentSessionUpdate`, so you see a live checklist in the thread with
each step's status (`pending` / `inProgress` / `completed`). Short tasks
that don't trigger `TodoWrite` simply have no plan — no action needed.

> Linear's agent plan API is marked as technology preview and the
> rendering UI may evolve.

### Claude Code Permission Mode

The bridge runs Claude Code CLI non-interactively, so it passes `--permission-mode` on every invocation. Configure via `CLAUDE_CODE_PERMISSION_MODE` in `.env`:

| Mode | Behavior |
|---|---|
| `default` | Prompts for confirmation on sensitive tools — **not usable** in webhook mode (no one to confirm) |
| `acceptEdits` | Auto-accepts file edits (Edit/Write); still prompts for other sensitive ops |
| `plan` | Read-only planning mode; no file writes or command execution |
| `bypassPermissions` | Skips all permission checks (equivalent to `--dangerously-skip-permissions`) |

**Default: `bypassPermissions`**, since the bridge is non-interactive. Switch to `acceptEdits` if you want a safer middle ground.

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

## Adding New Kanban Sources

Implement the `KanbanSource` interface in `src/kanban/`:

```typescript
import type { KanbanSource, TaskRequest, TaskUpdate } from "./types";

export class MyKanbanSource implements KanbanSource {
  readonly name = "my-kanban";

  async start() { /* start listening for events */ }
  onTaskRequest(handler) { /* register handler */ }
  async postUpdate(task, update) { /* post results back */ }
  async stop() { /* cleanup */ }
}
```
