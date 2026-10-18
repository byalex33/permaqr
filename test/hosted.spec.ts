import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import "../src/index";

const OPERATOR_PASSWORD = "test-password";
const WEBHOOK_SECRET = "test-webhook-secret";
const ACCOUNT_PASSWORD = "correct-horse";

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

async function signBody(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function orderPayload(input: {
  orderId?: string;
  identifier?: string;
  email?: string;
  claim?: string | null;
  status?: string;
  variant?: number;
  event?: string;
  refunded?: boolean;
}): string {
  return JSON.stringify({
    meta: {
      event_name: input.event ?? "order_created",
      custom_data: input.claim ? { claim: input.claim } : {},
    },
    data: {
      type: "orders",
      id: input.orderId ?? "1001",
      attributes: {
        identifier: input.identifier ?? "104e18a2-d755-4d4b-80c4-a6c1dcbe1c10",
        user_email: input.email ?? "ada@example.com",
        status: input.status ?? "paid",
        refunded: input.refunded ?? false,
        test_mode: false,
        first_order_item: { variant_id: input.variant ?? 42, test_mode: false },
      },
    },
  });
}

async function postWebhook(body: string, signature?: string): Promise<Response> {
  return exports.default.fetch("https://permaqr.test/api/webhooks/lemonsqueezy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signature ?? (await signBody(body)),
      "x-event-name": "order_created",
    },
    body,
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function operatorLogin(): Promise<string> {
  const response = await exports.default.fetch("https://permaqr.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function accountCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM accounts").first<{ count: number }>();
  return Number(row?.count) || 0;
}

beforeEach(async () => {
  await resetStorage();
});

describe("lemon squeezy webhook", () => {
  it("rejects a missing or wrong signature and ignores unpaid or wrong-variant orders", async () => {
    const body = orderPayload({});
    const missing = await postWebhook(body, "");
    expect(missing.status).toBe(401);

    const wrong = await postWebhook(body, await signBody(body, "other-secret"));
    expect(wrong.status).toBe(401);
    expect(await accountCount()).toBe(0);

    const tampered = `${body} `;
    const tamper = await postWebhook(tampered, await signBody(body));
    expect(tamper.status).toBe(401);

    const pending = await postWebhook(orderPayload({ status: "pending" }));
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ ok: true, ignored: true });

    const otherProduct = await postWebhook(orderPayload({ variant: 99, orderId: "1002" }));
    expect(otherProduct.status).toBe(200);
    expect(await otherProduct.json()).toEqual({ ok: true, ignored: true });
    expect(await accountCount()).toBe(0);
  });

  it("provisions one workspace for a paid order and treats a repeat as the same account", async () => {
    const body = orderPayload({ email: "Ada@Example.com" });
    const created = await postWebhook(body);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ ok: true, created: true });

    const again = await postWebhook(body);
    expect(await again.json()).toEqual({ ok: true, created: false });
    expect(await accountCount()).toBe(1);

    const row = await env.DB.prepare("SELECT email, handle, password_hash FROM accounts").first<{
      email: string;
      handle: string;
      password_hash: string | null;
    }>();
    expect(row).toMatchObject({ email: "ada@example.com", handle: "ada", password_hash: null });
  });
});

describe("hosted workspace", () => {
  it("sets a password from the checkout claim, then isolates codes from the operator and from other accounts", async () => {
    const checkout = await exports.default.fetch("https://permaqr.test/api/hosted/checkout", { redirect: "manual" });
    expect(checkout.status).toBe(302);
    const location = checkout.headers.get("location") ?? "";
    expect(location.startsWith("https://permaqr.lemonsqueezy.com/checkout/buy/variant-test?")).toBe(true);
    const claim = new URL(location).searchParams.get("checkout[custom][claim]");
    expect(claim).toBeTruthy();
    const claimCookie = cookieFrom(checkout);
    expect(claimCookie.startsWith("permaqr_claim=")).toBe(true);

    const identifier = "104e18a2-d755-4d4b-80c4-a6c1dcbe1c10";
    const paid = await postWebhook(
      orderPayload({ claim, identifier, email: "ada@example.com", orderId: "501" }),
    );
    expect(paid.status).toBe(200);

    const claimed = await exports.default.fetch("https://permaqr.test/api/hosted/claim", {
      method: "POST",
      headers: { cookie: claimCookie },
    });
    expect(await claimed.json()).toEqual({
      status: "ready",
      order_identifier: identifier,
      email: "ada@example.com",
    });

    const setup = await exports.default.fetch("https://permaqr.test/api/account/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_identifier: identifier, password: ACCOUNT_PASSWORD }),
    });
    expect(setup.status).toBe(200);
    const ada = cookieFrom(setup);

    const operator = await operatorLogin();
    const operatorSession = await exports.default.fetch("https://permaqr.test/api/session", {
      headers: { cookie: operator },
    });
    expect(await operatorSession.json()).toEqual({ authenticated: true });
    const adaAsOperator = await exports.default.fetch("https://permaqr.test/api/session", { headers: { cookie: ada } });
    expect(await adaAsOperator.json()).toEqual({ authenticated: false });

    const hello = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operator },
      body: JSON.stringify({ slug: "hello", destination: "https://operator.example/hello" }),
    });
    expect(hello.status).toBe(201);
    const helloBody = (await hello.json()) as { code: { id: string } };

    const reserved = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operator },
      body: JSON.stringify({ slug: "u", destination: "https://operator.example/u" }),
    });
    expect(reserved.status).toBe(400);

    const operatorMenu = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operator },
      body: JSON.stringify({ slug: "menu", destination: "https://operator.example/menu" }),
    });
    const operatorMenuId = ((await operatorMenu.json()) as { code: { id: string } }).code.id;

    const adaMenu = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ada },
      body: JSON.stringify({ slug: "menu", destination: "https://ada.example/menu" }),
    });
    expect(adaMenu.status).toBe(201);
    const adaMenuId = ((await adaMenu.json()) as { code: { id: string } }).code.id;

    const adaList = await exports.default.fetch("https://permaqr.test/api/codes", { headers: { cookie: ada } });
    const adaCodes = (await adaList.json()) as { codes: { slug: string; destination: string }[] };
    expect(adaCodes.codes.map((code) => code.slug)).toEqual(["menu"]);
    expect(adaCodes.codes[0]?.destination).toBe("https://ada.example/menu");

    const operatorList = await exports.default.fetch("https://permaqr.test/api/codes", { headers: { cookie: operator } });
    const operatorSlugs = ((await operatorList.json()) as { codes: { slug: string }[] }).codes.map((code) => code.slug);
    expect(operatorSlugs.sort()).toEqual(["hello", "menu"]);

    expect(
      (await exports.default.fetch(`https://permaqr.test/api/codes/${helloBody.code.id}`, { headers: { cookie: ada } }))
        .status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(`https://permaqr.test/api/codes/${adaMenuId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: operator },
          body: JSON.stringify({ destination: "https://evil.example" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await exports.default.fetch(`https://permaqr.test/api/codes/${operatorMenuId}/analytics`, {
          headers: { cookie: ada },
        })
      ).status,
    ).toBe(404);

    const root = await exports.default.fetch("https://permaqr.test/hello", { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://operator.example/hello");

    const hostedRedirect = await exports.default.fetch("https://permaqr.test/u/ada/menu", {
      redirect: "manual",
      headers: { "CF-IPCountry": "FR", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" },
    });
    expect(hostedRedirect.status).toBe(302);
    expect(hostedRedirect.headers.get("location")).toBe("https://ada.example/menu");
    expect(hostedRedirect.headers.get("cache-control")).toBe("no-store");

    const rootMenu = await exports.default.fetch("https://permaqr.test/menu", { redirect: "manual" });
    expect(rootMenu.headers.get("location")).toBe("https://operator.example/menu");

    for (let attempt = 0; attempt < 25; attempt++) {
      const cached = await env.CODES.get("u:ada:menu");
      if (cached?.includes("https://ada.example/menu")) break;
      await scheduler.wait(20);
    }
    expect(await env.CODES.get("u:ada:menu")).toContain("https://ada.example/menu");
    expect(await env.CODES.get("code:menu")).toContain("https://operator.example/menu");

    const beaOrder = orderPayload({
      email: "bea@example.com",
      orderId: "502",
      identifier: "204e18a2-d755-4d4b-80c4-a6c1dcbe1c11",
    });
    expect((await postWebhook(beaOrder)).status).toBe(200);
    const beaSetup = await exports.default.fetch("https://permaqr.test/api/account/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order_identifier: "204e18a2-d755-4d4b-80c4-a6c1dcbe1c11",
        password: "bea-password-1",
      }),
    });
    const bea = cookieFrom(beaSetup);
    const beaList = await exports.default.fetch("https://permaqr.test/api/codes", { headers: { cookie: bea } });
    expect(await beaList.json()).toEqual({ codes: [] });
    const stolen = await exports.default.fetch(`https://permaqr.test/api/codes/${adaMenuId}`, {
      method: "DELETE",
      headers: { cookie: bea },
    });
    expect(stolen.status).toBe(404);
    const stillThere = await exports.default.fetch("https://permaqr.test/u/ada/menu", { redirect: "manual" });
    expect(stillThere.headers.get("location")).toBe("https://ada.example/menu");

    await exports.default.fetch("https://permaqr.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: operator },
      body: JSON.stringify({ fallback_message: "Operator fallback." }),
    });
    await exports.default.fetch("https://permaqr.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ada },
      body: JSON.stringify({ fallback_message: "Ada fallback." }),
    });
    expect(await (await exports.default.fetch("https://permaqr.test/missing")).text()).toContain("Operator fallback.");
    expect(await (await exports.default.fetch("https://permaqr.test/u/ada/missing")).text()).toContain("Ada fallback.");
    expect(await (await exports.default.fetch("https://permaqr.test/u/nobody/missing")).text()).not.toContain(
      "Operator fallback.",
    );
  });

  it("caps an account at 100 codes, and disable or refund stops sign-in and redirects", async () => {
    const body = orderPayload({ email: "ada@example.com", orderId: "700", identifier: "304e18a2-d755-4d4b-80c4-a6c1dcbe1c12" });
    expect((await postWebhook(body)).status).toBe(200);
    const setup = await exports.default.fetch("https://permaqr.test/api/account/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_identifier: "304e18a2-d755-4d4b-80c4-a6c1dcbe1c12", password: ACCOUNT_PASSWORD }),
    });
    const ada = cookieFrom(setup);
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind("ada@example.com")
      .first<{ id: string }>();
    expect(account?.id).toBeTruthy();
    const now = Date.now();
    for (let index = 0; index < 100; index++) {
      await env.DB.prepare(
        `INSERT INTO account_codes (id, account_id, slug, destination, title, paused, style, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 0, '{}', ?, ?)`,
      )
        .bind(crypto.randomUUID(), account?.id, `c${index}`, "https://ada.example/cap", now, now)
        .run();
    }
    const capped = await exports.default.fetch("https://permaqr.test/api/codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ada },
      body: JSON.stringify({ slug: "overflow", destination: "https://ada.example/overflow" }),
    });
    expect(capped.status).toBe(400);
    expect(await capped.json()).toEqual({ error: "Hosted accounts are limited to 100 codes." });

    const operator = await operatorLogin();
    const disabled = await exports.default.fetch(`https://permaqr.test/api/operator/accounts/${account?.id}/disable`, {
      method: "POST",
      headers: { cookie: operator },
    });
    expect(disabled.status).toBe(200);
    const blockedLogin = await exports.default.fetch("https://permaqr.test/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: ACCOUNT_PASSWORD }),
    });
    expect(blockedLogin.status).toBe(403);
    const pausedRedirect = await exports.default.fetch("https://permaqr.test/u/ada/c0");
    expect(pausedRedirect.status).toBe(404);

    const enabled = await exports.default.fetch(`https://permaqr.test/api/operator/accounts/${account?.id}/enable`, {
      method: "POST",
      headers: { cookie: operator },
    });
    expect(enabled.status).toBe(200);

    const refundBody = orderPayload({
      event: "order_refunded",
      refunded: true,
      orderId: "700",
      identifier: "304e18a2-d755-4d4b-80c4-a6c1dcbe1c12",
      email: "ada@example.com",
    });
    const refund = await exports.default.fetch("https://permaqr.test/api/webhooks/lemonsqueezy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": await signBody(refundBody),
        "x-event-name": "order_refunded",
      },
      body: refundBody,
    });
    expect(refund.status).toBe(200);
    expect(await refund.json()).toMatchObject({ disabled: true });
    const afterRefund = await exports.default.fetch("https://permaqr.test/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: ACCOUNT_PASSWORD }),
    });
    expect(afterRefund.status).toBe(403);
  });

  it("lets the operator issue a setup link and shows the hosted offer on the landing page", async () => {
    expect((await postWebhook(orderPayload({ email: "ada@example.com" }))).status).toBe(200);
    const setup = await exports.default.fetch("https://permaqr.test/api/account/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order_identifier: "104e18a2-d755-4d4b-80c4-a6c1dcbe1c10",
        password: ACCOUNT_PASSWORD,
      }),
    });
    expect(setup.status).toBe(200);

    const operator = await operatorLogin();
    const accounts = await exports.default.fetch("https://permaqr.test/api/operator/accounts", {
      headers: { cookie: operator },
    });
    const listed = (await accounts.json()) as { accounts: { id: string; handle: string }[] };
    expect(listed.accounts).toHaveLength(1);
    const link = await exports.default.fetch(
      `https://permaqr.test/api/operator/accounts/${listed.accounts[0]?.id}/setup-link`,
      { method: "POST", headers: { cookie: operator } },
    );
    expect(link.status).toBe(200);
    const issued = (await link.json()) as { setup_url: string };
    const token = new URL(issued.setup_url).searchParams.get("token");
    expect(token).toBeTruthy();

    const oldLogin = await exports.default.fetch("https://permaqr.test/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com", password: ACCOUNT_PASSWORD }),
    });
    expect(oldLogin.status).toBe(403);

    const reset = await exports.default.fetch("https://permaqr.test/api/account/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "a-new-password" }),
    });
    expect(reset.status).toBe(200);

    const landing = await exports.default.fetch("https://permaqr.test/");
    const html = await landing.text();
    expect(html).toContain('id="hosted"');
    expect(html).not.toContain('id="hosted" hidden');
    expect(html).toContain("Self-hosting stays free. Hosted is $29 once if you would rather not run it.");

    const config = await exports.default.fetch("https://permaqr.test/api/config");
    expect(await config.json()).toEqual({
      hosted: true,
      price: "$29",
      checkout_path: "/api/hosted/checkout",
    });
  });
});
