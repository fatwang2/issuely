import type { AgentRegistry } from "../agents/registry";
import type { AgentSession } from "../agents/types";
import type { DispatcherConfig } from "../config";
import type {
  KanbanSource,
  PlanItem,
  PlanItemStatus,
  StopSignal,
  TaskRequest,
} from "../kanban/types";
import { createLogger } from "../util/logger";
import type { Task } from "./types";

const log = createLogger("dispatcher");

/**
 * Parse a Claude Code TodoWrite tool_use input (stringified JSON) into
 * Linear plan items. Claude Code's shape:
 *   {todos: [{content, status: "pending"|"in_progress"|"completed", activeForm}]}
 */
function parseTodoWritePlan(rawInput: string): PlanItem[] | null {
  try {
    const parsed = JSON.parse(rawInput) as {
      todos?: Array<{ content?: string; status?: string }>;
    };
    if (!parsed?.todos || !Array.isArray(parsed.todos)) return null;

    const statusMap: Record<string, PlanItemStatus> = {
      pending: "pending",
      in_progress: "inProgress",
      completed: "completed",
    };

    return parsed.todos
      .filter((t) => typeof t.content === "string" && t.content.length > 0)
      .map((t) => ({
        content: t.content!,
        status: statusMap[t.status ?? "pending"] ?? "pending",
      }));
  } catch {
    return null;
  }
}

export class TaskDispatcher {
  private tasks: Map<string, Task> = new Map();
  private running = 0;
  private queue: TaskRequest[] = [];
  private sessions: Map<string, string> = new Map(); // issueId -> agentSessionId (for resume)
  private lastProgressTime: Map<string, number> = new Map();
  // Running agent sessions keyed by kanban session ID (for abort)
  private runningSessions: Map<string, AgentSession> = new Map();

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

      if (request.sessionId) {
        this.runningSessions.set(request.sessionId, session);
      }

      // Stream progress updates (thinking + tool usage)
      for await (const msg of session.messages) {
        if (msg.type === "thinking") {
          const summary =
            msg.content.length > 500
              ? msg.content.slice(0, 500) + "..."
              : msg.content;
          await this.throttledUpdate(request, source, {
            type: "thinking",
            content: summary,
          });
        } else if (msg.type === "tool_use") {
          // Special case: TodoWrite → sync to Linear agent session plan.
          if (msg.tool === "TodoWrite") {
            const plan = parseTodoWritePlan(msg.content);
            if (plan) {
              await source.updateSessionPlan(request, plan);
              continue;
            }
          }
          await this.throttledUpdate(request, source, {
            type: "progress",
            content: `Using tool: ${msg.tool}`,
          });
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

      if (task.userAborted) {
        task.status = "failed";
        log.info("Task stopped by user", { taskId: request.id });
        await source.postUpdate(request, {
          type: "progress",
          content: "Stopped.",
        });
      } else if (result.status === "completed") {
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
      if (request.sessionId) {
        this.runningSessions.delete(request.sessionId);
      }
      this.drainQueue();
    }
  }

  private async throttledUpdate(
    request: TaskRequest,
    source: KanbanSource,
    update: { type: "thinking" | "progress"; content: string }
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastProgressTime.get(request.id) || 0;
    if (now - last < this.config.progressThrottleMs) {
      return;
    }
    this.lastProgressTime.set(request.id, now);
    await source.postUpdate(request, update);
  }

  private resolveWorkDir(request: TaskRequest): string {
    // Try matching mapping keys against project id/name, team id/key/name.
    // Keys are matched case-insensitively.
    const candidates: Array<{ label: string; value?: string }> = [
      { label: "projectId", value: request.projectId },
      { label: "projectName", value: request.projectName },
      { label: "teamId", value: request.teamId },
      { label: "teamKey", value: request.teamKey },
      { label: "teamName", value: request.teamName },
    ];

    for (const [key, dir] of Object.entries(this.config.projectDirs)) {
      const keyLower = key.toLowerCase();
      for (const c of candidates) {
        if (c.value && c.value.toLowerCase() === keyLower) {
          log.info("Resolved workdir by mapping", {
            matchedBy: c.label,
            matchedKey: key,
            dir,
          });
          return dir;
        }
      }
    }

    if (Object.keys(this.config.projectDirs).length > 0) {
      log.warn("No workdir mapping matched; using default", {
        projectId: request.projectId,
        projectName: request.projectName,
        teamId: request.teamId,
        teamKey: request.teamKey,
        teamName: request.teamName,
        availableKeys: Object.keys(this.config.projectDirs),
        defaultWorkDir: this.config.defaultWorkDir,
      });
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

  abort(signal: StopSignal): void {
    // 1. Drop any queued tasks for this session.
    const before = this.queue.length;
    this.queue = this.queue.filter((r) => {
      if (r.sessionId === signal.sessionId) {
        const task = this.tasks.get(r.id);
        if (task) task.status = "failed";
        return false;
      }
      return true;
    });
    const droppedQueued = before - this.queue.length;

    // 2. Abort running session, if any.
    const running = this.runningSessions.get(signal.sessionId);
    if (running) {
      // Mark the running task so the completion path posts "Stopped" not "timeout".
      for (const task of this.tasks.values()) {
        if (
          task.status === "running" &&
          task.request.sessionId === signal.sessionId
        ) {
          task.userAborted = true;
        }
      }
      log.info("Aborting running session", {
        sessionId: signal.sessionId,
        droppedQueued,
      });
      running.abort();
    } else if (droppedQueued > 0) {
      log.info("Dropped queued tasks for stopped session", {
        sessionId: signal.sessionId,
        droppedQueued,
      });
    } else {
      log.warn("Stop signal with no running or queued task", {
        sessionId: signal.sessionId,
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
