import type { AppEnv } from "../env";

type AccessJwk = JsonWebKey & { kid?: string };

let jwksCache: { team: string; keys: AccessJwk[]; expires: number } | null = null;

function base64UrlToBytes(input: string): Uint8Array | null {
  try {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
    const binary = atob(input.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function teamHost(team: string): string {
  const trimmed = team.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return new URL(trimmed).host;
  if (trimmed.includes(".")) return trimmed;
  return `${trimmed}.cloudflareaccess.com`;
}

async function getJwks(team: string): Promise<AccessJwk[]> {
  const host = teamHost(team);
  const now = Date.now();
  if (jwksCache && jwksCache.team === host && jwksCache.expires > now) return jwksCache.keys;
  const response = await fetch(`https://${host}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`access certs ${response.status}`);
  const body = (await response.json()) as { keys?: AccessJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { team: host, keys, expires: now + 60 * 60 * 1000 };
  return keys;
}

/**
 * Optional Cloudflare Access. The email header alone is not trusted.
 * A request is accepted only when the Access JWT signature, issuer, audience, and expiry check out.
 */
export async function hasValidAccessJwt(request: Request, env: AppEnv): Promise<boolean> {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!team || !audience) return false;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const headerBytes = base64UrlToBytes(headerPart);
  const payloadBytes = base64UrlToBytes(payloadPart);
  const signature = base64UrlToBytes(signaturePart);
  if (!headerBytes || !payloadBytes || !signature) return false;

  let header: { alg?: string; kid?: string };
  let payload: { exp?: number; iss?: string; aud?: string | string[] };
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes)) as { alg?: string; kid?: string };
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      exp?: number;
      iss?: string;
      aud?: string | string[];
    };
  } catch {
    return false;
  }

  if (header.alg !== "RS256" || !header.kid) return false;
  const host = teamHost(team);
  if (payload.iss !== `https://${host}`) return false;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(audience)) return false;

  try {
    const jwk = (await getJwks(team)).find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "access jwt verify failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return false;
  }
}
