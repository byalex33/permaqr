import type { AppEnv } from "../env";
import { accountCacheKey, CLAIM_TTL_SECONDS, SETUP_TTL_MS } from "./hosted-config";
import type { LemonOrder } from "./lemon";
import { variantAllowed } from "./lemon";
import { randomToken, sha256Hex } from "./encoding";
import { dummyPasswordCheck, hashPassword, passwordAcceptable, verifyPassword } from "./password";

export type AccountRow = {
  id: string;
  email: string;
  handle: string;
  password_hash: string | null;
  setup_token_hash: string | null;
  setup_expires_at: number | null;
  disabled: number;
  created_at: number;
  updated_at: number;
};

export type AccountSummary = {
  id: string;
  email: string;
  handle: string;
  disabled: boolean;
  password_set: boolean;
  code_count: number;
  test_mode: boolean;
  created_at: number;
};

const HANDLE_RESERVED = new Set(["api", "app", "admin", "login", "www", "u", "account", "welcome", "operator", "hosted"]);

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function baseHandle(email: string): string {
  const local = email.split("@")[0] ?? "";
  let handle = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (handle.length < 1 || HANDLE_RESERVED.has(handle)) handle = "user";
  return handle;
}

async function handleTaken(env: AppEnv, handle: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE handle = ?").bind(handle).first();
  return Boolean(row);
}

async function allocateHandle(env: AppEnv, email: string): Promise<string> {
  const base = baseHandle(email);
  if (!(await handleTaken(env, base))) return base;
  for (let n = 2; n <= 20; n++) {
    const candidate = `${base}-${n}`.slice(0, 32);
    if (!(await handleTaken(env, candidate))) return candidate;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${base}-${randomToken(3)}`.replace(/[^a-z0-9-]/g, "").slice(0, 32);
    if (candidate.length >= 2 && !(await handleTaken(env, candidate))) return candidate;
  }
  throw new Error("could not allocate a handle");
}

export async function findAccountById(env: AppEnv, id: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    `SELECT id, email, handle, password_hash, setup_token_hash, setup_expires_at, disabled, created_at, updated_at
     FROM accounts WHERE id = ?`,
  )
    .bind(id)
    .first<AccountRow>();
}

export async function findAccountByEmail(env: AppEnv, email: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    `SELECT id, email, handle, password_hash, setup_token_hash, setup_expires_at, disabled, created_at, updated_at
     FROM accounts WHERE email = ?`,
  )
    .bind(email)
    .first<AccountRow>();
}

export async function findAccountByHandle(env: AppEnv, handle: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    `SELECT id, email, handle, password_hash, setup_token_hash, setup_expires_at, disabled, created_at, updated_at
     FROM accounts WHERE handle = ?`,
  )
    .bind(handle)
    .first<AccountRow>();
}

export async function findAccountByOrderIdentifier(env: AppEnv, identifier: string): Promise<AccountRow | null> {
  return env.DB.prepare(
    `SELECT a.id, a.email, a.handle, a.password_hash, a.setup_token_hash, a.setup_expires_at, a.disabled, a.created_at, a.updated_at
     FROM accounts a
     JOIN account_orders o ON o.account_id = a.id
     WHERE o.identifier = ?`,
  )
    .bind(identifier)
    .first<AccountRow>();
}

async function dropCodeCache(env: AppEnv, account: { id: string; handle: string }): Promise<void> {
  const { results } = await env.DB.prepare("SELECT slug FROM account_codes WHERE account_id = ?")
    .bind(account.id)
    .all<{ slug: string }>();
  await Promise.all(results.map((row) => env.CODES.delete(accountCacheKey(account.handle, row.slug))));
}

export async function rememberClaim(env: AppEnv, claim: string): Promise<void> {
  await env.CODES.put(`claim:${claim}`, JSON.stringify({ status: "pending" }), { expirationTtl: CLAIM_TTL_SECONDS });
}

export async function readClaim(
  env: AppEnv,
  claim: string,
): Promise<{ status: "pending" } | { status: "ready"; order_identifier: string; email: string } | null> {
  const raw = await env.CODES.get(`claim:${claim}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { status?: string; order_identifier?: string; email?: string };
    if (parsed.status === "ready" && parsed.order_identifier && parsed.email) {
      return { status: "ready", order_identifier: parsed.order_identifier, email: parsed.email };
    }
    return { status: "pending" };
  } catch {
    return { status: "pending" };
  }
}

async function attachClaim(env: AppEnv, claim: string | null, identifier: string, email: string): Promise<void> {
  if (!claim || !/^[A-Za-z0-9_-]{20,128}$/.test(claim)) return;
  await env.CODES.put(
    `claim:${claim}`,
    JSON.stringify({ status: "ready", order_identifier: identifier, email }),
    { expirationTtl: CLAIM_TTL_SECONDS },
  );
}

export type ProvisionResult =
  | { ok: true; created: boolean; accountId: string; handle: string }
  | { ok: false; reason: "ignored" };

/**
 * Create or reuse a workspace for a paid order. The same order id is a no-op.
 * A second paid order for the same email reuses the workspace and does not reset the password.
 */
export async function provisionPaidOrder(env: AppEnv, order: LemonOrder): Promise<ProvisionResult> {
  if (order.event !== "order_created") return { ok: false, reason: "ignored" };
  if (order.status !== "paid" || order.refunded) return { ok: false, reason: "ignored" };
  if (!variantAllowed(env, order.variantId)) return { ok: false, reason: "ignored" };
  const email = normalizeEmail(order.email);
  if (!email) return { ok: false, reason: "ignored" };

  const existingOrder = await env.DB.prepare("SELECT account_id FROM account_orders WHERE order_id = ?")
    .bind(order.orderId)
    .first<{ account_id: string }>();
  if (existingOrder) {
    const account = await findAccountById(env, existingOrder.account_id);
    if (account) await attachClaim(env, order.claim, order.identifier, account.email);
    return { ok: true, created: false, accountId: existingOrder.account_id, handle: account?.handle ?? "" };
  }

  const now = Date.now();
  const byEmail = await findAccountByEmail(env, email);
  if (byEmail) {
    await env.DB.prepare(
      "INSERT INTO account_orders (order_id, identifier, account_id, test_mode, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(order.orderId, order.identifier, byEmail.id, order.testMode ? 1 : 0, now)
      .run();
    await attachClaim(env, order.claim, order.identifier, byEmail.email);
    return { ok: true, created: false, accountId: byEmail.id, handle: byEmail.handle };
  }

  const id = crypto.randomUUID();
  const handle = await allocateHandle(env, email);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (id, email, handle, password_hash, setup_token_hash, setup_expires_at, disabled, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
    ).bind(id, email, handle, now, now),
    env.DB.prepare(
      "INSERT INTO account_orders (order_id, identifier, account_id, test_mode, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(order.orderId, order.identifier, id, order.testMode ? 1 : 0, now),
  ]);
  await attachClaim(env, order.claim, order.identifier, email);
  return { ok: true, created: true, accountId: id, handle };
}

export async function disableAccountForOrder(env: AppEnv, order: LemonOrder): Promise<boolean> {
  const row = await env.DB.prepare("SELECT account_id FROM account_orders WHERE order_id = ? OR identifier = ?")
    .bind(order.orderId, order.identifier)
    .first<{ account_id: string }>();
  if (!row) return false;
  return setAccountDisabled(env, row.account_id, true);
}

export async function setAccountDisabled(env: AppEnv, id: string, disabled: boolean): Promise<boolean> {
  const account = await findAccountById(env, id);
  if (!account) return false;
  await env.DB.prepare("UPDATE accounts SET disabled = ?, updated_at = ? WHERE id = ?")
    .bind(disabled ? 1 : 0, Date.now(), id)
    .run();
  await dropCodeCache(env, account);
  return true;
}

async function storePassword(env: AppEnv, accountId: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE accounts SET password_hash = ?, setup_token_hash = NULL, setup_expires_at = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(passwordHash, now, accountId)
    .run();
}

export async function setPasswordFromOrder(
  env: AppEnv,
  identifier: string,
  password: string,
): Promise<{ ok: true; account: AccountRow } | { ok: false; error: string; status: number }> {
  const problem = passwordAcceptable(password);
  if (problem) return { ok: false, error: problem, status: 400 };
  if (!/^[0-9a-f-]{16,80}$/i.test(identifier)) return { ok: false, error: "That setup link is not valid.", status: 400 };
  const row = await env.DB.prepare(
    `SELECT a.id, a.disabled, a.password_hash, o.created_at AS ordered_at
     FROM accounts a
     JOIN account_orders o ON o.account_id = a.id
     WHERE o.identifier = ?`,
  )
    .bind(identifier)
    .first<{ id: string; disabled: number; password_hash: string | null; ordered_at: number }>();
  if (!row || row.disabled) return { ok: false, error: "That setup link is not valid.", status: 400 };
  if (row.password_hash) return { ok: false, error: "A password is already set. Sign in instead.", status: 409 };
  if (Date.now() - row.ordered_at > SETUP_TTL_MS) {
    return { ok: false, error: "That setup link has expired. Ask the operator for a new one.", status: 400 };
  }
  await storePassword(env, row.id, password);
  const updated = await findAccountById(env, row.id);
  if (!updated?.password_hash) return { ok: false, error: "Could not save the password.", status: 500 };
  return { ok: true, account: updated };
}

export async function issueSetupToken(env: AppEnv, accountId: string): Promise<{ token: string; account: AccountRow } | null> {
  const account = await findAccountById(env, accountId);
  if (!account) return null;
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE accounts
     SET password_hash = NULL, setup_token_hash = ?, setup_expires_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(hash, now + SETUP_TTL_MS, now, accountId)
    .run();
  const updated = await findAccountById(env, accountId);
  if (!updated) return null;
  return { token, account: updated };
}

export async function setPasswordFromToken(
  env: AppEnv,
  token: string,
  password: string,
): Promise<{ ok: true; account: AccountRow } | { ok: false; error: string; status: number }> {
  const problem = passwordAcceptable(password);
  if (problem) return { ok: false, error: problem, status: 400 };
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return { ok: false, error: "That setup link is not valid.", status: 400 };
  const hash = await sha256Hex(token);
  const match = await env.DB.prepare(
    `SELECT id, email, handle, password_hash, setup_token_hash, setup_expires_at, disabled, created_at, updated_at
     FROM accounts WHERE setup_token_hash = ?`,
  )
    .bind(hash)
    .first<AccountRow>();
  if (!match || match.disabled) return { ok: false, error: "That setup link is not valid.", status: 400 };
  if (!match.setup_expires_at || match.setup_expires_at < Date.now()) {
    return { ok: false, error: "That setup link has expired. Ask the operator for a new one.", status: 400 };
  }
  await storePassword(env, match.id, password);
  const updated = await findAccountById(env, match.id);
  if (!updated?.password_hash) return { ok: false, error: "Could not save the password.", status: 500 };
  return { ok: true, account: updated };
}

export type LoginResult =
  | { ok: true; account: AccountRow }
  | { ok: false; error: string; status: number };

export async function loginAccount(env: AppEnv, emailRaw: string, password: string): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);
  const account = email ? await findAccountByEmail(env, email) : null;
  if (!account || !account.password_hash) {
    await dummyPasswordCheck(password);
    if (account && !account.password_hash) {
      return { ok: false, error: "Set a password from your checkout link first.", status: 403 };
    }
    return { ok: false, error: "Wrong email or password.", status: 401 };
  }
  const matches = await verifyPassword(password, account.password_hash);
  if (!matches) return { ok: false, error: "Wrong email or password.", status: 401 };
  if (account.disabled) return { ok: false, error: "This account is disabled.", status: 403 };
  return { ok: true, account };
}

export async function listAccountSummaries(env: AppEnv): Promise<AccountSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.email, a.handle, a.password_hash, a.disabled, a.created_at,
            (SELECT COUNT(*) FROM account_codes c WHERE c.account_id = a.id) AS code_count,
            (SELECT MAX(test_mode) FROM account_orders o WHERE o.account_id = a.id) AS test_mode
     FROM accounts a
     ORDER BY a.created_at DESC
     LIMIT 500`,
  ).all<{
    id: string;
    email: string;
    handle: string;
    password_hash: string | null;
    disabled: number;
    created_at: number;
    code_count: number;
    test_mode: number | null;
  }>();
  return results.map((row) => ({
    id: row.id,
    email: row.email,
    handle: row.handle,
    disabled: row.disabled === 1,
    password_set: Boolean(row.password_hash),
    code_count: Number(row.code_count) || 0,
    test_mode: row.test_mode === 1,
    created_at: row.created_at,
  }));
}
