/** Parse a single CSV line handling quoted fields with embedded commas/quotes. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Strip UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse GTFS CSV content into an array of row objects.
 * Keys are the header column names, values are trimmed strings.
 */
export function parseCsv(content: string): Record<string, string>[] {
  const text = stripBom(content);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Streaming CSV reader — yields batches of parsed rows without loading the
 * entire file into memory.  Uses Node's readline on a read stream so only a
 * small buffer is resident at any time.
 */
export async function* streamCsvBatches(
  filePath: string,
  batchSize: number,
): AsyncGenerator<Record<string, string>[]> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let headers: string[] | null = null;
  let batch: Record<string, string>[] = [];
  let isFirst = true;

  for await (const rawLine of rl) {
    const line = isFirst ? stripBom(rawLine) : rawLine;
    isFirst = false;
    if (line.trim().length === 0) continue;

    if (!headers) {
      headers = parseCsvLine(line).map((h) => h.trim());
      continue;
    }

    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    batch.push(row);

    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) yield batch;
}

/** Convert GTFS date "YYYYMMDD" to ISO "YYYY-MM-DD". */
export function gtfsDate(d: string): string {
  if (d.length !== 8) return d;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
