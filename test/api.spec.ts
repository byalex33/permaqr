import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import "../src/index";

const PASSWORD = "test-password";

async function resetStorage(): Promise<void> {
  await env.DB.prepare("DELETE FROM scans").run();
  await env.DB.prepare("DELETE FROM codes").run();
  await env.DB.prepare("DELETE FROM settings").run();
  const listed = await env.CODES.list();
  await Promise.all(listed.keys.map((key) => env.CODES.delete(key.name)));
}

async function login(password = PASSWORD): Promise<Response> {
  return exports.default.fetch("https://permaqr.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

beforeEach(async () => {
  await resetStorage();
});

describe("auth", () => {
  it("rejects a wrong password and accepts the right one", async () => {
    const wrong = await login("nope");
    expect(wrong.status).toBe(401);

    const right = await login();
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain("HttpOnly");
    expect(right.headers.get("set-cookie")).toContain("Secure");

    const session = await exports.default.fetch("https://permaqr.test/api/session", {
      headers: { cookie: cookieFrom(right) },
    });
    expect(await session.json()).toEqual({ authenticated: true });
  });

  it("blocks the API without a session", async () => {
    const response = await exports.default.fetch("https://permaqr.test/api/codes");
    expect(response.status).toBe(401);
  });

  it("rate limits repeated failures from one address", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await exports.default.fetch("https://permaqr.test/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(response.status).toBe(401);
    }
    const blocked = await exports.default.fetch("https://permaqr.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(blocked.status).toBe(429);
  });
});

describe("codes API", () => {
  it("creates, lists, and rejects bad destinations and reserved slugs", async () => {
    const cookie = cookieFrom(await login());
    const created = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "Menu", title: "Lunch", destination: "https://cafe.example/lunch" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { code: { slug: string; title: string } };
    expect(body.code.slug).toBe("menu");
    expect(body.code.title).toBe("Lunch");

    const badUrl = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ destination: "javascript:alert(1)" }),
    });
    expect(badUrl.status).toBe(400);

    const reserved = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "api", destination: "https://cafe.example" }),
    });
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: "That short code is reserved." });

    const list = await exports.default.fetch("https://permaqr.test/api/codes", { headers: { cookie } });
    const listed = (await list.json()) as { codes: { slug: string }[] };
    expect(listed.codes.map((code) => code.slug)).toEqual(["menu"]);
  });

  it("exports and imports JSON and CSV, then redirects to the imported destination", async () => {
    const cookie = cookieFrom(await login());
    await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "menu", destination: "https://cafe.example/lunch", title: "=cmd" }),
    });

    const jsonExport = await exports.default.fetch("https://permaqr.test/api/export?format=json", {
      headers: { cookie },
    });
    expect(jsonExport.status).toBe(200);
    expect(jsonExport.headers.get("content-disposition")).toContain("permaqr-codes.json");
    const file = (await jsonExport.json()) as { version: number; codes: { slug: string; destination: string }[] };
    expect(file.version).toBe(1);
    expect(file.codes[0]?.destination).toBe("https://cafe.example/lunch");

    const csvExport = await exports.default.fetch("https://permaqr.test/api/export?format=csv", { headers: { cookie } });
    const csv = await csvExport.text();
    expect(csv).toContain("slug,title,destination,paused,created_at");
    expect(csv).toContain("'=cmd");

    const unauth = await exports.default.fetch("https://permaqr.test/api/export?format=json");
    expect(unauth.status).toBe(401);

    const imported = await exports.default.fetch("https://permaqr.test/api/import?format=json&mode=merge", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        version: 1,
        codes: [
          { slug: "menu", destination: "https://cafe.example/dinner", title: "Dinner", paused: false },
          { slug: "shop", destination: "https://shop.example", title: "Shop", paused: false },
        ],
      }),
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ created: 1, updated: 1 });

    const redirect = await exports.default.fetch("https://permaqr.test/menu", { redirect: "manual" });
    expect(redirect.headers.get("location")).toBe("https://cafe.example/dinner");

    const csvImport = await exports.default.fetch("https://permaqr.test/api/import?format=csv&mode=merge", {
      method: "POST",
      headers: { "content-type": "text/csv", cookie },
      body: "slug,destination,title,paused\nwindow,https://cafe.example/window,Window,true\n",
    });
    expect(csvImport.status).toBe(200);
    const windowCode = await exports.default.fetch("https://permaqr.test/window");
    expect(windowCode.status).toBe(404);
    expect(await windowCode.text()).toContain("paused");
  });

  it("summarises analytics by day, country, and device", async () => {
    const cookie = cookieFrom(await login());
    const created = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "poster", destination: "https://cafe.example/poster" }),
    });
    const { code } = (await created.json()) as { code: { id: string } };

    await exports.default.fetch("https://permaqr.test/poster", {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
        "CF-IPCountry": "US",
      },
    });
    await exports.default.fetch("https://permaqr.test/poster", {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "CF-IPCountry": "DE",
      },
    });

    for (let attempt = 0; attempt < 25; attempt++) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM scans WHERE code_id = ?")
        .bind(code.id)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= 2) break;
      await scheduler.wait(20);
    }

    const analytics = await exports.default.fetch(`https://permaqr.test/api/codes/${code.id}/analytics?range=7d`, {
      headers: { cookie },
    });
    expect(analytics.status).toBe(200);
    const body = (await analytics.json()) as {
      total: number;
      countries: { label: string; count: number }[];
      devices: { label: string; count: number }[];
      series: { count: number }[];
    };
    expect(body.total).toBe(2);
    expect(body.series.reduce((sum, point) => sum + point.count, 0)).toBe(2);
    expect(body.countries.map((bucket) => bucket.label).sort()).toEqual(["DE", "US"]);
    expect(body.devices.map((bucket) => bucket.label).sort()).toEqual(["desktop", "mobile"]);
  });
});
