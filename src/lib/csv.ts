export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

/** Guard cells that spreadsheets would treat as formulas. */
export function csvCell(value: string): string {
  let safe = value;
  if (/^[=+\-@]/.test(safe)) safe = `'${safe}`;
  if (/[",\n\r]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}

/** Undo the spreadsheet guard added by csvCell. */
export function unescapeImported(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && /^'[=+\-@]/.test(trimmed)) return trimmed.slice(1);
  return trimmed;
}
