import { readFileSync, writeFileSync } from "fs";
import type { LinearConfig } from "../../config";
import { createLogger } from "../../util/logger";

const log = createLogger("linear-oauth");

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type: string;
  scope?: string;
}

type TokenStore = Record<string, TokenData>;

const TOKEN_FILE = ".linear-tokens.json";

function loadTokenStore(): TokenStore {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveTokenStore(store: TokenStore): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2));
}

export function getTokens(organizationId: string): TokenData | undefined {
  const store = loadTokenStore();
  return store[organizationId];
}

export function saveTokens(organizationId: string, tokens: TokenData): void {
  const store = loadTokenStore();
  store[organizationId] = tokens;
  saveTokenStore(store);
  log.info("Saved tokens", { organizationId });
}

export async function exchangeCodeForTokens(
  code: string,
  config: LinearConfig
): Promise<TokenData> {
  const redirectUri = `${config.baseUrl}/oauth/callback`;
  const response = await fetch(`${config.linearApiUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (data.expires_in) {
    data.expires_at = Date.now() + (data.expires_in as number) * 1000;
  }
  return data as unknown as TokenData;
}

export async function refreshAccessToken(
  organizationId: string,
  config: LinearConfig
): Promise<TokenData | null> {
  const tokens = getTokens(organizationId);
  if (!tokens?.refresh_token) return null;

  // Refresh if token expires within 5 minutes
  if (tokens.expires_at && tokens.expires_at - Date.now() > 5 * 60 * 1000) {
    return tokens;
  }

  log.info("Refreshing access token", { organizationId });

  const response = await fetch(`${config.linearApiUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!response.ok) {
    log.error("Token refresh failed", { status: response.status });
    return null;
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (data.expires_in) {
    data.expires_at = Date.now() + (data.expires_in as number) * 1000;
  }
  const newTokens = data as unknown as TokenData;
  saveTokens(organizationId, newTokens);
  return newTokens;
}

export function buildAuthorizationUrl(config: LinearConfig): string {
  const redirectUri = `${config.baseUrl}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
  });
  return `${config.linearUrl}/oauth/authorize?${params}`;
}
