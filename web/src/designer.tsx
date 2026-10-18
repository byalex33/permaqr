import { useEffect, useState } from "preact/hooks";
import { CORNER_STYLES, DOT_STYLES, ECC_LEVELS, type CodeRecord, type QrStyle } from "../../shared/types";
import { api } from "./api";

const MAX_LOGO = 100_000;

export function Designer({
  code,
  shortUrl,
  onSaved,
}: {
  code: CodeRecord;
  shortUrl: string;
  onSaved: (code: CodeRecord) => void;
}) {
  const [style, setStyle] = useState<QrStyle>(code.style);
  const [boundId, setBoundId] = useState(code.id);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");

  useEffect(() => {
    setStyle(code.style);
    setBoundId(code.id);
    setStatus("Saved");
    setError("");
  }, [code.id, code.updated_at, code.style]);

  useEffect(() => {
    let cancelled = false;
    void import("./qr").then(({ mountPreview }) => {
      if (cancelled) return;
      const host = document.querySelector<HTMLElement>("#qr-preview");
      if (host) mountPreview(host, style, shortUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [style, shortUrl]);

  useEffect(() => {
    if (boundId !== code.id) return;
    if (JSON.stringify(style) === JSON.stringify(code.style)) return;
    const handle = window.setTimeout(() => {
      setStatus("Saving…");
      api<{ code: CodeRecord }>(`/api/codes/${code.id}`, {
        method: "PATCH",
        body: JSON.stringify({ style }),
      })
        .then((result) => {
          setStatus("Saved");
          onSaved(result.code);
        })
        .catch((cause: Error) => {
          setStatus("Not saved");
          setError(cause.message);
        });
    }, 450);
    return () => window.clearTimeout(handle);
  }, [style, boundId, code.id, code.style, onSaved]);

  function update<K extends keyof QrStyle>(key: K, value: QrStyle[K]): void {
    setStyle((current) => ({ ...current, [key]: value }));
  }

  function onLogo(file: File | undefined): void {
    setError("");
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      setError("Logo must be PNG, JPEG, WebP, or SVG.");
      return;
    }
    if (file.size > MAX_LOGO) {
      setError("Logo must be under 100 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const logo = String(reader.result ?? "");
      setStyle((current) => ({ ...current, logo, ecc: current.ecc === "L" || current.ecc === "M" ? "H" : current.ecc }));
    };
    reader.readAsDataURL(file);
  }

  async function exportFile(kind: "svg" | "png" | "pdf"): Promise<void> {
    setError("");
    const filename = `permaqr-${code.slug}`;
    try {
      const qr = await import("./qr");
      if (kind === "svg") await qr.downloadSvg(style, shortUrl, `${filename}.svg`);
      if (kind === "png") await qr.downloadPng(style, shortUrl, `${filename}.png`);
      if (kind === "pdf") await qr.downloadPdf(style, shortUrl, code.title || code.slug, `${filename}.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed");
    }
  }

  return (
    <div class="designer">
      <div class="controls">
        <label>
          Foreground
          <span class="color-row">
            <input type="color" value={toFullHex(style.fg)} onInput={(event) => update("fg", event.currentTarget.value)} />
            <input value={style.fg} onInput={(event) => update("fg", event.currentTarget.value)} spellcheck={false} />
          </span>
        </label>
        <label>
          Background
          <span class="color-row">
            <input type="color" value={toFullHex(style.bg)} onInput={(event) => update("bg", event.currentTarget.value)} />
            <input value={style.bg} onInput={(event) => update("bg", event.currentTarget.value)} spellcheck={false} />
          </span>
        </label>
        <label>
          Dots
          <select value={style.dots} onChange={(event) => update("dots", event.currentTarget.value as QrStyle["dots"])}>
            {DOT_STYLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Corners
          <select
            value={style.corners}
            onChange={(event) => update("corners", event.currentTarget.value as QrStyle["corners"])}
          >
            {CORNER_STYLES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Error correction
          <select value={style.ecc} onChange={(event) => update("ecc", event.currentTarget.value as QrStyle["ecc"])}>
            {ECC_LEVELS.map((option) => (
              <option key={option} value={option}>
                {option}
                {option === "H" ? " · best with a logo" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quiet zone <span class="muted">{style.quiet} modules</span>
          <input
            type="range"
            min="0"
            max="8"
            value={style.quiet}
            onInput={(event) => update("quiet", Number(event.currentTarget.value))}
          />
        </label>
        <label>
          Centre logo
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(event) => onLogo(event.currentTarget.files?.[0])}
          />
        </label>
        {style.logo ? (
          <button type="button" class="text-btn" onClick={() => setStyle((current) => ({ ...current, logo: undefined }))}>
            Remove logo
          </button>
        ) : null}
        <p class="save-state">{error || status}</p>
      </div>
      <div class="preview-col">
        <div id="qr-preview" class="preview-stage" style={{ background: style.bg }} />
        <p class="short-url">{shortUrl}</p>
        <div class="export-row">
          <button type="button" onClick={() => void exportFile("svg")}>
            SVG
          </button>
          <button type="button" onClick={() => void exportFile("png")}>
            PNG
          </button>
          <button type="button" onClick={() => void exportFile("pdf")}>
            PDF
          </button>
        </div>
        <p class="hint">PNG is 2048 px. PDF is a letter page, ready for a print shop.</p>
      </div>
    </div>
  );
}

function toFullHex(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return "#1b1714";
}
