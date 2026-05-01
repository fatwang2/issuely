# Issuely

[English](README.md) | 简体中文

**让 Claude Code、Codex 或 Cursor 成为你 Linear 团队的一员。**

在 Linear issue 上 @ 它分配任务，使用你本地的 agent（Claude Code、Codex 或 Cursor），跟你讨论需求，修改本地的项目代码，做完把结果评论回 issue。

- **不换项目管理工具**：继续用你现有的 Linear 来做项目管理，没有新平台、没有迁移成本
- **用订阅，不是 API**：跑在你已经付费的 Claude Code（Pro / Max）、Codex（ChatGPT Plus / Pro / Team）或 Cursor（Pro）上，用量直接走订阅额度
- **一行切换 agent**：`DEFAULT_AGENT=claude-code`、`codex` 或 `cursor`，所有 backend 共用同一套 dispatcher、plan 同步、stop 信号、会话 resume
- **完全本地执行**：agent 动的是你自己机器上的代码，session、权限、文件都在你手里

## 架构

```
Linear（webhook） → Issuely Bridge → 本地 Claude Code / Codex / Cursor → Linear（评论）
```

分三层：

- **Issue Tracker Adapter** — 目前接的是 Linear：监听 webhook、把事件统一成 TaskRequest
- **Task Dispatcher** — 排队、控制并发、转发进度更新
- **Agent Adapter** — Claude Code CLI、Codex（通过 [`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk)，会按平台自带 Rust `codex` 二进制）或 [Cursor CLI](https://cursor.com/docs/cli)（`cursor-agent` 的 `--print` 模式）：启动 agent、流式回传输出

## 快速开始

### 前置依赖

- [Bun](https://bun.sh) 运行时
- 至少配好一个 agent：
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)（`claude login`），和/或
  - [Codex CLI](https://github.com/openai/codex)（`codex login`）——`@openai/codex-sdk` 会自动带上对应平台的原生二进制，和/或
  - [Cursor CLI](https://cursor.com/docs/cli)（`cursor-agent login`）——通过 OAuth 登录，用量走你的 Cursor 订阅
- 一个 Linear workspace（需要 admin 权限用来配 OAuth app）
- 一个可以被 Linear 访问到的公网 URL，推荐用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 起一个

### 配置步骤

1. **安装依赖：**
  ```bash
   bun install
  ```
2. **配置 Cloudflare Tunnel**（固定域名，免费）：
  ```bash
   # 如果还没装 cloudflared
   brew install cloudflare/cloudflare/cloudflared

   # 登录 Cloudflare
   cloudflared tunnel login

   # 创建 tunnel（只需一次）
   cloudflared tunnel create issuely

   # 配置 tunnel 指向 localhost:3010
   # 编辑 ~/.cloudflared/config.yml：
   #   tunnel: <TUNNEL_ID>
   #   credentials-file: ~/.cloudflared/credentials/<TUNNEL_ID>.json
   #   ingress:
   #     - hostname: issuely.yourdomain.com
   #       service: http://localhost:3010
   #     - service: http_status:404

   # 绑定 DNS（只需一次）
   cloudflared tunnel route dns issuely issuely.yourdomain.com

   # 启动 tunnel
   cloudflared tunnel run issuely
   ```

   不想绑域名、只想快速验证时：

   ```bash
   cloudflared tunnel --url http://localhost:3010
   ```

3. **创建 Linear OAuth 应用：**
  - 访问 [https://linear.app/settings/api](https://linear.app/settings/api)
  - 新建一个 application
  - Redirect URL 填 `https://issuely.yourdomain.com/oauth/callback`
  - 订阅 **Agent session** webhook 事件
  - Webhook URL 填 `https://issuely.yourdomain.com/webhook`
4. **配置环境变量：**
  ```bash
   cp .env.example .env
   # 按你的情况改 .env
   # 记得设置 BASE_URL=https://issuely.yourdomain.com
  ```
5. **启动 Issuely Bridge：**
  ```bash
   bun run dev
  ```
6. **授权 Linear：**
  - 浏览器打开 `http://localhost:3010/oauth/authorize`
  - 走完 OAuth 流程

### 使用方式

在任意 Linear issue 里 @ 你的 agent 应用，Issuely Bridge 会：

1. 接收到 webhook 事件
2. 把任务派发给当前配置的 agent（Claude Code、Codex 或 Cursor）
3. 把中间进度（thinking、工具调用、plan）流式同步回 Linear
4. 把最终结果作为 response activity 贴回去

同一 thread 里的 follow-up 回复会自动续上之前的 session（`claude --resume`、`codex.resumeThread()` 或 `cursor-agent --resume`），上下文不会丢。

### 项目目录映射

通过 `PROJECT_DIRS` 把 Linear 项目映射到本地仓库：

```bash
PROJECT_DIRS=DesignSystem=/Users/you/repos/ds,Website=/Users/you/repos/web
```

key 是 Linear 里的**项目名**，大小写不敏感。

### 选择 Agent Backend

`.env` 里设置 `DEFAULT_AGENT`：

- `claude-code`（默认）—— 走 Claude Code CLI
- `codex` —— 通过 `@openai/codex-sdk` 走 Codex
- `cursor` —— 走 Cursor CLI（`cursor-agent`）

所有 backend 启动时都会注册、独立做可用性探测；某一个不可用只会打 warning，不会影响其它。

### Claude Code 权限模式

Issuely Bridge 是非交互运行 Claude Code CLI 的，所以每次调用都会显式传 `--permission-mode`。通过 `.env` 里的 `CLAUDE_CODE_PERMISSION_MODE` 配置：


| 模式                  | 行为                                             |
| ------------------- | ---------------------------------------------- |
| `default`           | 敏感工具会弹出确认提示 —— webhook 模式下**没人点**，不能用          |
| `acceptEdits`       | 自动接受文件修改（Edit/Write）；其它敏感操作还是会提示               |
| `plan`              | 只读 planning 模式，不会写文件也不会跑命令                     |
| `bypassPermissions` | 跳过所有权限检查（等价于 `--dangerously-skip-permissions`） |


**默认值 `bypassPermissions`**，因为 Issuely Bridge 本身就是非交互的。想要个更安全的中间档，切到 `acceptEdits`。

### Codex 审批策略与 Sandbox

Codex 也是非交互运行。通过 `.env` 配置：

| 变量                      | 取值                                                  | 默认值               |
| ----------------------- | --------------------------------------------------- | ----------------- |
| `CODEX_APPROVAL_POLICY` | `never` / `on-request` / `on-failure` / `untrusted` | `never`           |
| `CODEX_SANDBOX_MODE`    | `read-only` / `workspace-write` / `danger-full-access` | `workspace-write` |
| `CODEX_MODEL`           | 你的 Codex CLI 支持的任意模型                                 | CLI 默认值           |
| `CODEX_API_KEY`         | 设了之后不走 ChatGPT 订阅 OAuth，改用按量付费 API key                | 未设（走 OAuth）       |

`never` 等价于 Claude Code 的 `bypassPermissions`——比它更严的策略在 webhook 流程里会卡住，因为没有 TTY 回答审批提示。Codex SDK 目前没有暴露运行时的 `canUseTool` 回调；想做工具粒度的拦截，得配 `~/.codex/hooks.json` 的 `PreToolUse` 钩子。

### Cursor

Cursor 通过 [`cursor-agent` CLI](https://cursor.com/docs/cli) 的 `--print --output-format stream-json` 模式运行。认证由 CLI 自己处理：跑一次 `cursor-agent login` 走 OAuth（推荐），或者设 `CURSOR_API_KEY` 用 dashboard API key 兜底。Bridge 启动 CLI 时会带上 `--force --trust`，跳过权限确认（webhook 模式没有 TTY 应答）。

| 变量                  | 取值                                              | 默认值                  |
| ------------------- | ----------------------------------------------- | -------------------- |
| `CURSOR_AGENT_PATH` | `cursor-agent` 二进制路径                            | PATH 上找 `cursor-agent` |
| `CURSOR_MODEL`      | 你账号支持的任意 Cursor 模型                              | CLI 默认值              |
| `CURSOR_API_KEY`    | （可选）没跑 `login` 时的 API key 兜底                    | 未设（走 OAuth）          |

会话 resume 走 `cursor-agent --resume <session_id>`，跟 Claude Code 的 `--resume` 流程对齐。

> **注：** 我们**不**用 [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) TypeScript SDK。它的本地 runtime 走 connect-rpc/HTTP/2 跟内嵌 binary 通信，目前在 Bun 下有 bug（[oven-sh/bun#25589](https://github.com/oven-sh/bun/issues/25589) 等），工具调用会静默失败。CLI 走 stdio，把 Bun 从协议关键路径里摘了出去。

## 开发

```bash
bun run dev    # 热重载启动
bun run start  # 普通启动
```

## 扩展新的 Agent

在 `src/agents/` 下实现 `AgentBackend` 接口：

```typescript
import type { AgentBackend, AgentSession, ExecOptions } from "./types";

export class MyAgentBackend implements AgentBackend {
  readonly name = "my-agent";

  async isAvailable(): Promise<boolean> { /* 检查 CLI 是否存在 */ }

  execute(prompt: string, opts: ExecOptions): AgentSession { /* 启动 CLI、流式读输出 */ }
}
```

然后在 `src/main.ts` 里注册：

```typescript
agents.register(new MyAgentBackend());
```

## 扩展新的 Issue Tracker 源

在 `src/issue-tracker/` 下实现 `IssueTrackerSource` 接口：

```typescript
import type { IssueTrackerSource, TaskRequest, TaskUpdate } from "./types";

export class MyIssueTrackerSource implements IssueTrackerSource {
  readonly name = "my-tracker";

  async start() { /* 开始监听事件 */ }
  onTaskRequest(handler) { /* 注册 handler */ }
  async postUpdate(task, update) { /* 把结果发回去 */ }
  async stop() { /* 清理 */ }
}
```

