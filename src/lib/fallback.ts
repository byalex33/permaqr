import { DEFAULT_FALLBACK_MESSAGE } from "../../shared/types";
import type { AppEnv } from "../env";

const SETTINGS_KEY = "fallback_message";
const CACHE_KEY = "settings:fallback";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function getFallbackMessage(env: AppEnv, accountId?: string): Promise<string> {
  if (accountId) return readScopedFallback(env, accountId);
  try {
    const cached = await env.CODES.get(CACHE_KEY);
    if (cached) return cached;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "fallback cache read failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(SETTINGS_KEY)
    .first<{ value: string }>();
  const message = row?.value?.trim() || DEFAULT_FALLBACK_MESSAGE;
  try {
    await env.CODES.put(CACHE_KEY, message);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "fallback cache write failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  return message;
}

export async function setFallbackMessage(env: AppEnv, message: string, accountId?: string): Promise<void> {
  const value = message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, 500);
  const stored = value || DEFAULT_FALLBACK_MESSAGE;
  if (accountId) {
    await env.DB.prepare(
      `INSERT INTO account_settings (account_id, fallback_message) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET fallback_message = excluded.fallback_message`,
    )
      .bind(accountId, stored)
      .run();
    await env.CODES.put(`settings:fallback:account:${accountId}`, stored);
    return;
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(SETTINGS_KEY, stored)
    .run();
  await env.CODES.put(CACHE_KEY, stored);
}

async function readScopedFallback(env: AppEnv, accountId: string): Promise<string> {
  const cacheKey = `settings:fallback:account:${accountId}`;
  try {
    const cached = await env.CODES.get(cacheKey);
    if (cached) return cached;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "fallback cache read failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  const row = await env.DB.prepare("SELECT fallback_message FROM account_settings WHERE account_id = ?")
    .bind(accountId)
    .first<{ fallback_message: string }>();
  const message = row?.fallback_message?.trim() || DEFAULT_FALLBACK_MESSAGE;
  try {
    await env.CODES.put(cacheKey, message);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "fallback cache write failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  return message;
}

export function fallbackPage(options: {
  message: string;
  slug?: string;
  reason: "missing" | "paused" | "setup";
}): Response {
  const title = options.reason === "paused" ? "This code is paused" : "Code not found";
  const eyebrow =
    options.reason === "paused" ? "Paused" : options.reason === "setup" ? "Almost ready" : "Not found";
  const slug = options.slug ? `/${escapeHtml(options.slug)}` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · PermaQR</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
      background:
        radial-gradient(900px 420px at 15% -10%, rgba(226, 59, 42, 0.14), transparent 60%),
        #f3efe4;
      color: #1b1714;
      font: 18px/1.5 Outfit, "Avenir Next", "Segoe UI", sans-serif;
    }
    main {
      width: min(520px, 100%);
      background: #fbf7ef;
      border: 1px solid rgba(27, 23, 20, 0.12);
      border-radius: 22px;
      padding: 36px 32px 32px;
      box-shadow: 0 24px 60px rgba(60, 36, 16, 0.1);
    }
    .mark { display: flex; gap: 8px; align-items: center; font-weight: 650; letter-spacing: -0.03em; }
    .dots { width: 18px; height: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
    .dots i { display: block; background: #1b1714; border-radius: 2px; }
    .dots i:first-child { border-radius: 4px 2px 2px 2px; }
    p.eyebrow {
      margin: 28px 0 0;
      color: #9d2418;
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 650;
    }
    h1 { font: 650 40px/1.05 Fraunces, Georgia, serif; letter-spacing: -0.03em; margin: 8px 0 12px; }
    p { margin: 0; color: #3a342c; }
    code {
      display: inline-block;
      margin-top: 18px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 14px;
      background: #efe8d8;
      padding: 6px 10px;
      border-radius: 999px;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark"><span class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span> PermaQR</div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(options.message)}</p>
    ${slug ? `<code>${slug}</code>` : ""}
  </main>
</body>
</html>`;
  return new Response(html, {
    status: options.reason === "setup" ? 503 : 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
