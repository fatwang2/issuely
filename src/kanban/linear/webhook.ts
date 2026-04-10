import { createHmac } from "crypto";
import { createLogger } from "../../util/logger";

const log = createLogger("linear-webhook");

export function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret?: string
): boolean {
  if (!secret) {
    log.warn("No webhook signing secret configured, skipping verification");
    return true;
  }
  if (!signature) {
    log.warn("No signature in webhook request");
    return false;
  }

  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");

  return signature === expected;
}

export interface AgentSessionPayload {
  action: string; // "created" | "prompted"
  organizationId: string;
  agentSession: {
    id: string;
    issue: {
      id: string;
      title: string;
      description?: string;
      url: string;
      identifier: string;
      project?: {
        id: string;
        name: string;
      };
      team?: {
        id: string;
        name: string;
      };
    };
    comment?: {
      body: string;
    };
  };
  agentActivity?: {
    id: string;
    content?: {
      body?: string;
      type?: string;
    };
    signal?: string; // "stop" when user stops the agent
  };
  promptContext?: string;
  previousComments?: Array<{
    body: string;
    userId?: string;
    botActorId?: string;
  }>;
}

export function parseAgentSessionEvent(
  body: string
): AgentSessionPayload | null {
  try {
    const data = JSON.parse(body);
    if (!data.agentSession?.id || !data.agentSession?.issue) {
      log.warn("Invalid agent session event: missing required fields");
      return null;
    }
    return data as AgentSessionPayload;
  } catch (e) {
    log.error("Failed to parse webhook body", {
      error: String(e),
    });
    return null;
  }
}
