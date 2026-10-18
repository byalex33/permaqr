import { describe, expect, it } from "vitest";
import { parseUserAgent, referrerHost, requestCountry } from "../src/lib/ua";

describe("user agent parsing", () => {
  it("classifies phones", () => {
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toEqual({
      device: "mobile",
      os: "iOS",
    });
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile")).toEqual({
      device: "mobile",
      os: "Android",
    });
  });

  it("classifies tablets, desktops, and bots", () => {
    expect(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)")).toEqual({
      device: "tablet",
      os: "iOS",
    });
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({
      device: "desktop",
      os: "Windows",
    });
    expect(parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toEqual({
      device: "desktop",
      os: "macOS",
    });
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
      device: "desktop",
      os: "Linux",
    });
    expect(parseUserAgent("Mozilla/5.0 (X11; CrOS x86_64 15633)")).toEqual({
      device: "desktop",
      os: "ChromeOS",
    });
    expect(parseUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toEqual({
      device: "bot",
      os: "Other",
    });
  });

  it("returns unknown for an empty agent", () => {
    expect(parseUserAgent("")).toEqual({ device: "unknown", os: "Other" });
    expect(parseUserAgent(null)).toEqual({ device: "unknown", os: "Other" });
  });
});

describe("request metadata", () => {
  it("reads a country code and ignores unknown", () => {
    const request = new Request("https://permaqr.test/menu", { headers: { "CF-IPCountry": "de" } });
    expect(requestCountry(request)).toBe("DE");
    const unknown = new Request("https://permaqr.test/menu", { headers: { "CF-IPCountry": "XX" } });
    expect(requestCountry(unknown)).toBe("");
  });

  it("keeps only the referrer host", () => {
    const request = new Request("https://permaqr.test/menu", {
      headers: { Referer: "https://news.example/story?token=secret" },
    });
    expect(referrerHost(request)).toBe("news.example");
  });
});
