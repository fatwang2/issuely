# Kanban Agent Bridge

Bridge between kanban tools (Linear, GitHub Issues, Jira) and local AI agents (Claude Code, Codex CLI).

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
   cloudflared tunnel create kanban-bridge

   # Configure the tunnel to point to localhost:3000
   # Add to ~/.cloudflared/config.yml:
   #   tunnel: <TUNNEL_ID>
   #   credentials-file: ~/.cloudflared/credentials/<TUNNEL_ID>.json
   #   ingress:
   #     - hostname: kanban-bridge.yourdomain.com
   #       service: http://localhost:3000
   #     - service: http_status:404

   # Route DNS (one-time)
   cloudflared tunnel route dns kanban-bridge kanban-bridge.yourdomain.com

   # Start the tunnel
   cloudflared tunnel run kanban-bridge
   ```

   Or for quick testing without a domain:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. **Create a Linear OAuth application:**
   - Go to https://linear.app/settings/api/applications
   - Create a new application
   - Set redirect URL to `https://kanban-bridge.yourdomain.com/oauth/callback`
   - Subscribe to **Agent session** webhook events
   - Set webhook URL to `https://kanban-bridge.yourdomain.com/webhook`

4. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   # Set BASE_URL=https://kanban-bridge.yourdomain.com
   ```

5. **Start the bridge:**
   ```bash
   bun run dev
   ```

6. **Authorize with Linear:**
   - Visit `http://localhost:3000/oauth/authorize`
   - Complete the OAuth flow

### Usage

In any Linear issue, @mention your agent app. The bridge will:
1. Receive the webhook event
2. Dispatch the task to Claude Code CLI
3. Stream progress updates back to Linear
4. Post the final result as a comment

### Project Directory Mapping

Map Linear projects/teams to local directories:

```bash
PROJECT_DIRS=proj_abc123=/Users/you/repos/frontend,proj_def456=/Users/you/repos/backend
```

Or override per-request by including `dir:/path/to/repo` in your @mention message.

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
