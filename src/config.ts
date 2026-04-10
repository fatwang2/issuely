export interface LinearConfig {
  port: number;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSigningSecret?: string;
  linearUrl: string;
  linearApiUrl: string;
}

export interface DispatcherConfig {
  maxConcurrent: number;
  defaultWorkDir: string;
  timeoutMs: number;
  progressThrottleMs: number;
  projectDirs: Record<string, string>;
}

export interface AgentConfig {
  defaultAgent?: string;
  claudeCode?: {
    path?: string;
    model?: string;
    maxTurns?: number;
  };
}

export interface Config {
  linear: LinearConfig;
  dispatcher: DispatcherConfig;
  agents: AgentConfig;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseProjectDirs(): Record<string, string> {
  const raw = process.env.PROJECT_DIRS;
  if (!raw) return {};
  // Format: "projectId1=/path/to/dir1,projectId2=/path/to/dir2"
  const dirs: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const [key, value] = entry.trim().split("=");
    if (key && value) {
      dirs[key.trim()] = value.trim();
    }
  }
  return dirs;
}

export function loadConfig(): Config {
  return {
    linear: {
      port: parseInt(process.env.PORT || "3010", 10),
      baseUrl: requireEnv("BASE_URL"),
      clientId: requireEnv("LINEAR_CLIENT_ID"),
      clientSecret: requireEnv("LINEAR_CLIENT_SECRET"),
      webhookSigningSecret: process.env.LINEAR_WEBHOOK_SIGNING_SECRET,
      linearUrl: process.env.LINEAR_URL || "https://linear.app",
      linearApiUrl: process.env.LINEAR_API_URL || "https://api.linear.app",
    },
    dispatcher: {
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT || "1", 10),
      defaultWorkDir: process.env.DEFAULT_WORK_DIR || process.cwd(),
      timeoutMs: parseInt(process.env.TIMEOUT_MS || "1200000", 10), // 20 min
      progressThrottleMs: parseInt(
        process.env.PROGRESS_THROTTLE_MS || "5000",
        10
      ),
      projectDirs: parseProjectDirs(),
    },
    agents: {
      defaultAgent: process.env.DEFAULT_AGENT,
      claudeCode: {
        path: process.env.CLAUDE_CODE_PATH,
        model: process.env.CLAUDE_CODE_MODEL,
        maxTurns: process.env.CLAUDE_CODE_MAX_TURNS
          ? parseInt(process.env.CLAUDE_CODE_MAX_TURNS, 10)
          : undefined,
      },
    },
  };
}
