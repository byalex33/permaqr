export type ParsedAgent = {
  device: "mobile" | "tablet" | "desktop" | "bot" | "unknown";
  os: "iOS" | "Android" | "Windows" | "macOS" | "Linux" | "ChromeOS" | "Other";
};

const BOT = /bot|spider|crawler|slurp|preview|facebookexternalhit|whatsapp|telegram|embedly|quora link preview|discordbot/i;

export function parseUserAgent(ua: string | null): ParsedAgent {
  const source = ua ?? "";
  if (!source.trim()) return { device: "unknown", os: "Other" };
  if (BOT.test(source)) {
    return { device: "bot", os: detectOs(source) };
  }

  const os = detectOs(source);
  const isTablet =
    /iPad|Tablet|PlayBook|Silk/i.test(source) ||
    (/Android/i.test(source) && !/Mobile/i.test(source));
  if (isTablet) return { device: "tablet", os };
  if (/Mobile|iPhone|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(source)) {
    return { device: "mobile", os };
  }
  return { device: "desktop", os };
}

function detectOs(source: string): ParsedAgent["os"] {
  if (/iPhone|iPad|iPod|iOS/i.test(source)) return "iOS";
  if (/Android/i.test(source)) return "Android";
  if (/Windows/i.test(source)) return "Windows";
  if (/CrOS/i.test(source)) return "ChromeOS";
  if (/Mac OS X|Macintosh/i.test(source)) return "macOS";
  if (/Linux/i.test(source)) return "Linux";
  return "Other";
}

/** Country from Cloudflare's request metadata. The connecting IP is never stored. */
export function requestCountry(request: Request): string {
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const candidate = cf?.country || request.headers.get("CF-IPCountry") || "";
  if (!/^[A-Za-z]{2}$/.test(candidate)) return "";
  const code = candidate.toUpperCase();
  if (code === "XX") return "";
  return code;
}

/** Hostname only, so referrer query strings (tokens, emails) are never stored. */
export function referrerHost(request: Request): string {
  const raw = request.headers.get("Referer");
  if (!raw) return "";
  try {
    return new URL(raw).hostname.slice(0, 253);
  } catch {
    return "";
  }
}
