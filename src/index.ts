import type { AppEnv } from "./env";
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
  lookupCode,
  recordScan,
  updateCode,
} from "./lib/codes";
import { fallbackPage, getFallbackMessage, setFallbackMessage } from "./lib/fallback";
import { databaseNotReady, error, isMissingTable, isSameOrigin, json, readBody, readJson } from "./lib/http";

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
    const landing = new URL("/", request.url);
    return withHtmlHeaders(await env.ASSETS.fetch(new Request(landing, { method: "GET" })));
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return handleApi(request, env, path);
  }

  const authed = await isAuthenticated(request, env);

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
    return withHtmlHeaders(await env.ASSETS.fetch(request));
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return error("Method not allowed", 405);
  }

  const slug = path.slice(1).toLowerCase();
  if (!slug || slug.includes("/")) return missing(env, slug);
  return redirectSlug(request, env, ctx, slug);
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
  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/logout" && request.method === "POST") return logout(request);
  if (path === "/api/session" && request.method === "GET") {
    return json({ authenticated: await isAuthenticated(request, env) });
  }

  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (!(await isAuthenticated(request, env))) return error("Sign in required", 401);

  if (path === "/api/codes" && request.method === "GET") return json({ codes: await listCodes(env) });
  if (path === "/api/codes" && request.method === "POST") return create(request, env);
  if (path === "/api/export" && request.method === "GET") return exportCodes(request, env);
  if (path === "/api/import" && request.method === "POST") return importCodes(request, env);
  if (path === "/api/settings" && request.method === "GET") {
    return json({ fallback_message: await getFallbackMessage(env) });
  }
  if (path === "/api/settings" && request.method === "PUT") return updateSettings(request, env);

  const codeMatch = /^\/api\/codes\/([^/]+)$/.exec(path);
  if (codeMatch) {
    const id = codeMatch[1] ?? "";
    if (request.method === "GET") {
      const code = await getCodeById(env, id);
      return code ? json({ code }) : error("Code not found.", 404);
    }
    if (request.method === "PATCH") return patchCode(request, env, id);
    if (request.method === "DELETE") {
      const removed = await deleteCode(env, id);
      return removed ? new Response(null, { status: 204 }) : error("Code not found.", 404);
    }
  }

  const analyticsMatch = /^\/api\/codes\/([^/]+)\/analytics$/.exec(path);
  if (analyticsMatch && request.method === "GET") {
    const id = analyticsMatch[1] ?? "";
    const range = new URL(request.url).searchParams.get("range") ?? "30d";
    const analytics = await getAnalytics(env, id, range);
    return analytics ? json(analytics) : error("Code not found.", 404);
  }

  return error("Not found", 404);
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

async function create(request: Request, env: AppEnv): Promise<Response> {
  const body = await readJson(request, 200_000);
  if (body instanceof Response) return body;
  const result = await createCode(env, (body ?? {}) as { slug?: unknown; destination?: unknown; title?: unknown; style?: unknown });
  if (result instanceof Response) return result;
  return json({ code: result }, 201);
}

async function patchCode(request: Request, env: AppEnv, id: string): Promise<Response> {
  const body = await readJson(request, 200_000);
  if (body instanceof Response) return body;
  const result = await updateCode(env, id, (body ?? {}) as { destination?: unknown; title?: unknown; paused?: unknown; style?: unknown });
  if (result instanceof Response) return result;
  return json({ code: result });
}

async function updateSettings(request: Request, env: AppEnv): Promise<Response> {
  const body = await readJson(request, 20_000);
  if (body instanceof Response) return body;
  const raw = (body as { fallback_message?: unknown }).fallback_message;
  if (typeof raw !== "string") return error("Fallback message is required.", 400);
  await setFallbackMessage(env, raw);
  return json({ fallback_message: await getFallbackMessage(env) });
}

async function exportCodes(request: Request, env: AppEnv): Promise<Response> {
  const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
  if (format === "csv") {
    const csv = await exportCsv(env);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="permaqr-codes.csv"',
        "cache-control": "no-store",
      },
    });
  }
  const file = await exportJson(env);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="permaqr-codes.json"',
      "cache-control": "no-store",
    },
  });
}

async function importCodes(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
  const mode = url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  const text = await readBody(request, 5_000_000);
  if (text instanceof Response) return text;
  const result = await importPayload(env, format, text, mode);
  if (result instanceof Response) return result;
  return json(result);
}
