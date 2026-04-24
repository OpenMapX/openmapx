import { createReadStream } from "node:fs";
import { parse as createCsvParser } from "csv-parse";
import { parse as parseCsvSync } from "csv-parse/sync";

export interface CsvRecord {
  [column: string]: string;
}

export interface CsvParseOptions {
  delimiter?: string;
  relaxColumnCount?: boolean;
}

function normalizeRecord(record: Record<string, unknown>): CsvRecord {
  const normalized: CsvRecord = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key] = value == null ? "" : String(value).trim();
  }
  return normalized;
}

function baseOptions(options: CsvParseOptions = {}) {
  return {
    bom: true,
    columns: true as const,
    delimiter: options.delimiter ?? ",",
    relax_column_count: options.relaxColumnCount ?? true,
    skip_empty_lines: true,
    trim: true,
  };
}

/**
 * Parse delimited text into a list of records keyed by the header row.
 * Values are always returned as trimmed strings.
 */
export function parseCsvRecords(content: string, options: CsvParseOptions = {}): CsvRecord[] {
  const parsed = parseCsvSync(content, baseOptions(options)) as Record<string, unknown>[];
  return parsed.map(normalizeRecord);
}

/**
 * Stream delimited records from disk without loading the full file into memory.
 */
export async function* streamCsvRecordsInBatches(
  filePath: string,
  batchSize: number,
  options: CsvParseOptions = {},
): AsyncGenerator<CsvRecord[]> {
  const parser = createCsvParser(baseOptions(options));
  const stream = createReadStream(filePath, { encoding: "utf-8" }).pipe(parser);

  let batch: CsvRecord[] = [];
  for await (const record of stream) {
    batch.push(normalizeRecord(record as Record<string, unknown>));
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) yield batch;
}
