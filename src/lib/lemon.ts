import type { AppEnv } from "../env";
import { fixedEqual } from "./encoding";

export type LemonOrder = {
  event: string;
  orderId: string;
  identifier: string;
  email: string;
  variantId: string | null;
  claim: string | null;
  testMode: boolean;
  refunded: boolean;
  status: string;
};

/**
 * Lemon Squeezy signs the raw body with HMAC-SHA256 and sends the hex digest in `X-Signature`.
 * https://docs.lemonsqueezy.com/help/webhooks/signing-requests
 */
export async function lemonSignatureValid(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.trim() || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return fixedEqual(expected, header.trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function configuredVariantId(env: AppEnv): string | null {
  const value = env.LEMONSQUEEZY_VARIANT_ID?.trim();
  return value || null;
}

export function variantAllowed(env: AppEnv, variantId: string | null): boolean {
  const expected = configuredVariantId(env);
  if (!expected) return true;
  return variantId === expected;
}

/** Pull the fields we provision from. Returns null when the body is not an order event. */
export function parseLemonOrder(body: unknown, eventHeader: string | null): LemonOrder | null {
  const root = asRecord(body);
  if (!root) return null;
  const meta = asRecord(root.meta);
  const data = asRecord(root.data);
  const attributes = asRecord(data?.attributes);
  if (!data || !attributes) return null;

  const event = stringValue(meta?.event_name) ?? stringValue(eventHeader) ?? "";
  if (event !== "order_created" && event !== "order_refunded") return null;

  const orderId = stringValue(data.id);
  const identifier = stringValue(attributes.identifier);
  const email = stringValue(attributes.user_email)?.toLowerCase() ?? null;
  if (!orderId || !identifier || !email) return null;

  const item = asRecord(attributes.first_order_item);
  const custom = asRecord(meta?.custom_data);
  const claim = stringValue(custom?.claim);
  const status = stringValue(attributes.status)?.toLowerCase() ?? "";
  const testMode = attributes.test_mode === true || item?.test_mode === true;

  return {
    event,
    orderId,
    identifier,
    email,
    variantId: stringValue(item?.variant_id),
    claim,
    testMode,
    refunded: attributes.refunded === true || event === "order_refunded",
    status,
  };
}
