export interface TaskRequest {
  id: string;
  source: string;
  externalId: string;
  sessionId?: string;
  organizationId: string;
  title: string;
  description: string;
  prompt: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  isFollowUp: boolean; // true for "prompted" events (thread replies)
  metadata: Record<string, unknown>;
}

export interface TaskUpdate {
  type: "thinking" | "progress" | "result" | "error";
  content: string;
  // If set, overrides the default ephemeral policy for this update.
  // Only meaningful for thinking/progress types (Linear only allows
  // ephemeral on thought/action).
  ephemeral?: boolean;
}

export interface StopSignal {
  source: string;
  externalId: string; // issue id
  sessionId: string;
}

export type PlanItemStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface PlanItem {
  content: string;
  status: PlanItemStatus;
}

export interface IssueTrackerSource {
  readonly name: string;
  start(): Promise<void>;
  onTaskRequest(handler: (task: TaskRequest) => void): void;
  onStopSignal(handler: (signal: StopSignal) => void): void;
  postUpdate(task: TaskRequest, update: TaskUpdate): Promise<void>;
  updateSessionPlan(task: TaskRequest, plan: PlanItem[]): Promise<void>;
  stop(): Promise<void>;
}
