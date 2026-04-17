# Issuely

[English](README.md) | 简体中文

**让 Claude Code 成为你 Linear 团队的一员。**

在 Linear issue 上 @ 它分配任务，使用你本地 Claude Code 订阅，跟你讨论需求，修改本地的项目代码，做完把结果评论回 issue。

- **不换项目管理工具**：继续用你现有的 Linear 来做项目管理，没有新平台、没有迁移成本
- **用订阅，不是 API**：跑在你本地登录好的 Claude Code 上，直接吃你的订阅额度（Pro / Max），不需要 API key
- **完全本地执行**：agent 动的是你自己机器上的代码，session、权限、文件都在你手里

## 架构

```
Linear（webhook） → Issuely Bridge → 本地 Claude Code → Linear（评论）
```

分三层：

- **Issue Tracker Adapter** — 目前接的是 Linear：监听 webhook、把事件统一成 TaskRequest
- **Task Dispatcher** — 排队、控制并发、转发进度更新
- **Agent Adapter** — 目前调起的是 Claude Code CLI：启动子进程、流式回传输出

## 快速开始

### 前置依赖

- [Bun](https://bun.sh) 运行时
- 已安装并登录好的 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
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
2. 把任务派发给 Claude Code CLI
3. 把中间进度（thinking、工具调用、plan）流式同步回 Linear
4. 把最终结果作为 response activity 贴回去

同一 thread 里的 follow-up 回复会自动通过 `--resume` 续上之前那个 Claude Code session，上下文不会丢。

### 项目目录映射

通过 `PROJECT_DIRS` 把 Linear 项目映射到本地仓库：

```bash
PROJECT_DIRS=DesignSystem=/Users/you/repos/ds,Website=/Users/you/repos/web
```

key 是 Linear 里的**项目名**，大小写不敏感。

### Claude Code 权限模式

Issuely Bridge 是非交互运行 Claude Code CLI 的，所以每次调用都会显式传 `--permission-mode`。通过 `.env` 里的 `CLAUDE_CODE_PERMISSION_MODE` 配置：


| 模式                  | 行为                                             |
| ------------------- | ---------------------------------------------- |
| `default`           | 敏感工具会弹出确认提示 —— webhook 模式下**没人点**，不能用          |
| `acceptEdits`       | 自动接受文件修改（Edit/Write）；其它敏感操作还是会提示               |
| `plan`              | 只读 planning 模式，不会写文件也不会跑命令                     |
| `bypassPermissions` | 跳过所有权限检查（等价于 `--dangerously-skip-permissions`） |


**默认值 `bypassPermissions`**，因为 Issuely Bridge 本身就是非交互的。想要个更安全的中间档，切到 `acceptEdits`。

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

