import { bytesToBase64Url, base64UrlToBytes, fixedEqual } from "./encoding";

const ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

/** A valid hash that does not match any real password. Keeps unknown-email logins on the same cost. */
const DUMMY_HASH =
  "pbkdf2$100000$AQIDBAUGBwgJCgsMDQ4PEA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200_000) return false;
  const salt = base64UrlToBytes(parts[2] ?? "");
  const expected = base64UrlToBytes(parts[3] ?? "");
  if (!salt || !expected || salt.byteLength < 8 || expected.byteLength !== HASH_BYTES) return false;
  const actual = await pbkdf2(password, salt, iterations);
  return fixedEqual(bytesToBase64Url(actual), bytesToBase64Url(expected));
}

export async function dummyPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

export function passwordAcceptable(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  return null;
}
