import { stripControlAndInvisible } from "./knowledge-hits.ts";

/**
 * WP-D1 (UA-2): hjelpere for regneark -> CSV-tekst. Rene funksjoner uten nettverk. Regneark-innhold er UBETRODD data: kontrolltegn og usynlige tegn fjernes, hver celle blir én linje, og harde grenser
 * (rader, kolonner, cellelengde) gjelder - et regneark med millioner av celler skal aldri gi ubegrenset minne eller et dokument ingen kan søke i.
 */
export interface CsvResult {
  text: string;
  /** Antall rader i `text` (blanke rader teller ikke). */
  rows: number;
  /** `true` når rader ble kuttet bort av radtaket. */
  truncated: boolean;
}

export const MAX_CELL_CHARS = 2000;

/** 1 -> A, 26 -> Z, 27 -> AA ... (A1-notasjon). */
export function columnLetters(n: number): string {
  let out = "";
  let rest = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1; // (NaN/Infinity -> A: aldri en tom områdenotasjon)
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
}

/** Arknavn i A1-notasjon: omsluttet av enkle sitater, med enkle sitater doblet. */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function cellText(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else return "";
  const cleaned = stripControlAndInvisible(text).replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_CELL_CHARS ? `${cleaned.slice(0, MAX_CELL_CHARS - 1).trimEnd()}…` : cleaned;
}

function csvCell(text: string): string {
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Verdier fra Sheets API (`values`: rader av celler) -> CSV. Maks `maxRows` rader og `maxCols` kolonner; blanke rader hoppes over; avsluttende tomme celler i en rad fjernes.
 * `truncated` er sann når det fantes flere rader enn taket.
 */
export function valuesToCsv(values: unknown, maxRows: number, maxCols: number): CsvResult {
  if (!Array.isArray(values)) return { text: "", rows: 0, truncated: false };
  const lines: string[] = [];
  const truncated = values.length > maxRows;
  for (const row of values.slice(0, maxRows)) {
    if (!Array.isArray(row)) continue;
    const cells = row.slice(0, maxCols).map(cellText);
    while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length === 0) continue;
    lines.push(cells.map(csvCell).join(","));
  }
  return { text: lines.join("\n"), rows: lines.length, truncated };
}

/**
 * Kutter en CSV-tekst (fra Drives eksport) ved `maxRows` rader. Forstår sitater (et linjeskift inni sitater er ikke en radslutt). Kontrolltegn og usynlige tegn fjernes (en NUL-byte kan ikke lagres).
 */
export function capCsvRows(csv: string, maxRows: number): CsvResult {
  const clean = stripControlAndInvisible(csv);
  let rows = 0;
  let inQuotes = false;
  let cut = -1;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "\n") {
      rows += 1;
      if (rows >= maxRows) {
        cut = i + 1;
        break;
      }
    }
  }
  if (cut === -1) {
    const text = clean.replace(/\r?\n$/, "");
    const total = text.length === 0 ? 0 : rows + (clean.endsWith("\n") ? 0 : 1);
    return { text, rows: total, truncated: false };
  }
  const rest = clean.slice(cut);
  return { text: clean.slice(0, cut).replace(/\r?\n$/, ""), rows: maxRows, truncated: rest.trim().length > 0 };
}
