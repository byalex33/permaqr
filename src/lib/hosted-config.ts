/** Slugs the operator must not take while hosted routes are on. Self-host mode does not use this list. */
export const HOSTED_OPERATOR_RESERVED = ["u", "account", "welcome"] as const;

export const HOSTED_CODE_CAP = 100;
export const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
export const HOSTED_PRICE_LABEL = "$29";

export function isHostedMode(env: { HOSTED_MODE?: string }): boolean {
  return env.HOSTED_MODE?.trim().toLowerCase() === "true";
}

export function accountCacheKey(handle: string, slug: string): string {
  return `u:${handle}:${slug}`;
}
