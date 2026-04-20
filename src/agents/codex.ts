import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { createLogger } from "../util/logger";
import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentSession,
  ExecOptions,
} from "./types";

const log = createLogger("codex");

export type CodexApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export class CodexBackend implements AgentBackend {
  readonly name = "codex";
  private codex: Codex;
  private defaultModel?: string;
  private approvalPolicy: CodexApprovalMode;
  private sandboxMode: CodexSandboxMode;

  constructor(opts?: {
    apiKey?: string;
    codexPath?: string;
    model?: string;
    approvalPolicy?: CodexApprovalMode;
    sandboxMode?: CodexSandboxMode;
  }) {
    this.codex = new Codex({
      apiKey: opts?.apiKey,
      codexPathOverride: opts?.codexPath,
    });
    this.defaultModel = opts?.model;
    // `never` in headless matches our Claude Code `bypassPermissions` default:
    // Codex never blocks on approval prompts that can't be answered without a TTY.
    this.approvalPolicy = opts?.approvalPolicy || "never";
    this.sandboxMode = opts?.sandboxMode || "workspace-write";
  }

  async isAvailable(): Promise<boolean> {
    // Confirm the SDK (which statically depends on @openai/codex and its
    // platform optional deps) resolved on the current runtime. `@openai/codex`
    // itself has no JS entry point (bin-only), so we only import the SDK.
    // If the platform-specific native binary is missing, execute() will
    // surface a clear spawn error on first use.
    try {
      await import("@openai/codex-sdk");
      return true;
    } catch {
      return false;
    }
  }

  execute(prompt: string, opts: ExecOptions): AgentSession {
    // Codex has no --append-system-prompt equivalent; inline the guardrail
    // into the user prompt. Keep a visible separator so it's easy to spot
    // in session logs.
    const fullPrompt = opts.systemPrompt
      ? `[System instructions]\n${opts.systemPrompt}\n\n[User request]\n${prompt}`
      : prompt;

    const thread = opts.resumeSessionId
      ? this.codex.resumeThread(opts.resumeSessionId, {
          workingDirectory: opts.cwd,
          sandboxMode: this.sandboxMode,
          approvalPolicy: this.approvalPolicy,
          skipGitRepoCheck: true,
          model: opts.model || this.defaultModel,
        })
      : this.codex.startThread({
          workingDirectory: opts.cwd,
          sandboxMode: this.sandboxMode,
          approvalPolicy: this.approvalPolicy,
          skipGitRepoCheck: true,
          model: opts.model || this.defaultModel,
        });

    log.info("Starting Codex thread", {
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      approvalPolicy: this.approvalPolicy,
      sandboxMode: this.sandboxMode,
    });

    const abortController = new AbortController();
    const startTime = Date.now();
    let aborted = false;

    const timeoutMs = opts.timeoutMs || 1200000;
    const timeoutId = setTimeout(() => {
      log.warn("Agent execution timed out", { timeoutMs });
      aborted = true;
      abortController.abort();
    }, timeoutMs);

    const { messages, resultPromise } = this.createStreams(
      thread,
      fullPrompt,
      abortController.signal,
      startTime,
      () => aborted,
      timeoutId
    );

    return {
      messages,
      result: resultPromise,
      abort() {
        aborted = true;
        clearTimeout(timeoutId);
        abortController.abort();
      },
    };
  }

  private createStreams(
    thread: ReturnType<Codex["startThread"]>,
    prompt: string,
    signal: AbortSignal,
    startTime: number,
    isAborted: () => boolean,
    timeoutId: ReturnType<typeof setTimeout>
  ): { messages: AsyncIterable<AgentMessage>; resultPromise: Promise<AgentResult> } {
    let output = "";
    let lastThreadId: string | undefined;
    let failureMessage: string | undefined;
    let resolveResult!: (result: AgentResult) => void;

    const resultPromise = new Promise<AgentResult>((resolve) => {
      resolveResult = resolve;
    });

    const messageQueue: AgentMessage[] = [];
    let messageResolve: (() => void) | null = null;
    let streamDone = false;

    const pushMessage = (msg: AgentMessage) => {
      messageQueue.push(msg);
      if (messageResolve) {
        const r: () => void = messageResolve;
        messageResolve = null;
        r();
      }
    };

    (async () => {
      try {
        const { events } = await thread.runStreamed(prompt, { signal });
        for await (const ev of events) {
          const msg = this.eventToMessage(ev);
          if (msg) {
            if (msg.type === "text") output += msg.content;
            pushMessage(msg);
          }
          if (ev.type === "thread.started") {
            lastThreadId = ev.thread_id;
          }
          if (ev.type === "turn.failed") {
            failureMessage = ev.error?.message || "turn failed";
          }
          if (ev.type === "error") {
            failureMessage = ev.message;
          }
        }
      } catch (e) {
        log.error("Error running Codex thread", { error: String(e) });
        failureMessage = String(e);
      }

      streamDone = true;
      if (messageResolve) {
        const r: () => void = messageResolve;
        messageResolve = null;
        r();
      }

      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      let status: AgentResult["status"];
      if (isAborted()) {
        status = "timeout";
      } else if (failureMessage) {
        status = "failed";
      } else {
        status = "completed";
      }

      resolveResult({
        status,
        output,
        error: failureMessage,
        durationMs,
        sessionId: lastThreadId,
      });
    })();

    const messages: AsyncIterable<AgentMessage> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentMessage>> {
            while (true) {
              if (messageQueue.length > 0) {
                return { value: messageQueue.shift()!, done: false };
              }
              if (streamDone) {
                return { value: undefined as any, done: true };
              }
              await new Promise<void>((resolve) => {
                messageResolve = resolve;
              });
            }
          },
        };
      },
    };

    return { messages, resultPromise };
  }

  /**
   * Map a Codex ThreadEvent to our canonical AgentMessage. Only "completed"
   * items are forwarded — "started/updated" create noise since each item
   * eventually completes with the same (or fuller) payload.
   *
   * The TodoWrite mapping deliberately matches Claude Code's tool_use shape
   * so the dispatcher's `parseTodoWritePlan` can sync Codex plans to Linear
   * without knowing which backend produced them.
   */
  private eventToMessage(ev: ThreadEvent): AgentMessage | null {
    const ts = Date.now();
    if (ev.type !== "item.completed" && ev.type !== "item.started") return null;
    // Surface todo_list updates as soon as they start so Linear sees
    // plan changes in real time, but skip other item-started events.
    if (ev.type === "item.started" && ev.item.type !== "todo_list") return null;

    const item: ThreadItem = ev.item;
    switch (item.type) {
      case "agent_message":
        return { type: "text", content: item.text, timestamp: ts };
      case "reasoning":
        return { type: "thinking", content: item.text, timestamp: ts };
      case "command_execution":
        return {
          type: "tool_use",
          tool: "Bash",
          content: JSON.stringify({ command: item.command }),
          timestamp: ts,
        };
      case "file_change":
        return {
          type: "tool_use",
          tool: item.changes.length === 1 ? "Edit" : "MultiEdit",
          content: JSON.stringify({
            changes: item.changes.map((c) => ({ path: c.path, kind: c.kind })),
          }),
          timestamp: ts,
        };
      case "mcp_tool_call":
        return {
          type: "tool_use",
          tool: `mcp:${item.server}:${item.tool}`,
          content: JSON.stringify(item.arguments ?? {}),
          timestamp: ts,
        };
      case "web_search":
        return {
          type: "tool_use",
          tool: "WebSearch",
          content: JSON.stringify({ query: item.query }),
          timestamp: ts,
        };
      case "todo_list":
        return {
          type: "tool_use",
          tool: "TodoWrite",
          content: JSON.stringify({
            todos: item.items.map((t) => ({
              content: t.text,
              status: t.completed ? "completed" : "pending",
              activeForm: t.text,
            })),
          }),
          timestamp: ts,
        };
      case "error":
        return { type: "error", content: item.message, timestamp: ts };
      default:
        return null;
    }
  }
}
