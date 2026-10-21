import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function integrationToken(): string {
  return process.env.SCREENER_API_TOKEN ?? process.env.FIN_TWT_API_TOKEN ?? "";
}

export function assertIntegrationAuthConfigured(): void {
  const token = integrationToken();
  if (!token || token.length < 32) {
    throw new Error("SCREENER_API_TOKEN must contain at least 32 characters");
  }
}

export function isFinTwtAuthenticated(request: IncomingMessage): boolean {
  const token = integrationToken();
  if (token.length < 32) return false;
  const authorization = request.headers.authorization ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(match?.[1]) && secureEqual(match?.[1] ?? "", token);
}

export const assertScreenerApiAuthConfigured = assertIntegrationAuthConfigured;
export const isScreenerApiAuthenticated = isFinTwtAuthenticated;
