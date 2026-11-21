/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields with embedded commas,
 * quotes (doubled inside quotes), and CR/LF line endings. Tailored for the
 * OurAirports dumps — UTF-8, header row, no embedded multi-line quoted values
 * in the airports/runways/frequencies/navaids feeds.
 *
 * Returns records as plain objects keyed by header. Empty fields become "".
 */
export interface CsvRecord {
  [column: string]: string;
}

export function parseCsv(text: string): CsvRecord[] {
  const [headers, ...rows] = splitRows(text);
  if (!headers) return [];
  const records: CsvRecord[] = [];
  for (const row of rows) {
    if (row.length === 1 && row[0] === "") continue;
    const rec: CsvRecord = {};
    for (const [j, header] of headers.entries()) {
      rec[header] = row[j] ?? "";
    }
    records.push(rec);
  }
  return records;
}

function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i);
    if (inQuotes) {
      if (ch === 34 /* " */) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 34) {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += text[i];
      }
      continue;
    }
    if (ch === 34) {
      inQuotes = true;
      continue;
    }
    if (ch === 44 /* , */) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === 13 /* \r */) continue;
    if (ch === 10 /* \n */) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += text[i];
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function parseOptionalFloat(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}
