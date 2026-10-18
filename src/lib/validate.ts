import {
  CORNER_STYLES,
  DEFAULT_STYLE,
  DOT_STYLES,
  ECC_LEVELS,
  RESERVED_SLUGS,
  type QrStyle,
} from "../../shared/types";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LOGO_PREFIX = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/;
const MAX_LOGO_CHARS = 120_000;

const reserved = new Set<string>(RESERVED_SLUGS);

export function slugProblem(input: string): string | null {
  const slug = input.trim().toLowerCase();
  if (reserved.has(slug)) return "That short code is reserved.";
  if (!SLUG_PATTERN.test(slug)) {
    return "Slug must be 1–64 characters: letters, numbers, hyphens, or underscores, and must start and end with a letter or number.";
  }
  return null;
}

export function normalizeSlug(input: string): string | null {
  if (slugProblem(input)) return null;
  return input.trim().toLowerCase();
}

export function validateDestination(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  const value = url.toString();
  if (value.length > 2048) return null;
  return value;
}

export function cleanTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120);
}

export function validateStyle(input: unknown): QrStyle | null {
  if (input === undefined || input === null) return { ...DEFAULT_STYLE };
  if (typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const fg = typeof raw.fg === "string" && HEX_COLOR.test(raw.fg) ? raw.fg : null;
  const bg = typeof raw.bg === "string" && HEX_COLOR.test(raw.bg) ? raw.bg : null;
  if (!fg || !bg) return null;
  if (typeof raw.dots !== "string" || !DOT_STYLES.includes(raw.dots as QrStyle["dots"])) return null;
  if (typeof raw.corners !== "string" || !CORNER_STYLES.includes(raw.corners as QrStyle["corners"])) {
    return null;
  }
  if (typeof raw.ecc !== "string" || !ECC_LEVELS.includes(raw.ecc as QrStyle["ecc"])) return null;
  const quiet = typeof raw.quiet === "number" ? raw.quiet : Number(raw.quiet);
  if (!Number.isInteger(quiet) || quiet < 0 || quiet > 8) return null;

  const style: QrStyle = {
    fg,
    bg,
    dots: raw.dots as QrStyle["dots"],
    corners: raw.corners as QrStyle["corners"],
    ecc: raw.ecc as QrStyle["ecc"],
    quiet,
  };

  if (raw.logo !== undefined && raw.logo !== null && raw.logo !== "") {
    if (typeof raw.logo !== "string") return null;
    if (!LOGO_PREFIX.test(raw.logo) || raw.logo.length > MAX_LOGO_CHARS) return null;
    style.logo = raw.logo;
    if (style.ecc === "L" || style.ecc === "M") style.ecc = "H";
  }
  return style;
}

export function parseStoredStyle(raw: string): QrStyle {
  try {
    const parsed = validateStyle(JSON.parse(raw) as unknown);
    return parsed ?? { ...DEFAULT_STYLE };
  } catch {
    return { ...DEFAULT_STYLE };
  }
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function randomSlug(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(8))): string {
  let slug = "";
  for (const byte of bytes) slug += ALPHABET[byte % ALPHABET.length];
  return slug;
}
