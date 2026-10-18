export const DOT_STYLES = [
  "square",
  "rounded",
  "dots",
  "classy",
  "classy-rounded",
  "extra-rounded",
] as const;

export const CORNER_STYLES = ["square", "rounded", "extra-rounded", "dot", "dots"] as const;

export const ECC_LEVELS = ["L", "M", "Q", "H"] as const;

export type DotStyle = (typeof DOT_STYLES)[number];
export type CornerStyle = (typeof CORNER_STYLES)[number];
export type EccLevel = (typeof ECC_LEVELS)[number];

export type QrStyle = {
  fg: string;
  bg: string;
  dots: DotStyle;
  corners: CornerStyle;
  ecc: EccLevel;
  /** Quiet zone in modules, 0–8. */
  quiet: number;
  /** Optional centre logo as a data URL. */
  logo?: string;
};

export const DEFAULT_STYLE: QrStyle = {
  fg: "#1b1714",
  bg: "#fbf7ef",
  dots: "rounded",
  corners: "extra-rounded",
  ecc: "Q",
  quiet: 2,
};

export const DEFAULT_FALLBACK_MESSAGE =
  "This code isn't available. It may have been paused, or it never existed. If you printed it, the person who owns it can turn it back on.";

export type CodeRecord = {
  id: string;
  slug: string;
  title: string;
  destination: string;
  paused: boolean;
  style: QrStyle;
  created_at: number;
  updated_at: number;
  scans: number;
};

export type AnalyticsSeriesPoint = { date: string; count: number };
export type AnalyticsBucket = { label: string; count: number };

export type AnalyticsResponse = {
  total: number;
  ranged_total: number;
  range: "7d" | "30d" | "90d" | "all";
  series: AnalyticsSeriesPoint[];
  countries: AnalyticsBucket[];
  devices: AnalyticsBucket[];
  os: AnalyticsBucket[];
};

export type ExportCode = {
  slug: string;
  title: string;
  destination: string;
  paused: boolean;
  style: QrStyle;
  created_at: string;
  updated_at: string;
};

export type ExportFile = {
  version: 1;
  exported_at: string;
  fallback_message: string;
  codes: ExportCode[];
};

export const RESERVED_SLUGS = [
  "api",
  "app",
  "login",
  "logout",
  "assets",
  "health",
  "admin",
  "static",
  "export",
  "import",
  "qr",
  "settings",
  "site",
  "favicon.ico",
  "robots.txt",
] as const;
