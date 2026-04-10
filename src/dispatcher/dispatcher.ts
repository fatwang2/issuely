import type { AgentRegistry } from "../agents/registry";
import type { DispatcherConfig } from "../config";
import type { KanbanSource, TaskRequest } from "../kanban/types";
import { createLogger } from "../util/logger";
import type { Task } from "./types";

const log = createLogger("dispatcher");

export class TaskDispatcher {
  private tasks: Map<string, Task> = new Map();
  private running = 0;
  private queue: TaskRequest[] = [];
  private sessions: Map<string, string> = new Map(); // issueId -> agentSessionId (for resume)
  private lastProgressTime: Map<string, number> = new Map();

  constructor(
    private agents: AgentRegistry,
    private sources: Map<string, KanbanSource>,
    private config: DispatcherConfig
  ) {}

  async dispatch(request: TaskRequest): Promise<void> {
    const source = this.sources.get(request.source);
    if (!source) {
      log.error("Unknown source", { source: request.source });
      return;
    }

    // Immediately acknowledge (Linear requires <10s response)
    await source.postUpdate(request, {
      type: "thinking",
      content: "Processing your request...",
    });

    const task: Task = {
      request,
      status: "queued",
    };
    this.tasks.set(request.id, task);

    if (this.running >= this.config.maxConcurrent) {
      log.info("Task queued (at capacity)", {
        taskId: request.id,
        queueSize: this.queue.length + 1,
      });
      this.queue.push(request);
      return;
    }

    await this.executeTask(request);
  }

  private async executeTask(request: TaskRequest): Promise<void> {
    const task = this.tasks.get(request.id);
    if (!task) return;

    const agent = this.agents.getDefault();
    if (!agent) {
      log.error("No agent available");
      const source = this.sources.get(request.source);
      if (source) {
        await source.postUpdate(request, {
          type: "error",
          content: "No agent available to process this request.",
        });
      }
      task.status = "failed";
      return;
    }

    this.running++;
    task.status = "running";
    task.agentName = agent.name;
    task.startedAt = Date.now();

    log.info("Executing task", {
      taskId: request.id,
      agent: agent.name,
      issue: request.title,
    });

    const source = this.sources.get(request.source)!;

    // Determine working directory
    const cwd = this.resolveWorkDir(request);

    // Use --resume for follow-up messages to continue the Claude Code session
    const resumeSessionId = request.isFollowUp
      ? this.sessions.get(request.externalId)
      : undefined;

    if (request.isFollowUp && resumeSessionId) {
      log.info("Resuming previous session", {
        issueId: request.externalId,
        resumeSessionId,
      });
    }

    try {
      const systemPrompt = [
        "You are an agent executing a task from a kanban board.",
        "Do NOT interact with Linear, Jira, or any project management tool directly.",
        "Do NOT use Linear MCP tools to read issues, post comments, or update statuses.",
        "Your output will be automatically posted back to the kanban board by the bridge system.",
        "Focus only on the task described in the prompt.",
      ].join(" ");

      const session = agent.execute(request.prompt, {
        cwd,
        resumeSessionId,
        timeoutMs: this.config.timeoutMs,
        systemPrompt,
      });

      // Stream progress updates
      for await (const msg of session.messages) {
        if (msg.type === "tool_use") {
          await this.throttledProgress(request, source, `Using tool: ${msg.tool}`);
        }
      }

      // Get final result
      const result = await session.result;
      task.result = result;
      task.completedAt = Date.now();

      // Save session for resume
      if (result.sessionId) {
        this.sessions.set(request.externalId, result.sessionId);
      }

      if (result.status === "completed") {
        task.status = "completed";
        await source.postUpdate(request, {
          type: "result",
          content: result.output || "Task completed successfully.",
        });
        log.info("Task completed", {
          taskId: request.id,
          durationMs: result.durationMs,
        });
      } else {
        task.status = "failed";
        await source.postUpdate(request, {
          type: "error",
          content: result.error || `Task ${result.status}.`,
        });
        log.error("Task failed", {
          taskId: request.id,
          status: result.status,
          error: result.error,
        });
      }
    } catch (e) {
      task.status = "failed";
      task.completedAt = Date.now();
      await source.postUpdate(request, {
        type: "error",
        content: `Unexpected error: ${e}`,
      });
      log.error("Task execution error", {
        taskId: request.id,
        error: String(e),
      });
    } finally {
      this.running--;
      this.lastProgressTime.delete(request.id);
      this.drainQueue();
    }
  }

  private async throttledProgress(
    request: TaskRequest,
    source: KanbanSource,
    content: string
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastProgressTime.get(request.id) || 0;
    if (now - last < this.config.progressThrottleMs) {
      return;
    }
    this.lastProgressTime.set(request.id, now);
    await source.postUpdate(request, { type: "progress", content });
  }

  private resolveWorkDir(request: TaskRequest): string {
    // Check project-specific directory mapping
    if (request.projectId) {
      const dir = this.config.projectDirs[request.projectId];
      if (dir) return dir;
    }

    // Check for dir: override in prompt
    const dirMatch = request.prompt.match(/dir:(\S+)/);
    if (dirMatch?.[1]) {
      return dirMatch[1];
    }

    return this.config.defaultWorkDir;
  }

  private drainQueue(): void {
    while (this.running < this.config.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.executeTask(next).catch((e) => {
        log.error("Failed to execute queued task", { error: String(e) });
      });
    }
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getStats(): { total: number; running: number; queued: number } {
    return {
      total: this.tasks.size,
      running: this.running,
      queued: this.queue.length,
    };
  }
}
