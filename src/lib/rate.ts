import type { AppEnv } from "../env";
import { bytesToBase64Url } from "./encoding";

async function bucketKey(env: AppEnv, bucket: string, request: Request): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.ADMIN_PASSWORD) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${env.ADMIN_PASSWORD}:${bucket}:${ip}`),
  );
  return `rl:${bucket}:${bytesToBase64Url(digest).slice(0, 32)}`;
}

export async function failureBlocked(env: AppEnv, bucket: string, request: Request, limit: number): Promise<boolean> {
  const key = await bucketKey(env, bucket, request);
  if (!key) return false;
  const current = Number((await env.CODES.get(key)) || "0");
  return Number.isFinite(current) && current >= limit;
}

export async function noteFailure(env: AppEnv, bucket: string, request: Request, windowSeconds: number): Promise<void> {
  const key = await bucketKey(env, bucket, request);
  if (!key) return;
  const current = Number((await env.CODES.get(key)) || "0");
  const next = Number.isFinite(current) ? current + 1 : 1;
  await env.CODES.put(key, String(next), { expirationTtl: windowSeconds });
}

export async function clearFailures(env: AppEnv, bucket: string, request: Request): Promise<void> {
  const key = await bucketKey(env, bucket, request);
  if (!key) return;
  await env.CODES.delete(key);
}

/** Count this request toward a limit. Returns true when the caller should be rejected. */
export async function hitLimit(
  env: AppEnv,
  bucket: string,
  request: Request,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const key = await bucketKey(env, bucket, request);
  if (!key) return false;
  const current = Number((await env.CODES.get(key)) || "0");
  const count = Number.isFinite(current) ? current : 0;
  if (count >= limit) return true;
  await env.CODES.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return false;
}
