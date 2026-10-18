import {
  DEFAULT_STYLE,
  type AnalyticsResponse,
  type CodeRecord,
  type ExportFile,
  type QrStyle,
} from "../../shared/types";
import type { AppEnv } from "../env";
import { parseCsv, toCsv, unescapeImported } from "./csv";
import { getFallbackMessage, setFallbackMessage } from "./fallback";
import { parseUserAgent, referrerHost, requestCountry } from "./ua";
import {
  cleanTitle,
  normalizeSlug,
  parseStoredStyle,
  randomSlug,
  slugProblem,
  validateDestination,
  validateStyle,
} from "./validate";

type CodeRow = {
  id: string;
  slug: string;
  destination: string;
  title: string;
  paused: number;
  style: string;
  created_at: number;
  updated_at: number;
  scans: number;
};

export type CacheEntry = { id: string; destination: string; paused: boolean };

const MAX_CODES = 1000;

export function cacheKey(slug: string): string {
  return `code:${slug}`;
}

function toRecord(row: CodeRow): CodeRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    destination: row.destination,
    paused: row.paused === 1,
    style: parseStoredStyle(row.style),
    created_at: row.created_at,
    updated_at: row.updated_at,
    scans: Number(row.scans) || 0,
  };
}

async function putCache(env: AppEnv, slug: string, entry: CacheEntry): Promise<void> {
  await env.CODES.put(cacheKey(slug), JSON.stringify(entry));
}

async function dropCache(env: AppEnv, slug: string): Promise<void> {
  await env.CODES.delete(cacheKey(slug));
}

export async function lookupCode(
  env: AppEnv,
  slug: string,
): Promise<{ entry: CacheEntry | null; fill?: Promise<unknown> }> {
  const key = cacheKey(slug);
  let raw: string | null = null;
  try {
    raw = await env.CODES.get(key);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "kv read failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  if (raw === "0") return { entry: null };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<CacheEntry>;
      if (parsed.id && parsed.destination && typeof parsed.paused === "boolean") {
        return { entry: { id: parsed.id, destination: parsed.destination, paused: parsed.paused } };
      }
    } catch {
      // Fall through to D1 and refresh the cache.
    }
  }

  const row = await env.DB.prepare("SELECT id, destination, paused FROM codes WHERE slug = ?")
    .bind(slug)
    .first<{ id: string; destination: string; paused: number }>();
  if (!row) {
    return { entry: null, fill: env.CODES.put(key, "0", { expirationTtl: 60 }) };
  }
  const entry: CacheEntry = { id: row.id, destination: row.destination, paused: row.paused === 1 };
  return { entry, fill: env.CODES.put(key, JSON.stringify(entry)) };
}

export async function recordScan(env: AppEnv, request: Request, codeId: string): Promise<void> {
  try {
    const agent = parseUserAgent(request.headers.get("User-Agent"));
    await env.DB.prepare(
      "INSERT INTO scans (code_id, scanned_at, country, device, os, referrer) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(codeId, Date.now(), requestCountry(request), agent.device, agent.os, referrerHost(request))
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "scan write failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

const LIST_SQL = `
  SELECT c.id, c.slug, c.destination, c.title, c.paused, c.style, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM scans s WHERE s.code_id = c.id) AS scans
  FROM codes c
  ORDER BY c.updated_at DESC
  LIMIT ?
`;

export async function listCodes(env: AppEnv): Promise<CodeRecord[]> {
  const { results } = await env.DB.prepare(LIST_SQL).bind(MAX_CODES).all<CodeRow>();
  return results.map(toRecord);
}

export async function getCodeById(env: AppEnv, id: string): Promise<CodeRecord | null> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.slug, c.destination, c.title, c.paused, c.style, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM scans s WHERE s.code_id = c.id) AS scans
     FROM codes c WHERE c.id = ?`,
  )
    .bind(id)
    .first<CodeRow>();
  return row ? toRecord(row) : null;
}

async function uniqueSlug(env: AppEnv, preferred?: string): Promise<string | Response> {
  if (preferred) {
    const problem = slugProblem(preferred);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const slug = normalizeSlug(preferred);
    if (!slug) return Response.json({ error: "Slug is invalid." }, { status: 400 });
    const existing = await env.DB.prepare("SELECT id FROM codes WHERE slug = ?").bind(slug).first();
    if (existing) return Response.json({ error: "That short code is already in use." }, { status: 409 });
    return slug;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = randomSlug();
    const existing = await env.DB.prepare("SELECT id FROM codes WHERE slug = ?").bind(slug).first();
    if (!existing) return slug;
  }
  return Response.json({ error: "Could not allocate a short code. Try a custom slug." }, { status: 500 });
}

export async function createCode(
  env: AppEnv,
  input: { slug?: unknown; destination?: unknown; title?: unknown; style?: unknown },
): Promise<CodeRecord | Response> {
  const destination = typeof input.destination === "string" ? validateDestination(input.destination) : null;
  if (!destination) {
    return Response.json({ error: "Destination must be an http or https URL." }, { status: 400 });
  }
  const style = validateStyle(input.style === undefined ? DEFAULT_STYLE : input.style);
  if (!style) return Response.json({ error: "QR style is invalid." }, { status: 400 });
  const slug = await uniqueSlug(env, typeof input.slug === "string" && input.slug.trim() ? input.slug : undefined);
  if (slug instanceof Response) return slug;
  const now = Date.now();
  const id = crypto.randomUUID();
  const title = cleanTitle(input.title);
  await env.DB.prepare(
    "INSERT INTO codes (id, slug, destination, title, paused, style, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
  )
    .bind(id, slug, destination, title, JSON.stringify(style), now, now)
    .run();
  await putCache(env, slug, { id, destination, paused: false });
  const created = await getCodeById(env, id);
  if (!created) return Response.json({ error: "Code was created but could not be read back." }, { status: 500 });
  return created;
}

export async function updateCode(
  env: AppEnv,
  id: string,
  input: { destination?: unknown; title?: unknown; paused?: unknown; style?: unknown },
): Promise<CodeRecord | Response> {
  const current = await getCodeById(env, id);
  if (!current) return Response.json({ error: "Code not found." }, { status: 404 });

  let destination = current.destination;
  if (input.destination !== undefined) {
    if (typeof input.destination !== "string") {
      return Response.json({ error: "Destination must be an http or https URL." }, { status: 400 });
    }
    const next = validateDestination(input.destination);
    if (!next) return Response.json({ error: "Destination must be an http or https URL." }, { status: 400 });
    destination = next;
  }

  let title = current.title;
  if (input.title !== undefined) title = cleanTitle(input.title);

  let paused = current.paused;
  if (input.paused !== undefined) {
    if (typeof input.paused !== "boolean") return Response.json({ error: "Paused must be true or false." }, { status: 400 });
    paused = input.paused;
  }

  let style = current.style;
  if (input.style !== undefined) {
    const next = validateStyle(input.style);
    if (!next) return Response.json({ error: "QR style is invalid." }, { status: 400 });
    style = next;
  }

  const now = Date.now();
  await env.DB.prepare(
    "UPDATE codes SET destination = ?, title = ?, paused = ?, style = ?, updated_at = ? WHERE id = ?",
  )
    .bind(destination, title, paused ? 1 : 0, JSON.stringify(style), now, id)
    .run();
  await putCache(env, current.slug, { id, destination, paused });
  const updated = await getCodeById(env, id);
  if (!updated) return Response.json({ error: "Code not found." }, { status: 404 });
  return updated;
}

export async function deleteCode(env: AppEnv, id: string): Promise<boolean> {
  const current = await env.DB.prepare("SELECT slug FROM codes WHERE id = ?").bind(id).first<{ slug: string }>();
  if (!current) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scans WHERE code_id = ?").bind(id),
    env.DB.prepare("DELETE FROM codes WHERE id = ?").bind(id),
  ]);
  await dropCache(env, current.slug);
  return true;
}

function rangeStart(range: string, now: number): { key: AnalyticsResponse["range"]; since: number | null } {
  const day = 86_400_000;
  if (range === "7d") return { key: "7d", since: now - 7 * day };
  if (range === "90d") return { key: "90d", since: now - 90 * day };
  if (range === "all") return { key: "all", since: null };
  return { key: "30d", since: now - 30 * day };
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export async function getAnalytics(env: AppEnv, id: string, range: string, now = Date.now()): Promise<AnalyticsResponse | null> {
  const code = await env.DB.prepare("SELECT id FROM codes WHERE id = ?").bind(id).first();
  if (!code) return null;
  const { key, since } = rangeStart(range, now);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM scans WHERE code_id = ?")
    .bind(id)
    .first<{ count: number }>();

  const where = since === null ? "code_id = ?" : "code_id = ? AND scanned_at >= ?";
  const binds = since === null ? [id] : [id, since];
  const seriesQuery = env.DB.prepare(
    `SELECT date(scanned_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
     FROM scans WHERE ${where} GROUP BY date ORDER BY date`,
  ).bind(...binds);
  const countryQuery = env.DB.prepare(
    `SELECT country AS label, COUNT(*) AS count FROM scans WHERE ${where}
     GROUP BY country ORDER BY count DESC LIMIT 12`,
  ).bind(...binds);
  const deviceQuery = env.DB.prepare(
    `SELECT device AS label, COUNT(*) AS count FROM scans WHERE ${where}
     GROUP BY device ORDER BY count DESC`,
  ).bind(...binds);
  const osQuery = env.DB.prepare(
    `SELECT os AS label, COUNT(*) AS count FROM scans WHERE ${where}
     GROUP BY os ORDER BY count DESC`,
  ).bind(...binds);

  const [seriesResult, countriesResult, devicesResult, osResult] = await env.DB.batch([
    seriesQuery,
    countryQuery,
    deviceQuery,
    osQuery,
  ]);

  const byDay = new Map<string, number>();
  for (const row of seriesResult.results as { date: string; count: number }[]) {
    byDay.set(row.date, Number(row.count) || 0);
  }

  const series: AnalyticsResponse["series"] = [];
  if (since === null) {
    for (const [date, count] of byDay) series.push({ date, count });
  } else {
    const start = Date.parse(`${dayKey(since)}T00:00:00.000Z`);
    const end = Date.parse(`${dayKey(now)}T00:00:00.000Z`);
    for (let cursor = start; cursor <= end; cursor += 86_400_000) {
      const date = dayKey(cursor);
      series.push({ date, count: byDay.get(date) ?? 0 });
    }
  }

  const mapBuckets = (rows: unknown): AnalyticsResponse["countries"] =>
    (rows as { label: string; count: number }[]).map((row) => ({
      label: row.label || "Unknown",
      count: Number(row.count) || 0,
    }));

  const ranged = series.reduce((sum, point) => sum + point.count, 0);
  return {
    total: Number(totalRow?.count) || 0,
    ranged_total: ranged,
    range: key,
    series,
    countries: mapBuckets(countriesResult.results),
    devices: mapBuckets(devicesResult.results),
    os: mapBuckets(osResult.results),
  };
}

export async function exportJson(env: AppEnv): Promise<ExportFile> {
  const codes = await listCodes(env);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    fallback_message: await getFallbackMessage(env),
    codes: codes
      .slice()
      .reverse()
      .map((code) => ({
        slug: code.slug,
        title: code.title,
        destination: code.destination,
        paused: code.paused,
        style: code.style,
        created_at: new Date(code.created_at).toISOString(),
        updated_at: new Date(code.updated_at).toISOString(),
      })),
  };
}

export async function exportCsv(env: AppEnv): Promise<string> {
  const codes = await listCodes(env);
  return toCsv(
    ["slug", "title", "destination", "paused", "created_at"],
    codes
      .slice()
      .reverse()
      .map((code) => [
        code.slug,
        code.title,
        code.destination,
        code.paused ? "true" : "false",
        new Date(code.created_at).toISOString(),
      ]),
  );
}

type ImportRow = {
  slug: string;
  title: string;
  destination: string;
  paused: boolean;
  style: QrStyle;
  createdAt: number;
};

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export async function importPayload(
  env: AppEnv,
  format: "json" | "csv",
  text: string,
  mode: "merge" | "replace",
): Promise<{ created: number; updated: number; errors: string[] } | Response> {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  let fallback: string | undefined;
  const now = Date.now();

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const body = parsed as {
      version?: number;
      fallback_message?: unknown;
      codes?: unknown;
      mode?: unknown;
    };
    if (body.version !== undefined && body.version !== 1) {
      return Response.json({ error: "Unsupported export version." }, { status: 400 });
    }
    if (typeof body.fallback_message === "string") fallback = body.fallback_message;
    if (!Array.isArray(body.codes)) return Response.json({ error: "JSON export must include a codes array." }, { status: 400 });
    body.codes.forEach((item, index) => collectImportRow(item, index, now, rows, errors));
  } else {
    const table = parseCsv(text);
    if (table.length === 0) return Response.json({ error: "CSV is empty." }, { status: 400 });
    const header = table[0]?.map((cell) => unescapeImported(cell).toLowerCase()) ?? [];
    const slugIndex = header.indexOf("slug");
    const destinationIndex = header.indexOf("destination");
    if (slugIndex === -1 || destinationIndex === -1) {
      return Response.json({ error: "CSV needs slug and destination columns." }, { status: 400 });
    }
    const titleIndex = header.indexOf("title");
    const pausedIndex = header.indexOf("paused");
    const createdIndex = header.indexOf("created_at");
    for (let i = 1; i < table.length; i++) {
      const cells = table[i] ?? [];
      collectImportRow(
        {
          slug: cells[slugIndex],
          title: titleIndex >= 0 ? cells[titleIndex] : "",
          destination: cells[destinationIndex],
          paused: pausedIndex >= 0 ? cells[pausedIndex] : "false",
          created_at: createdIndex >= 0 ? cells[createdIndex] : undefined,
        },
        i,
        now,
        rows,
        errors,
      );
    }
  }

  if (rows.length > MAX_CODES) {
    return Response.json({ error: `Import is limited to ${MAX_CODES} codes.` }, { status: 400 });
  }

  const seen = new Set<string>();
  const uniqueRows: ImportRow[] = [];
  for (const row of rows) {
    if (seen.has(row.slug)) {
      errors.push(`Duplicate slug ${row.slug} in the import file.`);
      continue;
    }
    seen.add(row.slug);
    uniqueRows.push(row);
  }

  let created = 0;
  let updated = 0;
  for (const row of uniqueRows) {
    const existing = await env.DB.prepare("SELECT id, created_at FROM codes WHERE slug = ?")
      .bind(row.slug)
      .first<{ id: string; created_at: number }>();
    if (existing) {
      await env.DB.prepare(
        "UPDATE codes SET destination = ?, title = ?, paused = ?, style = ?, updated_at = ? WHERE id = ?",
      )
        .bind(row.destination, row.title, row.paused ? 1 : 0, JSON.stringify(row.style), now, existing.id)
        .run();
      await putCache(env, row.slug, { id: existing.id, destination: row.destination, paused: row.paused });
      updated++;
    } else {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO codes (id, slug, destination, title, paused, style, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, row.slug, row.destination, row.title, row.paused ? 1 : 0, JSON.stringify(row.style), row.createdAt, now)
        .run();
      await putCache(env, row.slug, { id, destination: row.destination, paused: row.paused });
      created++;
    }
  }

  if (mode === "replace") {
    const { results } = await env.DB.prepare("SELECT id, slug FROM codes").all<{ id: string; slug: string }>();
    for (const code of results) {
      if (seen.has(code.slug)) continue;
      await deleteCode(env, code.id);
    }
  }

  if (fallback !== undefined) await setFallbackMessage(env, fallback);
  return { created, updated, errors };
}

function collectImportRow(
  item: unknown,
  index: number,
  now: number,
  rows: ImportRow[],
  errors: string[],
): void {
  const row = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
  const slugInput = typeof row.slug === "string" ? unescapeImported(row.slug) : "";
  const slug = normalizeSlug(slugInput);
  const destinationInput = typeof row.destination === "string" ? unescapeImported(row.destination) : "";
  const destination = validateDestination(destinationInput);
  if (!slug || !destination) {
    errors.push(`Row ${index + 1} was skipped. Check the slug and destination.`);
    return;
  }
  const style = row.style === undefined ? { ...DEFAULT_STYLE } : validateStyle(row.style);
  if (!style) {
    errors.push(`Row ${index + 1} (${slug}) was skipped because its QR style is invalid.`);
    return;
  }
  const pausedRaw = row.paused;
  const paused =
    pausedRaw === true ||
    pausedRaw === 1 ||
    (typeof pausedRaw === "string" && ["true", "1", "yes", "paused"].includes(unescapeImported(pausedRaw).toLowerCase()));
  rows.push({
    slug,
    title: cleanTitle(typeof row.title === "string" ? unescapeImported(row.title) : ""),
    destination,
    paused,
    style,
    createdAt: parseTimestamp(typeof row.created_at === "string" ? unescapeImported(row.created_at) : row.created_at, now),
  });
}
