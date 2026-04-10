import { LinearClient } from "@linear/sdk";
import { v4 as uuid } from "uuid";
import type { LinearConfig } from "../../config";
import { createLogger } from "../../util/logger";
import type { KanbanSource, TaskRequest, TaskUpdate } from "../types";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getTokens,
  refreshAccessToken,
  saveTokens,
} from "./oauth";
import {
  verifyWebhookSignature,
  parseAgentSessionEvent,
  type AgentSessionPayload,
} from "./webhook";

const log = createLogger("linear-source");

export class LinearSource implements KanbanSource {
  readonly name = "linear";
  private config: LinearConfig;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private handler: ((task: TaskRequest) => void) | null = null;
  private clients: Map<string, LinearClient> = new Map();

  constructor(config: LinearConfig) {
    this.config = config;
  }

  onTaskRequest(handler: (task: TaskRequest) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const config = this.config;

    this.server = Bun.serve({
      port: config.port,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/") {
          return new Response("Kanban Agent Bridge is running", {
            status: 200,
          });
        }

        if (req.method === "GET" && url.pathname === "/oauth/authorize") {
          return this.handleOAuthAuthorize();
        }

        if (req.method === "GET" && url.pathname === "/oauth/callback") {
          return this.handleOAuthCallback(url);
        }

        if (req.method === "POST" && url.pathname === "/webhook") {
          return this.handleWebhook(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    log.info(`Linear source started on port ${config.port}`);
  }

  async stop(): Promise<void> {
    this.server?.stop();
    log.info("Linear source stopped");
  }

  async postUpdate(task: TaskRequest, update: TaskUpdate): Promise<void> {
    if (!task.sessionId) {
      log.error("Cannot post update: no session ID");
      return;
    }

    const tokens = getTokens(task.organizationId);
    if (!tokens) {
      log.error("Cannot post update: no tokens", {
        organizationId: task.organizationId,
      });
      return;
    }

    const mutation = `
      mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `;

    // content is a JSONObject with type inside it
    let content: Record<string, string>;
    switch (update.type) {
      case "thinking":
        content = { type: "thought", body: update.content };
        break;
      case "progress":
        content = { type: "action", action: update.content, parameter: "" };
        break;
      case "result":
        content = { type: "response", body: update.content };
        break;
      case "error":
        content = { type: "error", body: update.content };
        break;
    }

    const input: Record<string, unknown> = {
      agentSessionId: task.sessionId,
      content,
    };
    if (update.type === "progress") {
      input.ephemeral = true;
    }

    try {
      const response = await fetch(
        `${this.config.linearApiUrl}/graphql`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokens.access_token}`,
          },
          body: JSON.stringify({ query: mutation, variables: { input } }),
        }
      );

      if (!response.ok) {
        const text = await response.text();
        log.error("Failed to post activity", {
          status: response.status,
          body: text,
        });
        return;
      }

      log.debug("Posted activity", {
        type: update.type,
        sessionId: task.sessionId,
      });
    } catch (e) {
      log.error("Failed to post activity", {
        error: String(e),
        type: update.type,
      });
    }
  }

  private handleOAuthAuthorize(): Response {
    const url = buildAuthorizationUrl(this.config);
    return Response.redirect(url, 302);
  }

  private async handleOAuthCallback(url: URL): Promise<Response> {
    const code = url.searchParams.get("code");
    if (!code) {
      return new Response("Missing authorization code", { status: 400 });
    }

    try {
      const tokens = await exchangeCodeForTokens(code, this.config);
      const client = new LinearClient({ accessToken: tokens.access_token });
      const org = await client.organization;
      const orgId = org.id;

      saveTokens(orgId, tokens);
      this.clients.set(orgId, client);

      log.info("OAuth completed", { organizationId: orgId, name: org.name });
      return new Response(
        `<html><body><h1>Success!</h1><p>Connected to Linear workspace: ${org.name}</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    } catch (e) {
      log.error("OAuth callback failed", { error: String(e) });
      return new Response(`OAuth failed: ${e}`, { status: 500 });
    }
  }

  private async handleWebhook(req: Request): Promise<Response> {
    const body = await req.text();
    const signature = req.headers.get("linear-signature");

    if (
      !verifyWebhookSignature(
        body,
        signature,
        this.config.webhookSigningSecret
      )
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = parseAgentSessionEvent(body);
    if (!payload) {
      return new Response("OK", { status: 200 });
    }

    // Process asynchronously to respond quickly
    this.processAgentSession(payload).catch((e) => {
      log.error("Failed to process agent session", { error: String(e) });
    });

    return new Response("OK", { status: 200 });
  }

  private async processAgentSession(
    payload: AgentSessionPayload
  ): Promise<void> {
    if (!this.handler) {
      log.warn("No task request handler registered");
      return;
    }

    const { agentSession, agentActivity, organizationId, promptContext, previousComments } =
      payload;
    const { issue, comment } = agentSession;
    const isFollowUp = payload.action === "prompted";

    // Handle stop signal
    if (isFollowUp && agentActivity?.signal === "stop") {
      log.info("Received stop signal", {
        sessionId: agentSession.id,
        issue: issue.identifier,
      });
      // TODO: abort running task for this session
      return;
    }

    // Build prompt based on event type
    let prompt: string;
    if (isFollowUp) {
      // "prompted" event: user sent a follow-up message in the agent thread
      const userMessage = agentActivity?.content?.body || "";
      prompt = `Follow-up message from user on issue "${issue.title}" (${issue.identifier}):\n\n${userMessage}`;
    } else {
      // "created" event: first trigger
      if (promptContext) {
        prompt = promptContext;
      } else if (comment?.body) {
        prompt = `Issue: ${issue.title}\n\n${issue.description || ""}\n\nUser comment: ${comment.body}`;
      } else {
        prompt = `Issue: ${issue.title}\n\n${issue.description || ""}`;
      }

      // Append previous comments as context
      if (previousComments?.length) {
        const history = previousComments
          .map((c) => `[${c.botActorId ? "Agent" : "User"}]: ${c.body}`)
          .join("\n\n");
        prompt += `\n\n--- Previous conversation ---\n${history}`;
      }
    }

    const taskRequest: TaskRequest = {
      id: uuid(),
      source: "linear",
      externalId: issue.id,
      sessionId: agentSession.id,
      organizationId,
      title: issue.title,
      description: issue.description || "",
      prompt,
      projectId: issue.project?.id || issue.team?.id,
      isFollowUp,
      metadata: {
        issueUrl: issue.url,
        issueIdentifier: issue.identifier,
        projectName: issue.project?.name,
        teamName: issue.team?.name,
        action: payload.action,
      },
    };

    log.info("Dispatching task", {
      taskId: taskRequest.id,
      issue: issue.identifier,
      title: issue.title,
      action: payload.action,
      isFollowUp,
    });

    this.handler(taskRequest);
  }

  private async getClient(
    organizationId: string
  ): Promise<LinearClient | null> {
    const existing = this.clients.get(organizationId);
    if (existing) return existing;

    const tokens = await refreshAccessToken(organizationId, this.config);
    if (!tokens) {
      log.error("No tokens for organization", { organizationId });
      return null;
    }

    const client = new LinearClient({ accessToken: tokens.access_token });
    this.clients.set(organizationId, client);
    return client;
  }
}
