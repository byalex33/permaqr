import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCodeStyling from "qr-code-styling";
import type { QrStyle } from "../../shared/types";

type StylingOptions = NonNullable<ConstructorParameters<typeof QRCodeStyling>[0]>;

export function qrOptions(style: QrStyle, data: string, size: number): StylingOptions {
  const margin = Math.max(0, Math.round(style.quiet * (size / 28)));
  return {
    width: size,
    height: size,
    type: "svg",
    data,
    margin,
    qrOptions: { errorCorrectionLevel: style.ecc, typeNumber: 0 },
    dotsOptions: { color: style.fg, type: style.dots },
    backgroundOptions: { color: style.bg },
    cornersSquareOptions: { color: style.fg, type: style.corners },
    cornersDotOptions: { color: style.fg, type: "dot" },
    image: style.logo,
    imageOptions: {
      hideBackgroundDots: true,
      imageSize: 0.28,
      margin: 8,
      crossOrigin: "anonymous",
    },
  };
}

export function mountPreview(host: HTMLElement, style: QrStyle, data: string): void {
  host.replaceChildren();
  const qr = new QRCodeStyling(qrOptions(style, data, 320));
  qr.append(host);
}

async function renderBlob(style: QrStyle, data: string, size: number, extension: "png" | "svg"): Promise<Blob> {
  const qr = new QRCodeStyling({ ...qrOptions(style, data, size), type: extension === "svg" ? "svg" : "canvas" });
  const raw = await qr.getRawData(extension);
  if (!raw) throw new Error("Could not render the QR code");
  if (raw instanceof Blob) return raw;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: extension === "svg" ? "image/svg+xml" : "image/png" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadSvg(style: QrStyle, data: string, filename: string): Promise<void> {
  downloadBlob(await renderBlob(style, data, 1024, "svg"), filename);
}

export async function downloadPng(style: QrStyle, data: string, filename: string): Promise<void> {
  downloadBlob(await renderBlob(style, data, 2048, "png"), filename);
}

function pdfSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((part) => part + part).join("") : value;
  const parsed = Number.parseInt(full, 16);
  return { r: ((parsed >> 16) & 255) / 255, g: ((parsed >> 8) & 255) / 255, b: (parsed & 255) / 255 };
}

export async function downloadPdf(style: QrStyle, data: string, title: string, filename: string): Promise<void> {
  const png = await renderBlob(style, data, 1600, "png");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const background = hexToRgb(style.bg);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(background.r, background.g, background.b) });
  const image = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()));
  const size = 360;
  page.drawImage(image, { x: (612 - size) / 2, y: 280, width: size, height: size });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = hexToRgb(style.fg);
  const color = rgb(ink.r, ink.g, ink.b);
  const heading = pdfSafe(title || "PermaQR");
  const url = pdfSafe(data);
  const headingWidth = bold.widthOfTextAtSize(heading, 18);
  page.drawText(heading, { x: (612 - headingWidth) / 2, y: 680, size: 18, font: bold, color });
  const urlWidth = font.widthOfTextAtSize(url, 11);
  page.drawText(url, { x: Math.max(36, (612 - urlWidth) / 2), y: 248, size: 11, font, color });
  const footer = "Printed with PermaQR";
  const footerWidth = font.widthOfTextAtSize(footer, 9);
  page.drawText(footer, { x: (612 - footerWidth) / 2, y: 48, size: 9, font, color });
  const bytes = await pdf.save();
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  downloadBlob(new Blob([copy], { type: "application/pdf" }), filename);
}
