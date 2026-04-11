import type { TaskRequest } from "../kanban/types";
import type { AgentResult } from "../agents/types";

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface Task {
  request: TaskRequest;
  status: TaskStatus;
  agentName?: string;
  startedAt?: number;
  completedAt?: number;
  result?: AgentResult;
  userAborted?: boolean;
}
