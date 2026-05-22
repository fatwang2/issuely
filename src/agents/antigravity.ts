import { spawn, type Subprocess } from "bun";
import { createLogger } from "../util/logger";
import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentSession,
  ExecOptions,
} from "./types";

const log = createLogger("antigravity");

/**
 * Antigravity backend driven by Google's `agy` CLI (the Go rewrite of
 * Gemini CLI shipped on 2026-05-19) in headless mode with
 * `-p "<prompt>" --output-format stream-json`.
 *
 * The CLI handles auth itself via OS keyring (Google Sign-In) or
 * `ANTIGRAVITY_API_KEY`; we just spawn the process and parse its stdout.
 * Same shape as `cursor.ts` — only the event vocabulary differs.
 *
 * stream-json event types per the headless reference:
 *   init | message | tool_use | tool_result | error | result
 */
export class AntigravityBackend implements AgentBackend {
  readonly name = "antigravity";
  private executablePath: string;
  private defaultModel?: string;

  constructor(opts?: { path?: string; model?: string }) {
    this.executablePath = opts?.path || "agy";
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
      log.debug("agy has no system-prompt flag; ignoring");
    }

    const args = this.buildArgs(prompt, opts);
    log.info("Starting agy", {
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
      prompt,
      "--output-format",
      "stream-json",
      // No TTY in webhook context, so the agent must not block on
      // tool-approval prompts. `--yolo` (inherited from Gemini CLI) is the
      // documented "auto-accept everything" flag.
      "--yolo",
    ];

    const model = opts.model || this.defaultModel;
    if (model) {
      args.push("-m", model);
    }

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

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
        log.error("Error reading agy stdout", { error: String(e) });
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
              ? "agy reported error event"
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
   * Parse one stream-json line. Event schema per the Antigravity/Gemini CLI
   * headless reference:
   *   - init        : session metadata { session_id, model }
   *   - message     : assistant chunk     { role, content }
   *   - tool_use    : tool invocation     { name, args }
   *   - tool_result : tool output         (dropped to avoid Linear noise)
   *   - error       : non-fatal warning
   *   - result      : final stats         { is_error?, ... }
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

    switch (data.type) {
      case "init":
        return { sessionId };

      case "message": {
        if (data.role && data.role !== "assistant") return { sessionId };
        const content = extractText(data.content);
        if (!content) return { sessionId };
        return {
          sessionId,
          message: { type: "text", content, timestamp: Date.now() },
        };
      }

      case "tool_use": {
        const tool = mapToolName(String(data.name ?? ""));
        const args = data.args ?? data.input ?? {};
        const content =
          tool === "TodoWrite"
            ? JSON.stringify(toClaudeCodeTodos(args))
            : JSON.stringify(args);
        return {
          sessionId,
          message: { type: "tool_use", tool, content, timestamp: Date.now() },
        };
      }

      case "tool_result":
        return { sessionId };

      case "error":
        return {
          sessionId,
          isError: data.fatal === true,
          message: {
            type: "error",
            content: String(data.message ?? data.error ?? "agy error"),
            timestamp: Date.now(),
          },
        };

      case "result":
        return { sessionId, isError: data.is_error === true };

      default:
        return { sessionId };
    }
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof b.text === "string") return b.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Map agy tool names to Claude Code's vocabulary so the dispatcher's plan
 * parser (which keys off Claude Code tool names) works unchanged.
 *
 * Names are best-effort: the headless reference does not enumerate them.
 * Unknown names pass through verbatim.
 */
function mapToolName(name: string): string {
  switch (name) {
    case "read_file":
    case "ReadFile":
      return "Read";
    case "edit_file":
    case "EditFile":
      return "Edit";
    case "write_file":
    case "WriteFile":
      return "Write";
    case "shell":
    case "run_shell_command":
    case "RunShellCommand":
      return "Bash";
    case "grep":
    case "Grep":
      return "Grep";
    case "glob":
    case "Glob":
      return "Glob";
    case "ls":
    case "list_directory":
      return "LS";
    case "update_todos":
    case "todo_write":
    case "TodoWrite":
      return "TodoWrite";
    case "web_search":
    case "WebSearch":
      return "WebSearch";
    case "web_fetch":
    case "WebFetch":
      return "WebFetch";
    case "task":
    case "subagent":
      return "Task";
    default:
      return name;
  }
}

/**
 * Convert agy todo-update args to Claude Code's TodoWrite shape so the
 * dispatcher's `parseTodoWritePlan` can sync plans to Linear without
 * knowing the source backend. Best-effort — schema may need tuning once
 * a real payload is observed.
 */
function toClaudeCodeTodos(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const todos = (args as { todos?: Array<{ content?: string; status?: string }> })
    .todos;
  if (!Array.isArray(todos)) return args;
  return {
    todos: todos.map((t) => ({
      content: t.content || "",
      status: normalizeTodoStatus(t.status),
      activeForm: t.content || "",
    })),
  };
}

function normalizeTodoStatus(status: string | undefined): string {
  switch (status) {
    case "in_progress":
    case "IN_PROGRESS":
      return "in_progress";
    case "completed":
    case "COMPLETED":
    case "done":
      return "completed";
    case "pending":
    case "PENDING":
    case "todo":
    default:
      return "pending";
  }
}
