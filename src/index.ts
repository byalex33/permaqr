import type { AppEnv } from "./env";
import { accountActor, handleHostedApi, hostedUserCode, isHostedApi, publicConfig, rewriteLanding } from "./hosted-http";
import {
  clearLoginFailures,
  isAuthenticated,
  loginBlocked,
  noteLoginFailure,
  passwordsMatch,
  sessionCookie,
  signSession,
} from "./lib/auth";
import {
  createCode,
  deleteCode,
  exportCsv,
  exportJson,
  getAnalytics,
  getCodeById,
  importPayload,
  listCodes,
  lookupAccountCode,
  lookupCode,
  recordScan,
  updateCode,
  type CodeScope,
} from "./lib/codes";
import { findAccountByHandle } from "./lib/accounts";
import { fallbackPage, getFallbackMessage, setFallbackMessage } from "./lib/fallback";
import { HOSTED_OPERATOR_RESERVED, isHostedMode } from "./lib/hosted-config";
import { databaseNotReady, error, isMissingTable, isSameOrigin, json, readBody, readJson } from "./lib/http";
import { DEFAULT_FALLBACK_MESSAGE } from "../shared/types";

const HTML_HEADERS = {
    "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (cause) {
      if (isMissingTable(cause)) return databaseNotReady();
      console.error(
        JSON.stringify({
          message: "unhandled error",
          error: cause instanceof Error ? cause.message : "unknown",
          path: new URL(request.url).pathname,
        }),
      );
      return error("Internal server error", 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let decoded = url.pathname;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return error("Bad request", 400);
  }
  const path = decoded.replace(/\/+$/, "") || "/";

  if (path.startsWith("/assets/") || path === "/favicon.svg" || path === "/robots.txt" || path === "/og.png") {
    return env.ASSETS.fetch(request);
  }

  if (path === "/health") {
    return json({ ok: true, name: "permaqr" });
  }

  if (path === "/site") {
    return serveLanding(request, env, new URL("/", request.url));
  }

  if (isHostedApi(path)) {
    if (!isHostedMode(env)) return error("Not found", 404);
    return handleHostedApi(request, env, path);
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return handleApi(request, env, path);
  }

  const authed = await isAuthenticated(request, env);

  if (isHostedMode(env) && (path === "/welcome" || path === "/account" || path.startsWith("/account/"))) {
    return serveHostedApp(request, env, path);
  }

  if (path === "/login") {
    if (authed) return Response.redirect(new URL("/app", url).href, 302);
    return serveApp(request, env);
  }

  if (path === "/app" || path.startsWith("/app/")) {
    if (!authed) return Response.redirect(new URL("/login", url).href, 302);
    return serveApp(request, env);
  }

  if (path === "/") {
    if (authed) return Response.redirect(new URL("/app", url).href, 302);
    if (isHostedMode(env) && (await accountActor(request, env))) {
      return Response.redirect(new URL("/account", url).href, 302);
    }
    return serveLanding(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return error("Method not allowed", 405);
  }

  if (isHostedMode(env) && (path === "/u" || path.startsWith("/u/"))) {
    const userCode = hostedUserCode(path.toLowerCase());
    if (!userCode) return missing(env);
    return redirectAccount(request, env, ctx, userCode.handle, userCode.slug);
  }

  const slug = path.slice(1).toLowerCase();
  if (!slug || slug.includes("/")) return missing(env, slug);
  return redirectSlug(request, env, ctx, slug);
}

async function serveLanding(request: Request, env: AppEnv, assetUrl?: URL): Promise<Response> {
  const response = await env.ASSETS.fetch(assetUrl ? new Request(assetUrl, { method: "GET" }) : request);
  if (!isHostedMode(env)) return withHtmlHeaders(response);
  const html = await response.text();
  return withHtmlHeaders(
    new Response(rewriteLanding(html), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  );
}

async function serveHostedApp(request: Request, env: AppEnv, path: string): Promise<Response> {
  const account = await accountActor(request, env);
  if (path === "/account/login") {
    if (account) return Response.redirect(new URL("/account", request.url).href, 302);
    return serveApp(request, env);
  }
  if (path === "/welcome" || path === "/account/setup") return serveApp(request, env);
  if (!account) return Response.redirect(new URL("/account/login", request.url).href, 302);
  return serveApp(request, env);
}

async function serveApp(request: Request, env: AppEnv): Promise<Response> {
  const assetUrl = new URL("/app/index.html", request.url);
  return withHtmlHeaders(await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" })));
}

function withHtmlHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(HTML_HEADERS)) headers.set(key, value);
  headers.set("cache-control", "no-cache");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function redirectSlug(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  slug: string,
): Promise<Response> {
  let looked: Awaited<ReturnType<typeof lookupCode>>;
  try {
    looked = await lookupCode(env, slug);
  } catch (cause) {
    if (isMissingTable(cause)) {
      return fallbackPage({
        reason: "setup",
        message: "This PermaQR instance still needs its database. Apply the D1 migrations, then try the code again.",
      });
    }
    throw cause;
  }
  if (looked.fill) ctx.waitUntil(looked.fill);
  if (!looked.entry) return missing(env, slug);
  if (looked.entry.paused) {
    const message = await getFallbackMessage(env);
    return fallbackPage({ message, slug, reason: "paused" });
  }
  if (request.method === "GET") ctx.waitUntil(recordScan(env, request, looked.entry.id));
  return new Response(null, {
    status: 302,
    headers: {
      location: looked.entry.destination,
      "cache-control": "no-store",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

async function redirectAccount(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  handle: string,
  slug: string,
): Promise<Response> {
  let looked: Awaited<ReturnType<typeof lookupAccountCode>>;
  try {
    looked = await lookupAccountCode(env, handle, slug);
  } catch (cause) {
    if (isMissingTable(cause)) {
      return fallbackPage({
        reason: "setup",
        message: "This PermaQR instance still needs its database. Apply the D1 migrations, then try the code again.",
      });
    }
    throw cause;
  }
  if (looked.fill) ctx.waitUntil(looked.fill);
  const shown = `u/${handle}/${slug}`;
  if (!looked.entry) {
    const account = await findAccountByHandle(env, handle);
    if (account && account.disabled === 0) {
      return fallbackPage({ message: await getFallbackMessage(env, account.id), slug: shown, reason: "missing" });
    }
    return fallbackPage({ message: DEFAULT_FALLBACK_MESSAGE, slug: shown, reason: "missing" });
  }
  if (looked.entry.paused) {
    const account = await findAccountByHandle(env, handle);
    const message = account ? await getFallbackMessage(env, account.id) : DEFAULT_FALLBACK_MESSAGE;
    return fallbackPage({ message, slug: shown, reason: "paused" });
  }
  if (request.method === "GET") ctx.waitUntil(recordScan(env, request, looked.entry.id));
  return new Response(null, {
    status: 302,
    headers: {
      location: looked.entry.destination,
      "cache-control": "no-store",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

async function missing(env: AppEnv, slug?: string): Promise<Response> {
  try {
    const message = await getFallbackMessage(env);
    return fallbackPage({ message, slug, reason: "missing" });
  } catch (cause) {
    if (isMissingTable(cause)) {
      return fallbackPage({
        reason: "setup",
        message: "This PermaQR instance still needs its database. Apply the D1 migrations, then try the code again.",
      });
    }
    throw cause;
  }
}

async function handleApi(request: Request, env: AppEnv, path: string): Promise<Response> {
  if (path === "/api/config" && request.method === "GET") return json(publicConfig(env));
  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/logout" && request.method === "POST") return logout(request);
  if (path === "/api/session" && request.method === "GET") {
    return json({ authenticated: await isAuthenticated(request, env) });
  }

  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  const actor = await requestScope(request, env);
  if (!actor) return error("Sign in required", 401);
  const { scope, extraReserved } = actor;

  if (path === "/api/codes" && request.method === "GET") return json({ codes: await listCodes(env, scope) });
  if (path === "/api/codes" && request.method === "POST") return create(request, env, scope, extraReserved);
  if (path === "/api/export" && request.method === "GET") return exportCodes(request, env, scope);
  if (path === "/api/import" && request.method === "POST") return importCodes(request, env, scope, extraReserved);
  if (path === "/api/settings" && request.method === "GET") {
    return json({ fallback_message: await getFallbackMessage(env, scope?.accountId) });
  }
  if (path === "/api/settings" && request.method === "PUT") return updateSettings(request, env, scope);

  const codeMatch = /^\/api\/codes\/([^/]+)$/.exec(path);
  if (codeMatch) {
    const id = codeMatch[1] ?? "";
    if (request.method === "GET") {
      const code = await getCodeById(env, id, scope);
      return code ? json({ code }) : error("Code not found.", 404);
    }
    if (request.method === "PATCH") return patchCode(request, env, id, scope);
    if (request.method === "DELETE") {
      const removed = await deleteCode(env, id, scope);
      return removed ? new Response(null, { status: 204 }) : error("Code not found.", 404);
    }
  }

  const analyticsMatch = /^\/api\/codes\/([^/]+)\/analytics$/.exec(path);
  if (analyticsMatch && request.method === "GET") {
    const id = analyticsMatch[1] ?? "";
    const range = new URL(request.url).searchParams.get("range") ?? "30d";
    const analytics = await getAnalytics(env, id, range, scope);
    return analytics ? json(analytics) : error("Code not found.", 404);
  }

  return error("Not found", 404);
}

async function requestScope(
  request: Request,
  env: AppEnv,
): Promise<{ scope?: CodeScope; extraReserved: readonly string[] } | null> {
  if (await isAuthenticated(request, env)) {
    return { extraReserved: isHostedMode(env) ? HOSTED_OPERATOR_RESERVED : [] };
  }
  if (!isHostedMode(env)) return null;
  const account = await accountActor(request, env);
  if (!account) return null;
  return { scope: { accountId: account.id, handle: account.handle }, extraReserved: [] };
}

async function login(request: Request, env: AppEnv): Promise<Response> {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (!env.ADMIN_PASSWORD) return error("Admin password is not configured.", 503);
  if (await loginBlocked(env, request)) return error("Too many sign-in attempts. Try again in a few minutes.", 429);
  const body = await readJson(request, 8_000);
  if (body instanceof Response) return body;
  const password = typeof (body as { password?: unknown }).password === "string" ? (body as { password: string }).password : "";
  if (await passwordsMatch(password, env.ADMIN_PASSWORD)) {
    await clearLoginFailures(env, request);
    const token = await signSession(env.ADMIN_PASSWORD);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, token) });
  }
  await noteLoginFailure(env, request);
  return error("Wrong password.", 401);
}

function logout(request: Request): Response {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0) });
}

async function create(
  request: Request,
  env: AppEnv,
  scope: CodeScope | undefined,
  extraReserved: readonly string[],
): Promise<Response> {
  const body = await readJson(request, 200_000);
  if (body instanceof Response) return body;
  const result = await createCode(
    env,
    (body ?? {}) as { slug?: unknown; destination?: unknown; title?: unknown; style?: unknown },
    scope,
    extraReserved,
  );
  if (result instanceof Response) return result;
  return json({ code: result }, 201);
}

async function patchCode(request: Request, env: AppEnv, id: string, scope?: CodeScope): Promise<Response> {
  const body = await readJson(request, 200_000);
  if (body instanceof Response) return body;
  const result = await updateCode(
    env,
    id,
    (body ?? {}) as { destination?: unknown; title?: unknown; paused?: unknown; style?: unknown },
    scope,
  );
  if (result instanceof Response) return result;
  return json({ code: result });
}

async function updateSettings(request: Request, env: AppEnv, scope?: CodeScope): Promise<Response> {
  const body = await readJson(request, 20_000);
  if (body instanceof Response) return body;
  const raw = (body as { fallback_message?: unknown }).fallback_message;
  if (typeof raw !== "string") return error("Fallback message is required.", 400);
  await setFallbackMessage(env, raw, scope?.accountId);
  return json({ fallback_message: await getFallbackMessage(env, scope?.accountId) });
}

async function exportCodes(request: Request, env: AppEnv, scope?: CodeScope): Promise<Response> {
  const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
  if (format === "csv") {
    const csv = await exportCsv(env, scope);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="permaqr-codes.csv"',
        "cache-control": "no-store",
      },
    });
  }
  const file = await exportJson(env, scope);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="permaqr-codes.json"',
      "cache-control": "no-store",
    },
  });
}

async function importCodes(
  request: Request,
  env: AppEnv,
  scope: CodeScope | undefined,
  extraReserved: readonly string[],
): Promise<Response> {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const mode = url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  const text = await readBody(request, 5_000_000);
  if (text instanceof Response) return text;
  const result = await importPayload(env, format, text, mode, scope, extraReserved);
  if (result instanceof Response) return result;
  return json(result);
}
