import { createHash } from "node:crypto";

export interface SubjectExportRecord {
  id: string;
  data: Record<string, unknown>;
  portable: boolean;
  policyCodes?: string[];
}

export interface CollectorSourcePartEntry {
  logicalId: string;
  source: Buffer | Uint8Array | AsyncIterable<Uint8Array>;
  mediaType: string;
  /** Known while streaming; required for a source-manifest-backed entry. */
  bytes?: number;
  sha256?: string;
  recordCount?: number;
  schemaId?: string;
}

export interface CollectorSourcePart {
  registrationId: string;
  category: string;
  records: SubjectExportRecord[];
  /** Authoritative count when records were encoded directly into entries. */
  recordCount?: number;
  outcome:
    | "included"
    | "not_applicable"
    | "unavailable"
    | "reviewed_no_match"
    | "omitted_with_reason";
  warningCodes: string[];
  capturedAt: string;
  /** Optional fixed archive members supplied by a managed-source collector. */
  entries?: CollectorSourcePartEntry[];
  /** Removes encrypted transient source material after assembly or failure. */
  disposeSources?: () => void | Promise<void>;
}

export function stableRecordId(category: string, value: unknown): string {
  return createHash("sha256")
    .update("openmapx/privacy/record/v1\0")
    .update(category)
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function safeRecord(
  value: Record<string, unknown>,
  options: { maxBytes?: number } = {},
): Record<string, unknown> {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes)
    throw new Error("privacy projection exceeds bound");
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function jsonl(
  records: readonly Record<string, unknown>[],
  options: { maxRecords?: number; maxBytes?: number } = {},
): string {
  const maxRecords = options.maxRecords ?? 10_000_000;
  if (records.length > maxRecords) throw new Error("privacy projection has too many records");
  const sorted = [...records].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  let total = 0;
  let result = "";
  for (const record of sorted) {
    const line = `${JSON.stringify(safeRecord(record))}\n`;
    total += Buffer.byteLength(line);
    if (total > (options.maxBytes ?? 512 * 1024 * 1024))
      throw new Error("privacy JSONL exceeds bound");
    result += line;
  }
  return result;
}

export function projectSubjectRecord(
  category: string,
  data: Record<string, unknown>,
  portable: boolean,
  policyCodes: string[] = [],
): SubjectExportRecord {
  const safe = safeRecord(data);
  return {
    id: stableRecordId(category, safe),
    data: safe,
    portable,
    policyCodes: [...new Set(policyCodes)].sort(),
  };
}

export function includedPart(
  registrationId: string,
  category: string,
  records: SubjectExportRecord[],
  warningCodes: string[] = [],
): CollectorSourcePart {
  return {
    registrationId,
    category,
    records,
    outcome: records.length ? "included" : "reviewed_no_match",
    warningCodes,
    capturedAt: new Date().toISOString(),
  };
}
