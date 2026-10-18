import type { AppEnv } from "../env";
import { hasValidAccessJwt } from "./access";
import { base64UrlToBytes, bytesToBase64Url, sha256Hex } from "./encoding";

export const SESSION_COOKIE = "permaqr_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_SECONDS = 60 * 10;

export async function passwordsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`permaqr-session:${secret}`));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signSession(password: string, now = Date.now()): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ exp: now + SESSION_TTL_SECONDS * 1000 })),
  );
  const key = await hmacKey(password);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifySession(password: string, token: string, now = Date.now()): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const actual = base64UrlToBytes(signature);
  if (!actual) return false;
  const key = await hmacKey(password);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  if (expected.byteLength !== actual.byteLength) return false;
  const matches = crypto.subtle.timingSafeEqual(expected, actual);
  if (!matches) return false;
  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(payloadBytes)) as { exp?: unknown; kind?: unknown };
    // Hosted account cookies share this signature key but must not open the operator dashboard.
    if (data.kind !== undefined) return false;
    return typeof data.exp === "number" && data.exp > now;
  } catch {
    return false;
  }
}

export async function passwordVersion(passwordHash: string): Promise<string> {
  return (await sha256Hex(passwordHash)).slice(0, 16);
}

export async function signAccountSession(
  secret: string,
  accountId: string,
  passwordHash: string,
  now = Date.now(),
): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp: now + SESSION_TTL_SECONDS * 1000,
        kind: "account",
        sub: accountId,
        ver: await passwordVersion(passwordHash),
      }),
    ),
  );
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bytesToBase64Url(signature)}`;
}

export async function readAccountSession(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<{ sub: string; ver: string } | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const actual = base64UrlToBytes(signature);
  if (!actual) return null;
  const key = await hmacKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  if (expected.byteLength !== actual.byteLength) return null;
  if (!crypto.subtle.timingSafeEqual(expected, actual)) return null;
  const payloadBytes = base64UrlToBytes(payload);
  if (!payloadBytes) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      exp?: unknown;
      kind?: unknown;
      sub?: unknown;
      ver?: unknown;
    };
    if (data.kind !== "account") return null;
    if (typeof data.exp !== "number" || data.exp <= now) return null;
    if (typeof data.sub !== "string" || typeof data.ver !== "string") return null;
    return { sub: data.sub, ver: data.ver };
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionCookie(request: Request, token: string, maxAge = SESSION_TTL_SECONDS): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export async function isAuthenticated(request: Request, env: AppEnv): Promise<boolean> {
  if (await hasValidAccessJwt(request, env)) return true;
  if (!env.ADMIN_PASSWORD) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return verifySession(env.ADMIN_PASSWORD, token);
}

async function throttleKey(env: AppEnv, request: Request): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.ADMIN_PASSWORD) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${env.ADMIN_PASSWORD}:${ip}`),
  );
  return `login:${bytesToBase64Url(digest).slice(0, 32)}`;
}

export async function loginBlocked(env: AppEnv, request: Request): Promise<boolean> {
  const key = await throttleKey(env, request);
  if (!key) return false;
  const current = Number((await env.CODES.get(key)) || "0");
  return Number.isFinite(current) && current >= MAX_LOGIN_FAILURES;
}

export async function noteLoginFailure(env: AppEnv, request: Request): Promise<void> {
  const key = await throttleKey(env, request);
  if (!key) return;
  const current = Number((await env.CODES.get(key)) || "0");
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.CODES.put(key, String(next), { expirationTtl: LOGIN_WINDOW_SECONDS });
}

export async function clearLoginFailures(env: AppEnv, request: Request): Promise<void> {
  const key = await throttleKey(env, request);
  if (!key) return;
  await env.CODES.delete(key);
}
