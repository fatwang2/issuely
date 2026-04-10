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
  isFollowUp: boolean; // true for "prompted" events (thread replies)
  metadata: Record<string, unknown>;
}

export interface TaskUpdate {
  type: "thinking" | "progress" | "result" | "error";
  content: string;
}

export interface KanbanSource {
  readonly name: string;
  start(): Promise<void>;
  onTaskRequest(handler: (task: TaskRequest) => void): void;
  postUpdate(task: TaskRequest, update: TaskUpdate): Promise<void>;
  stop(): Promise<void>;
}
