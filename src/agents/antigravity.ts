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
 * Gemini CLI shipped on 2026-05-19) in headless mode with `-p "<prompt>"`.
 *
 * agy v1.0.0 does NOT expose a stream-json output mode (no `--format` /
 * `--output-format` flag) — `--print` just emits the final assistant
 * response as plain text on stdout. We therefore stream stdout as text
 * chunks and surface a single text AgentMessage, with no tool_use events.
 *
 * The CLI handles auth itself via OS keyring (Google Sign-In) or
 * `ANTIGRAVITY_API_KEY`; we just spawn the process and read stdout.
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
    // agy v1.0.0 flags (verified via `agy --help`):
    //   -p / --print                       single-prompt non-interactive mode
    //   --dangerously-skip-permissions     auto-approve tool calls (no TTY)
    //   --conversation <id>                resume a previous conversation
    // There is no --output-format / --format / --model flag yet.
    const args = [
      this.executablePath,
      "--print",
      "--dangerously-skip-permissions",
    ];

    if (opts.resumeSessionId) {
      args.push("--conversation", opts.resumeSessionId);
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
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (!chunk) continue;
          output += chunk;
          pushMessage({ type: "text", content: chunk, timestamp: Date.now() });
        }

        const tail = decoder.decode();
        if (tail) {
          output += tail;
          pushMessage({ type: "text", content: tail, timestamp: Date.now() });
        }
      } catch (e) {
        log.error("Error reading agy stdout", { error: String(e) });
      }

      let stderrText = "";
      try {
        const stderr = proc.stderr as ReadableStream<Uint8Array>;
        if (stderr) {
          stderrText = await new Response(stderr).text();
        }
      } catch {
        // ignore
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
      } else if (exitCode === 0) {
        status = "completed";
      } else {
        status = "failed";
      }

      if (status === "failed" && stderrText) {
        log.error("agy stderr", { stderr: stderrText.trim().slice(0, 2000) });
      }

      resolveResult({
        status,
        output,
        error:
          status === "failed"
            ? `agy exited with code ${exitCode}${
                stderrText ? `: ${stderrText.trim().split("\n").slice(-3).join(" | ")}` : ""
              }`
            : undefined,
        durationMs,
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
}
