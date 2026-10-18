export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

export async function readBody(request: Request, maxBytes: number): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return error("Payload too large", 413);
  }
  const text = await request.text();
  if (text.length > maxBytes) return error("Payload too large", 413);
  return text;
}

export async function readJson(request: Request, maxBytes = 1_000_000): Promise<unknown | Response> {
  const text = await readBody(request, maxBytes);
  if (text instanceof Response) return text;
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return error("Invalid JSON", 400);
  }
}

/** Cookie-authenticated mutations must be same-origin. SameSite=Lax already blocks cross-site POST. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) {
    const site = request.headers.get("Sec-Fetch-Site");
    return !site || site === "same-origin" || site === "none";
  }
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table");
}

export function databaseNotReady(): Response {
  return error(
    "Database is not ready. Apply migrations with: npx wrangler d1 migrations apply DB --remote",
    503,
  );
}
