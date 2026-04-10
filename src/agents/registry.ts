import { createLogger } from "../util/logger";
import type { AgentBackend } from "./types";

const log = createLogger("agent-registry");

export class AgentRegistry {
  private backends: Map<string, AgentBackend> = new Map();
  private defaultName?: string;

  constructor(defaultName?: string) {
    this.defaultName = defaultName;
  }

  register(backend: AgentBackend): void {
    this.backends.set(backend.name, backend);
    log.debug("Registered agent backend", { name: backend.name });
  }

  get(name: string): AgentBackend | undefined {
    return this.backends.get(name);
  }

  getDefault(): AgentBackend | undefined {
    if (this.defaultName) {
      return this.backends.get(this.defaultName);
    }
    // Return first available
    const first = this.backends.values().next();
    return first.done ? undefined : first.value;
  }

  async detectAvailable(): Promise<string[]> {
    const available: string[] = [];
    for (const [name, backend] of this.backends) {
      if (await backend.isAvailable()) {
        available.push(name);
        log.info("Agent available", { name });
      } else {
        log.warn("Agent not available", { name });
      }
    }
    return available;
  }

  list(): string[] {
    return Array.from(this.backends.keys());
  }
}
