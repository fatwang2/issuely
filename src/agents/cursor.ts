import { spawn, type Subprocess } from "bun";
import { createLogger } from "../util/logger";
import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentSession,
  ExecOptions,
} from "./types";

const log = createLogger("cursor");

/**
 * Cursor backend driven by the standalone `cursor-agent` CLI in `--print`
 * (headless) mode with `--output-format stream-json`. The CLI handles auth
 * itself via `cursor-agent login` (OAuth) or `CURSOR_API_KEY`; we just spawn
 * the process and parse its stdout, identical to the Claude Code pattern.
 *
 * Why CLI and not @cursor/sdk: the SDK's local runtime talks to its embedded
 * binary over connect-rpc/HTTP/2, which hits an unresolved bug in Bun's
 * `node:http2` (NGHTTP2_FRAME_SIZE_ERROR on tool calls). The CLI uses plain
 * stdio, so Bun is no longer in the protocol critical path.
 */
export class CursorBackend implements AgentBackend {
  readonly name = "cursor";
  private executablePath: string;
  private defaultModel?: string;

  constructor(opts?: { path?: string; model?: string }) {
    this.executablePath = opts?.path || "cursor-agent";
    this.defaultModel = opts?.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.executablePath, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  }

  execute(prompt: string, opts: ExecOptions): AgentSession {
    if (opts.systemPrompt) {
      log.debug("cursor-agent has no --append-system-prompt; ignoring");
    }

    const args = this.buildArgs(prompt, opts);
    log.info("Starting cursor-agent", {
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model || this.defaultModel,
    });

    const proc = spawn(args, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const startTime = Date.now();
    let aborted = false;

    const timeoutMs = opts.timeoutMs || 1200000;
    const timeoutId = setTimeout(() => {
      log.warn("Agent execution timed out", { timeoutMs });
      aborted = true;
      proc.kill();
    }, timeoutMs);

    const { messages, resultPromise } = this.createStreams(
      proc,
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
        proc.kill();
      },
    };
  }

  private buildArgs(prompt: string, opts: ExecOptions): string[] {
    const args = [
      this.executablePath,
      "-p",
      "--output-format",
      "stream-json",
      // `--force` (alias `--yolo`) auto-accepts tool execution, matching the
      // Claude Code `bypassPermissions` default. Without it the CLI would
      // stall on permission prompts since stdin is closed.
      "--force",
      // Trust the workspace without prompting (only meaningful with -p).
      "--trust",
      "--workspace",
      opts.cwd,
    ];

    const model = opts.model || this.defaultModel;
    if (model) {
      args.push("--model", model);
    }

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    args.push(prompt);
    return args;
  }

  private createStreams(
    proc: Subprocess,
    startTime: number,
    isAborted: () => boolean,
    timeoutId: ReturnType<typeof setTimeout>
  ): { messages: AsyncIterable<AgentMessage>; resultPromise: Promise<AgentResult> } {
    let output = "";
    let lastSessionId: string | undefined;
    let resultIsError = false;
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
        const stdout = proc.stdout as ReadableStream<Uint8Array>;
        const reader = stdout.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += new TextDecoder().decode(value);
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = this.parseLine(line);
            if (!parsed) continue;
            if (parsed.sessionId) lastSessionId = parsed.sessionId;
            if (parsed.isError) resultIsError = true;
            if (parsed.message) {
              if (parsed.message.type === "text") output += parsed.message.content;
              pushMessage(parsed.message);
            }
          }
        }

        if (buffer.trim()) {
          const parsed = this.parseLine(buffer);
          if (parsed?.message) {
            if (parsed.message.type === "text") output += parsed.message.content;
            pushMessage(parsed.message);
          }
          if (parsed?.sessionId) lastSessionId = parsed.sessionId;
          if (parsed?.isError) resultIsError = true;
        }
      } catch (e) {
        log.error("Error reading cursor-agent stdout", { error: String(e) });
      }

      streamDone = true;
      if (messageResolve) {
        const r: () => void = messageResolve;
        messageResolve = null;
        r();
      }

      clearTimeout(timeoutId);
      const exitCode = await proc.exited;
      const durationMs = Date.now() - startTime;

      let status: AgentResult["status"];
      if (isAborted()) {
        status = "timeout";
      } else if (exitCode === 0 && !resultIsError) {
        status = "completed";
      } else {
        status = "failed";
      }

      resolveResult({
        status,
        output,
        error:
          status === "failed"
            ? resultIsError
              ? "cursor-agent reported is_error=true"
              : `Process exited with code ${exitCode}`
            : undefined,
        durationMs,
        sessionId: lastSessionId,
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
   * Parse one stream-json line. Returns sessionId/error flags out of band
   * (they don't map to a user-visible AgentMessage) plus an optional
   * AgentMessage to forward.
   *
   * Tool-call started events are forwarded as `tool_use` so the dispatcher
   * sees plan changes (TodoWrite) in real time. Completed events are
   * dropped to avoid duplicating progress in Linear — matches Codex.
   */
  private parseLine(
    line: string
  ): { message?: AgentMessage; sessionId?: string; isError?: boolean } | null {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return null;
    }

    const sessionId: string | undefined = data.session_id;

    if (data.type === "system" && data.subtype === "init") {
      return { sessionId };
    }

    if (data.type === "assistant" && data.message?.content) {
      const blocks = data.message.content as Array<{ type: string; text?: string }>;
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");
      if (!text) return { sessionId };
      return {
        sessionId,
        message: { type: "text", content: text, timestamp: Date.now() },
      };
    }

    if (data.type === "tool_call" && data.subtype === "started") {
      return {
        sessionId,
        message: this.toolCallToMessage(data.tool_call),
      };
    }

    if (data.type === "result") {
      return { sessionId, isError: data.is_error === true };
    }

    return { sessionId };
  }

  /**
   * Map a tool_call.started payload to canonical AgentMessage. The payload
   * shape is `{ <camelCaseName>ToolCall: { args, result? } }` — we
   * deconstruct the wrapper key and translate the tool name to match
   * Claude Code's vocabulary so the dispatcher's plan parser works
   * unchanged.
   */
  private toolCallToMessage(toolCall: unknown): AgentMessage | undefined {
    if (!toolCall || typeof toolCall !== "object") return undefined;
    const entries = Object.entries(toolCall as Record<string, any>);
    if (entries.length === 0) return undefined;
    const [wrapperKey, payload] = entries[0]!;
    const cursorName = wrapperKey.replace(/ToolCall$/, "");
    const tool = mapToolName(cursorName);
    const args = payload?.args ?? {};
    const content =
      tool === "TodoWrite"
        ? JSON.stringify(toClaudeCodeTodos(args))
        : JSON.stringify(args);
    return {
      type: "tool_use",
      tool,
      content,
      timestamp: Date.now(),
    };
  }
}

function mapToolName(cursorName: string): string {
  switch (cursorName) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "shell":
      return "Bash";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
    case "ls":
      return "LS";
    case "updateTodos":
      return "TodoWrite";
    case "semSearch":
      return "WebSearch";
    case "task":
      return "Task";
    case "delete":
      return "Delete";
    case "createPlan":
      return "CreatePlan";
    case "readLints":
      return "ReadLints";
    case "mcp":
      return "mcp";
    default:
      return cursorName;
  }
}

/**
 * Convert Cursor's update_todos args to Claude Code's TodoWrite shape so the
 * dispatcher's `parseTodoWritePlan` can sync Cursor plans to Linear without
 * knowing the source backend.
 */
function toClaudeCodeTodos(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const todos = (args as { todos?: Array<{ content?: string; status?: string }> })
    .todos;
  if (!Array.isArray(todos)) return args;
  return {
    todos: todos.map((t) => ({
      content: t.content || "",
      status: cursorTodoStatusToClaude(t.status),
      activeForm: t.content || "",
    })),
  };
}

function cursorTodoStatusToClaude(status: string | undefined): string {
  switch (status) {
    case "TODO_STATUS_IN_PROGRESS":
      return "in_progress";
    case "TODO_STATUS_COMPLETED":
      return "completed";
    case "TODO_STATUS_PENDING":
    default:
      return "pending";
  }
}
