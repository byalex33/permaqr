export interface AppEnv extends Env {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Set to "true" to turn on hosted accounts. Anything else, including unset, is single-admin mode. */
  HOSTED_MODE?: string;
  /** Full Lemon Squeezy buy link, https://STORE.lemonsqueezy.com/checkout/buy/VARIANT */
  LEMONSQUEEZY_CHECKOUT_URL?: string;
  /** Signing secret from the Lemon Squeezy webhook. */
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  /** When set, only orders for this variant id provision an account. */
  LEMONSQUEEZY_VARIANT_ID?: string;
}
