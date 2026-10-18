import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import "../src/index";

const PASSWORD = "test-password";

async function login(): Promise<string> {
  const response = await exports.default.fetch("https://permaqr.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie.startsWith("permaqr_session=")).toBe(true);
  return cookie;
}

async function resetStorage(): Promise<void> {
  await env.DB.prepare("DELETE FROM scans").run();
  await env.DB.prepare("DELETE FROM account_codes").run();
  await env.DB.prepare("DELETE FROM codes").run();
  await env.DB.prepare("DELETE FROM account_orders").run();
  await env.DB.prepare("DELETE FROM account_settings").run();
  await env.DB.prepare("DELETE FROM accounts").run();
  await env.DB.prepare("DELETE FROM settings").run();
  const listed = await env.CODES.list();
  await Promise.all(listed.keys.map((key) => env.CODES.delete(key.name)));
}

async function createCode(cookie: string, body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
  const response = await exports.default.fetch("https://permaqr.test/api/codes", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { code: { id: string; slug: string } };
  return payload.code;
}

async function waitForScan(codeId: string): Promise<{ country: string; device: string; os: string; referrer: string }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const row = await env.DB.prepare(
      "SELECT country, device, os, referrer FROM scans WHERE code_id = ?",
    )
      .bind(codeId)
      .first<{ country: string; device: string; os: string; referrer: string }>();
    if (row) return row;
    await scheduler.wait(20);
  }
  throw new Error("scan was not recorded");
}

beforeEach(async () => {
  await resetStorage();
});

describe("redirects", () => {
  it("302s from KV-or-D1 and records a scan without cookies or an IP column", async () => {
    const cookie = await login();
    const code = await createCode(cookie, {
      slug: "menu",
      title: "Lunch",
      destination: "https://cafe.example/lunch",
    });

    const response = await exports.default.fetch("https://permaqr.test/menu", {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
        "CF-IPCountry": "JP",
        "CF-Connecting-IP": "203.0.113.8",
        Referer: "https://maps.example/place?q=secret",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cafe.example/lunch");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();

    const scan = await waitForScan(code.id);
    expect(scan).toEqual({ country: "JP", device: "mobile", os: "iOS", referrer: "maps.example" });

    const columns = await env.DB.prepare("PRAGMA table_info(scans)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain("ip");

    let cached: string | null = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      cached = await env.CODES.get("code:menu");
      if (cached) break;
      await scheduler.wait(20);
    }
    expect(cached).toContain("https://cafe.example/lunch");
  });

  it("serves the fallback page for unknown and paused codes and does not count those scans", async () => {
    const cookie = await login();
    const missing = await exports.default.fetch("https://permaqr.test/missing");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("isn't available");

    const code = await createCode(cookie, { slug: "door", destination: "https://cafe.example/door" });
    const paused = await exports.default.fetch(`https://permaqr.test/api/codes/${code.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ paused: true }),
    });
    expect(paused.status).toBe(200);

    const response = await exports.default.fetch("https://permaqr.test/door");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("paused");
    const scans = await env.DB.prepare("SELECT COUNT(*) AS count FROM scans").first<{ count: number }>();
    expect(scans?.count).toBe(0);
  });

  it("uses the edited destination on the next request", async () => {
    const cookie = await login();
    const code = await createCode(cookie, { slug: "hours", destination: "https://cafe.example/summer" });
    await exports.default.fetch("https://permaqr.test/hours", { redirect: "manual" });

    const updated = await exports.default.fetch(`https://permaqr.test/api/codes/${code.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ destination: "https://cafe.example/winter" }),
    });
    expect(updated.status).toBe(200);

    const response = await exports.default.fetch("https://permaqr.test/hours", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cafe.example/winter");
  });

  it("stops redirecting after delete", async () => {
    const cookie = await login();
    const code = await createCode(cookie, { slug: "gone", destination: "https://cafe.example/gone" });
    const removed = await exports.default.fetch(`https://permaqr.test/api/codes/${code.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);
    const response = await exports.default.fetch("https://permaqr.test/gone", { redirect: "manual" });
    expect(response.status).toBe(404);
    let cached: string | null = null;
    for (let attempt = 0; attempt < 25; attempt++) {
      cached = await env.CODES.get("code:gone");
      if (cached === "0") break;
      await scheduler.wait(20);
    }
    expect(cached).toBe("0");
  });

  it("does not record a scan for HEAD", async () => {
    const cookie = await login();
    const code = await createCode(cookie, { slug: "head", destination: "https://cafe.example/head" });
    const response = await exports.default.fetch("https://permaqr.test/head", { method: "HEAD", redirect: "manual" });
    expect(response.status).toBe(302);
    await scheduler.wait(50);
    const scans = await env.DB.prepare("SELECT COUNT(*) AS count FROM scans WHERE code_id = ?")
      .bind(code.id)
      .first<{ count: number }>();
    expect(scans?.count).toBe(0);
  });

  it("shows a custom fallback message", async () => {
    const cookie = await login();
    const saved = await exports.default.fetch("https://permaqr.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ fallback_message: "Ask the cafe for a fresh code." }),
    });
    expect(saved.status).toBe(200);
    const response = await exports.default.fetch("https://permaqr.test/nobody");
    expect(await response.text()).toContain("Ask the cafe for a fresh code.");
  });
});
