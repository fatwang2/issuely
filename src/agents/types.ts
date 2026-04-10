export type MessageType =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "status"
  | "error";

export interface AgentMessage {
  type: MessageType;
  content: string;
  tool?: string;
  timestamp: number;
}

export interface AgentResult {
  status: "completed" | "failed" | "timeout";
  output: string;
  error?: string;
  durationMs: number;
  sessionId?: string;
}

export interface AgentSession {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
  abort(): void;
}

export interface ExecOptions {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  maxTurns?: number;
  timeoutMs?: number;
  resumeSessionId?: string;
}

export interface AgentBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts: ExecOptions): AgentSession;
}
