import { spawn, type Subprocess } from "bun";
import { createLogger } from "../util/logger";
import type {
  AgentBackend,
  AgentMessage,
  AgentResult,
  AgentSession,
  ExecOptions,
} from "./types";

const log = createLogger("claude-code");

export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export class ClaudeCodeBackend implements AgentBackend {
  readonly name = "claude-code";
  private executablePath: string;
  private defaultModel?: string;
  private defaultMaxTurns?: number;
  private permissionMode: ClaudeCodePermissionMode;

  constructor(opts?: {
    path?: string;
    model?: string;
    maxTurns?: number;
    permissionMode?: ClaudeCodePermissionMode;
  }) {
    this.executablePath = opts?.path || "claude";
    this.defaultModel = opts?.model;
    this.defaultMaxTurns = opts?.maxTurns;
    this.permissionMode = opts?.permissionMode || "bypassPermissions";
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
    const args = this.buildArgs(opts);
    log.info("Starting Claude Code", { cwd: opts.cwd, args });

    const proc = spawn(args, {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Disable interactive prompts
        DISABLE_INTERACTIVITY: "1",
      },
    });

    // Feed the prompt via stdin as a stream-json user message. Avoids shell
    // escaping issues with long/multiline/backticked content from webhook
    // payloads (Linear comments frequently contain code fences and quotes).
    this.writePromptToStdin(proc, prompt).catch((e) => {
      log.error("Failed to write prompt to stdin", { error: String(e) });
    });

    const startTime = Date.now();
    let aborted = false;

    // Set up timeout
    const timeoutMs = opts.timeoutMs || 1200000;
    const timeoutId = setTimeout(() => {
      log.warn("Agent execution timed out", { timeoutMs });
      aborted = true;
      proc.kill();
    }, timeoutMs);

    const { messages, resultPromise } = this.createStreams(
      proc,
      startTime,
      timeoutMs,
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

  private buildArgs(opts: ExecOptions): string[] {
    const args = [
      this.executablePath,
      // `-p` enables non-interactive (headless) mode. The prompt itself is
      // fed via stdin using --input-format stream-json below.
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      // Only load MCP servers from the daemon's explicit --mcp-config (none,
      // in our case). Prevents the user's global ~/.claude.json MCPs (e.g.
      // a Linear MCP) from being auto-loaded, which would let the agent
      // post to Linear directly and duplicate the bridge's output.
      "--strict-mcp-config",
      "--permission-mode",
      this.permissionMode,
    ];

    const model = opts.model || this.defaultModel;
    if (model) {
      args.push("--model", model);
    }

    const maxTurns = opts.maxTurns || this.defaultMaxTurns;
    if (maxTurns) {
      args.push("--max-turns", String(maxTurns));
    }

    if (opts.systemPrompt) {
      // Append, do NOT replace. Replacing would wipe Claude Code's default
      // system prompt (tool conventions, CLAUDE.md loading, skills, etc.).
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    return args;
  }

  private async writePromptToStdin(
    proc: Subprocess,
    prompt: string
  ): Promise<void> {
    const stdin = proc.stdin as unknown as
      | { write(data: string | Uint8Array): number | Promise<number>; end(): void }
      | null;
    if (!stdin) {
      throw new Error("claude subprocess has no stdin");
    }
    const payload = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    };
    try {
      await stdin.write(JSON.stringify(payload) + "\n");
    } finally {
      stdin.end();
    }
  }

  private createStreams(
    proc: Subprocess,
    startTime: number,
    timeoutMs: number,
    isAborted: () => boolean,
    timeoutId: ReturnType<typeof setTimeout>
  ): { messages: AsyncIterable<AgentMessage>; resultPromise: Promise<AgentResult> } {
    let output = "";
    let lastSessionId: string | undefined;
    let resolveResult!: (result: AgentResult) => void;

    const resultPromise = new Promise<AgentResult>((resolve) => {
      resolveResult = resolve;
    });

    const messageQueue: AgentMessage[] = [];
    let messageResolve: (() => void) | null = null;
    let streamDone = false;

    function pushMessage(msg: AgentMessage) {
      messageQueue.push(msg);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r();
      }
    }

    // Process stdout in background
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
            const msg = this.parseLine(line);
            if (msg) {
              if (msg.type === "text") {
                output += msg.content;
              }
              pushMessage(msg);
            }
            // Extract session ID from result events
            const sessionId = this.extractSessionId(line);
            if (sessionId) lastSessionId = sessionId;
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          const msg = this.parseLine(buffer);
          if (msg) {
            if (msg.type === "text") output += msg.content;
            pushMessage(msg);
          }
        }
      } catch (e) {
        log.error("Error reading stdout", { error: String(e) });
      }

      streamDone = true;
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r();
      }

      clearTimeout(timeoutId);
      const exitCode = await proc.exited;
      const durationMs = Date.now() - startTime;

      let status: AgentResult["status"];
      if (isAborted()) {
        status = "timeout";
      } else if (exitCode === 0) {
        status = "completed";
      } else {
        status = "failed";
      }

      resolveResult({
        status,
        output,
        error: status === "failed" ? `Process exited with code ${exitCode}` : undefined,
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

  private parseLine(line: string): AgentMessage | null {
    try {
      const data = JSON.parse(line);

      // Claude Code stream-json format
      if (data.type === "assistant" && data.message?.content) {
        for (const block of data.message.content) {
          if (block.type === "text") {
            return {
              type: "text",
              content: block.text,
              timestamp: Date.now(),
            };
          }
          if (block.type === "thinking") {
            return {
              type: "thinking",
              content: block.thinking,
              timestamp: Date.now(),
            };
          }
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              content: JSON.stringify(block.input),
              tool: block.name,
              timestamp: Date.now(),
            };
          }
        }
      }

      // "result" event is a summary that duplicates the assistant text — skip it.
      // Session ID extraction is handled separately in extractSessionId().
      if (data.type === "result") {
        return null;
      }

      return null;
    } catch {
      // Not JSON, ignore
      return null;
    }
  }

  private extractSessionId(line: string): string | undefined {
    try {
      const data = JSON.parse(line);
      if (data.type === "result" && data.session_id) {
        return data.session_id;
      }
    } catch {
      // ignore
    }
    return undefined;
  }
}
