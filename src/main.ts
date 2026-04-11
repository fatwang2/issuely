import { homedir } from "os";
import { loadConfig } from "./config";
import { ClaudeCodeBackend } from "./agents/claude-code";
import { AgentRegistry } from "./agents/registry";
import { LinearSource } from "./kanban/linear/source";
import { TaskDispatcher } from "./dispatcher/dispatcher";
import { createLogger } from "./util/logger";

const log = createLogger("main");

async function main() {
  log.info("Starting Kanban Agent Bridge...");

  // 1. Load configuration
  const config = loadConfig();

  if (config.dispatcher.defaultWorkDir === homedir()) {
    log.warn(
      "DEFAULT_WORK_DIR is your home directory — Claude Code will launch without a project context. Set PROJECT_DIRS or DEFAULT_WORK_DIR to point at a real repo.",
      { defaultWorkDir: config.dispatcher.defaultWorkDir }
    );
  }
  log.info("Dispatcher config", {
    maxConcurrent: config.dispatcher.maxConcurrent,
    timeoutMs: config.dispatcher.timeoutMs,
    defaultWorkDir: config.dispatcher.defaultWorkDir,
    projectDirKeys: Object.keys(config.dispatcher.projectDirs),
  });

  // 2. Set up agent registry
  const agents = new AgentRegistry(config.agents.defaultAgent);
  agents.register(
    new ClaudeCodeBackend({
      path: config.agents.claudeCode?.path,
      model: config.agents.claudeCode?.model,
      maxTurns: config.agents.claudeCode?.maxTurns,
      permissionMode: config.agents.claudeCode?.permissionMode,
    })
  );

  const available = await agents.detectAvailable();
  if (available.length === 0) {
    log.error(
      "No agents available! Make sure claude CLI is installed and on PATH."
    );
    process.exit(1);
  }
  log.info(`Available agents: ${available.join(", ")}`);

  // 3. Set up kanban sources
  const linear = new LinearSource(config.linear);
  const sources = new Map([["linear", linear as any]]);

  // 4. Set up dispatcher
  const dispatcher = new TaskDispatcher(agents, sources, config.dispatcher);

  // 5. Wire: kanban events -> dispatcher
  linear.onTaskRequest((task) => {
    dispatcher.dispatch(task).catch((e) => {
      log.error("Dispatch failed", { error: String(e), taskId: task.id });
    });
  });
  linear.onStopSignal((signal) => {
    dispatcher.abort(signal);
  });

  // 6. Start listening
  await linear.start();

  log.info("Kanban Agent Bridge is running!");
  log.info(`  OAuth:   ${config.linear.baseUrl}/oauth/authorize`);
  log.info(`  Webhook: ${config.linear.baseUrl}/webhook`);
  log.info(`  Health:  http://localhost:${config.linear.port}/`);

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    await linear.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("Fatal error", { error: String(e) });
  process.exit(1);
});
