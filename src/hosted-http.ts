import type { AccountRow } from "./lib/accounts";
import {
  disableAccountForOrder,
  findAccountById,
  findAccountByOrderIdentifier,
  issueSetupToken,
  listAccountSummaries,
  loginAccount,
  provisionPaidOrder,
  readClaim,
  rememberClaim,
  setAccountDisabled,
  setPasswordFromOrder,
  setPasswordFromToken,
} from "./lib/accounts";
import {
  isAuthenticated,
  passwordVersion,
  readAccountSession,
  readCookie,
  sessionCookie,
  signAccountSession,
  SESSION_COOKIE,
} from "./lib/auth";
import { fixedEqual, randomToken } from "./lib/encoding";
import { HOSTED_PRICE_LABEL, isHostedMode } from "./lib/hosted-config";
import { error, isSameOrigin, json, readBody, readJson } from "./lib/http";
import { lemonSignatureValid, parseLemonOrder } from "./lib/lemon";
import { clearFailures, failureBlocked, hitLimit, noteFailure } from "./lib/rate";
import type { AppEnv } from "./env";

export const CLAIM_COOKIE = "permaqr_claim";
const CLAIM_TTL_SECONDS = 60 * 60 * 2;

export function publicConfig(env: AppEnv): { hosted: false } | { hosted: true; price: string; checkout_path: string } {
  if (!isHostedMode(env)) return { hosted: false };
  return { hosted: true, price: HOSTED_PRICE_LABEL, checkout_path: "/api/hosted/checkout" };
}

/** Reveal the hosted offer on the landing page. Self-host HTML is left untouched. */
export function rewriteLanding(html: string): string {
  return html
    .replace('id="hosted" hidden', 'id="hosted"')
    .replace('id="hosted-signin" hidden', 'id="hosted-signin"')
    .replace('id="hosted-nav" hidden', 'id="hosted-nav"')
    .replace(
      "No account with us, because there is no us.",
      "Self-hosting stays free. Hosted is $29 once if you would rather not run it.",
    );
}

const USER_CODE = /^\/u\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)$/;

export function hostedUserCode(path: string): { handle: string; slug: string } | null {
  const match = USER_CODE.exec(path);
  if (!match?.[1] || !match[2]) return null;
  return { handle: match[1], slug: match[2] };
}

export function isHostedApi(path: string): boolean {
  return (
    path === "/api/webhooks/lemonsqueezy" ||
    path.startsWith("/api/hosted/") ||
    path.startsWith("/api/account/") ||
    path.startsWith("/api/operator/")
  );
}

function claimCookie(request: Request, token: string, maxAge = CLAIM_TTL_SECONDS): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${CLAIM_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export async function accountActor(request: Request, env: AppEnv): Promise<AccountRow | null> {
  if (!isHostedMode(env) || !env.ADMIN_PASSWORD) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const parsed = await readAccountSession(env.ADMIN_PASSWORD, token);
  if (!parsed) return null;
  const account = await findAccountById(env, parsed.sub);
  if (!account?.password_hash || account.disabled) return null;
  if (!(await fixedEqual(await passwordVersion(account.password_hash), parsed.ver))) return null;
  return account;
}

export async function handleHostedApi(request: Request, env: AppEnv, path: string): Promise<Response> {
  if (path === "/api/webhooks/lemonsqueezy" && request.method === "POST") return webhook(request, env);
  if (path === "/api/hosted/checkout" && request.method === "GET") return checkout(request, env);
  if (path === "/api/hosted/claim" && request.method === "POST") return claim(request, env);
  if (path === "/api/hosted/order" && request.method === "GET") return orderStatus(request, env);
  if (path === "/api/account/login" && request.method === "POST") return accountLogin(request, env);
  if (path === "/api/account/setup" && request.method === "POST") return accountSetup(request, env);
  if (path === "/api/account/session" && request.method === "GET") return accountSession(request, env);
  if (path === "/api/operator/accounts" && request.method === "GET") return operatorList(request, env);

  const action = /^\/api\/operator\/accounts\/([^/]+)\/(disable|enable|setup-link)$/.exec(path);
  if (action && request.method === "POST") {
    return operatorAction(request, env, action[1] ?? "", action[2] ?? "");
  }
  return error("Not found", 404);
}

async function webhook(request: Request, env: AppEnv): Promise<Response> {
  if (await hitLimit(env, "webhook", request, 120, 600)) return error("Too many requests.", 429);
  const secret = env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim();
  if (!secret) return error("LEMONSQUEEZY_WEBHOOK_SECRET is not configured.", 503);
  const raw = await readBody(request, 1_000_000);
  if (raw instanceof Response) return raw;
  if (!(await lemonSignatureValid(secret, raw, request.headers.get("X-Signature")))) {
    return error("Invalid signature.", 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return error("Invalid JSON", 400);
  }
  const order = parseLemonOrder(parsed, request.headers.get("X-Event-Name"));
  if (!order) return json({ ok: true, ignored: true });
  if (order.event === "order_refunded" || order.refunded) {
    const disabled = await disableAccountForOrder(env, order);
    return json({ ok: true, disabled });
  }
  try {
    const result = await provisionPaidOrder(env, order);
    if (!result.ok) return json({ ok: true, ignored: true });
    console.log(
      JSON.stringify({
        message: "hosted account provisioned",
        order_id: order.orderId,
        handle: result.handle,
        created: result.created,
      }),
    );
    return json({ ok: true, created: result.created });
  } catch (cause) {
    console.error(
      JSON.stringify({
        message: "hosted provision failed",
        error: cause instanceof Error ? cause.message : "unknown",
      }),
    );
    return error("Could not provision the account.", 500);
  }
}

async function checkout(request: Request, env: AppEnv): Promise<Response> {
  if (await hitLimit(env, "checkout", request, 10, 600)) {
    return error("Too many checkout attempts. Try again in a few minutes.", 429);
  }
  const base = env.LEMONSQUEEZY_CHECKOUT_URL?.trim();
  if (!base) return error("LEMONSQUEEZY_CHECKOUT_URL is not configured.", 503);
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return error("LEMONSQUEEZY_CHECKOUT_URL is not a valid URL.", 503);
  }
  if (target.protocol !== "https:") return error("LEMONSQUEEZY_CHECKOUT_URL must be https.", 503);
  const claim = randomToken();
  await rememberClaim(env, claim);
  const join = base.includes("?") ? "&" : "?";
  const location = `${base}${join}checkout[custom][claim]=${encodeURIComponent(claim)}`;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "set-cookie": claimCookie(request, claim),
    },
  });
}

async function claim(request: Request, env: AppEnv): Promise<Response> {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (await hitLimit(env, "claim", request, 60, 600)) return error("Too many requests.", 429);
  const token = readCookie(request, CLAIM_COOKIE);
  if (!token) return json({ status: "missing" });
  const record = await readClaim(env, token);
  if (!record) return json({ status: "missing" });
  if (record.status === "pending") return json({ status: "pending" });
  return json({ status: "ready", order_identifier: record.order_identifier, email: record.email });
}

async function orderStatus(request: Request, env: AppEnv): Promise<Response> {
  if (await hitLimit(env, "order", request, 60, 600)) return error("Too many requests.", 429);
  const identifier = new URL(request.url).searchParams.get("order_identifier")?.trim() ?? "";
  if (!/^[0-9a-f-]{16,80}$/i.test(identifier)) return json({ status: "pending" });
  const account = await findAccountByOrderIdentifier(env, identifier);
  if (!account) return json({ status: "pending" });
  return json({
    status: "ready",
    email: account.email,
    password_set: Boolean(account.password_hash),
    disabled: account.disabled === 1,
  });
}

async function accountLogin(request: Request, env: AppEnv): Promise<Response> {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (!env.ADMIN_PASSWORD) return error("Admin password is not configured.", 503);
  if (await failureBlocked(env, "acct-login", request, 8)) {
    return error("Too many sign-in attempts. Try again in a few minutes.", 429);
  }
  const body = await readJson(request, 8_000);
  if (body instanceof Response) return body;
  const record = (body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof record.email === "string" ? record.email : "";
  const password = typeof record.password === "string" ? record.password : "";
  const result = await loginAccount(env, email, password);
  if (!result.ok) {
    await noteFailure(env, "acct-login", request, 600);
    return error(result.error, result.status);
  }
  if (!result.account.password_hash) {
    await noteFailure(env, "acct-login", request, 600);
    return error("Wrong email or password.", 401);
  }
  await clearFailures(env, "acct-login", request);
  const token = await signAccountSession(env.ADMIN_PASSWORD, result.account.id, result.account.password_hash);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, token) });
}

async function accountSetup(request: Request, env: AppEnv): Promise<Response> {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (!env.ADMIN_PASSWORD) return error("Admin password is not configured.", 503);
  if (await hitLimit(env, "setup", request, 8, 600)) {
    return error("Too many setup attempts. Try again in a few minutes.", 429);
  }
  const body = await readJson(request, 8_000);
  if (body instanceof Response) return body;
  const record = (body ?? {}) as { password?: unknown; order_identifier?: unknown; token?: unknown };
  const password = typeof record.password === "string" ? record.password : "";
  const token = typeof record.token === "string" ? record.token : "";
  const orderIdentifier = typeof record.order_identifier === "string" ? record.order_identifier : "";
  const result = token
    ? await setPasswordFromToken(env, token, password)
    : orderIdentifier
      ? await setPasswordFromOrder(env, orderIdentifier, password)
      : { ok: false as const, error: "A setup link is required.", status: 400 };
  if (!result.ok) return error(result.error, result.status);
  if (!result.account.password_hash) return error("Could not save the password.", 500);
  const session = await signAccountSession(env.ADMIN_PASSWORD, result.account.id, result.account.password_hash);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, session) });
}

async function accountSession(request: Request, env: AppEnv): Promise<Response> {
  const account = await accountActor(request, env);
  if (!account) return json({ authenticated: false });
  return json({ authenticated: true, email: account.email, handle: account.handle });
}

async function requireOperator(request: Request, env: AppEnv): Promise<Response | null> {
  if (!isSameOrigin(request)) return error("Cross-origin request blocked", 403);
  if (!(await isAuthenticated(request, env))) return error("Sign in required", 401);
  return null;
}

async function operatorList(request: Request, env: AppEnv): Promise<Response> {
  const denied = await requireOperator(request, env);
  if (denied) return denied;
  return json({ accounts: await listAccountSummaries(env) });
}

async function operatorAction(request: Request, env: AppEnv, id: string, action: string): Promise<Response> {
  const denied = await requireOperator(request, env);
  if (denied) return denied;
  if (action === "disable" || action === "enable") {
    const updated = await setAccountDisabled(env, id, action === "disable");
    return updated ? json({ ok: true }) : error("Account not found.", 404);
  }
  const issued = await issueSetupToken(env, id);
  if (!issued) return error("Account not found.", 404);
  const setupUrl = new URL("/account/setup", request.url);
  setupUrl.searchParams.set("token", issued.token);
  return json({ setup_url: setupUrl.href, email: issued.account.email });
}
