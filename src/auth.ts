import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const cookieName = "claw_session";
const sessionDurationSeconds = 7 * 24 * 60 * 60;

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function sessionSecret(): string {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  }
  return secret;
}

export function assertAuthConfigured(): void {
  if (!process.env.APP_USERNAME || !process.env.APP_PASSWORD) {
    throw new Error("APP_USERNAME and APP_PASSWORD are required");
  }
  sessionSecret();
}

export function verifyCredentials(username: string, password: string): boolean {
  const expectedUsername = process.env.APP_USERNAME ?? "";
  const expectedPassword = process.env.APP_PASSWORD ?? "";
  return secureEqual(username, expectedUsername) && secureEqual(password, expectedPassword);
}

export function createSessionToken(username: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ username, expiresAt: now + sessionDurationSeconds * 1000 })
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, now: number = Date.now()): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!secureEqual(signature, expected)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      username?: string;
      expiresAt?: number;
    };
    return (
      data.username === process.env.APP_USERNAME &&
      typeof data.expiresAt === "number" &&
      data.expiresAt > now
    );
  } catch {
    return false;
  }
}

export function isAuthenticated(request: IncomingMessage): boolean {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const sessionCookie = cookies
    .map((cookie) => cookie.trim().split("="))
    .find(([name]) => name === cookieName);
  return sessionCookie ? verifySessionToken(sessionCookie.slice(1).join("=")) : false;
}

export function sessionCookie(token: string): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionDurationSeconds}`;
}

export function expiredSessionCookie(): string {
  return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
