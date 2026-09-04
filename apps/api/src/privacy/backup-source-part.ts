import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
  type DawarichSourceEntryId,
  type DawarichSourceManifestV1,
  dawarichEntryIdForPath,
  dawarichSourceManifestV1Schema,
  isDawarichPortableEntryId,
} from "@openmapx/core/privacy";
import type { CollectorSourcePartEntry } from "./collectors.js";
import { EncryptedSourceSpool } from "./encrypted-source-spool.js";

const BLOCK = 512;
const MAX_ENTRIES = 96;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;

const OPENMAPX_ENTRY_IDS = new Set([
  "account-profile",
  "auth-accounts",
  "auth-sessions",
  "auth-verifications",
  "auth-passkeys",
  "auth-two-factor",
  "auth-oauth-resources",
  "saved-lists",
  "saved-places",
  "labeled-places",
  "personal-vehicles",
  "parked-locations",
  "share-links",
  "timeline-connections",
  "mangrove-keypairs",
  "mobile-auth-handoffs",
  "admin-audit-attribution",
  "admin-jobs-attribution",
  "installed-component-attribution",
  "secret-update-attribution",
  "system-setting-attribution",
  "data-manager-trigger-attribution",
  "offline-package-ownership",
  "privacy-case-records",
  "disclosure-events",
]);

const OPENMAPX_PORTABLE_IDS = new Set([
  "account-profile",
  "saved-lists",
  "saved-places",
  "labeled-places",
  "personal-vehicles",
  "parked-locations",
  "share-links",
  "timeline-connections",
]);

export class BackupSourcePartError extends Error {
  constructor(
    readonly code:
      | "truncated"
      | "invalid_header"
      | "checksum"
      | "unsafe_path"
      | "duplicate"
      | "unsupported_type"
      | "limit_exceeded"
      | "manifest_mismatch"
      | "trailing_data",
  ) {
    super(code);
  }
}

interface OuterDeclaration {
  path: string;
  family: "openmapx" | "dawarich";
  bytes: number;
  sha256: string;
  records: number | null;
  article15: boolean;
  portability: boolean;
  redactionCodes: string[];
}

interface OuterManifest {
  version: 1;
  collectorContract: "openmapx-subject-export-v1";
  cutoff: string;
  subjectUserIdDigest: string;
  entries: OuterDeclaration[];
  warnings: string[];
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  const text = Buffer.from(bytes.subarray(start, start + length))
    .toString("utf8")
    .replace(/\0.*$/u, "")
    .trim();
  if (!text || !/^[0-7]+$/.test(text)) throw new BackupSourcePartError("invalid_header");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new BackupSourcePartError("invalid_header");
  return value;
}

function headerName(header: Uint8Array): string {
  const name = Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0.*$/u, "");
  const prefix = Buffer.from(header.subarray(345, 500)).toString("utf8").replace(/\0.*$/u, "");
  const full = prefix ? `${prefix}/${name}` : name;
  if (
    !full ||
    full.includes("\\") ||
    full.includes("\0") ||
    full.startsWith("/") ||
    full.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new BackupSourcePartError("unsafe_path");
  return full;
}

function verifyChecksum(header: Uint8Array): void {
  const provided = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < header.length; index += 1)
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  if (sum !== provided) throw new BackupSourcePartError("checksum");
}

async function* chunks(input: AsyncIterable<Uint8Array> | Readable) {
  for await (const chunk of input as AsyncIterable<Uint8Array>) {
    if (!(chunk instanceof Uint8Array)) throw new BackupSourcePartError("invalid_header");
    yield Buffer.from(chunk);
  }
}

class TarByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer = Buffer.alloc(0);
  private ended = false;
  private received = 0;

  constructor(
    input: AsyncIterable<Uint8Array> | Readable,
    private readonly rawLimit: number,
  ) {
    this.iterator = chunks(input)[Symbol.asyncIterator]();
  }

  private async fill(minimum: number): Promise<void> {
    while (!this.ended && this.buffer.byteLength < minimum) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      this.received += next.value.byteLength;
      if (this.received > this.rawLimit) throw new BackupSourcePartError("limit_exceeded");
      this.buffer = this.buffer.byteLength
        ? Buffer.concat([this.buffer, next.value])
        : Buffer.from(next.value);
    }
  }

  async readExact(length: number): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0);
    await this.fill(length);
    if (this.buffer.byteLength === 0 && this.ended) return null;
    if (this.buffer.byteLength < length) throw new BackupSourcePartError("truncated");
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  async *readChunks(length: number): AsyncIterable<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      await this.fill(1);
      if (!this.buffer.byteLength) throw new BackupSourcePartError("truncated");
      const size = Math.min(remaining, this.buffer.byteLength);
      const value = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      remaining -= size;
      yield value;
    }
  }

  async drainZeros(): Promise<void> {
    while (this.buffer.byteLength || !this.ended) {
      if (!this.buffer.byteLength) await this.fill(1);
      if (this.buffer.some((value) => value !== 0))
        throw new BackupSourcePartError("trailing_data");
      this.buffer = Buffer.alloc(0);
    }
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function parseOuterManifest(
  content: Buffer,
  expected?: { cutoff?: string; subjectUserIdDigest?: string },
): OuterManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new BackupSourcePartError("manifest_mismatch");
  }
  if (
    !object(raw) ||
    !exactKeys(raw, [
      "collectorContract",
      "cutoff",
      "entries",
      "subjectUserIdDigest",
      "version",
      "warnings",
    ]) ||
    raw.version !== 1 ||
    raw.collectorContract !== "openmapx-subject-export-v1" ||
    typeof raw.cutoff !== "string" ||
    !Number.isFinite(Date.parse(raw.cutoff)) ||
    typeof raw.subjectUserIdDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.subjectUserIdDigest) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > MAX_ENTRIES ||
    !Array.isArray(raw.warnings) ||
    raw.warnings.length > 64 ||
    !raw.warnings.every(safeCode)
  )
    throw new BackupSourcePartError("manifest_mismatch");
  if (
    (expected?.cutoff && raw.cutoff !== expected.cutoff) ||
    (expected?.subjectUserIdDigest && raw.subjectUserIdDigest !== expected.subjectUserIdDigest)
  )
    throw new BackupSourcePartError("manifest_mismatch");
  const seen = new Set<string>();
  const entries = raw.entries.map((value): OuterDeclaration => {
    if (
      !object(value) ||
      !exactKeys(value, [
        "article15",
        "bytes",
        "family",
        "path",
        "portability",
        "records",
        "redactionCodes",
        "sha256",
      ]) ||
      typeof value.path !== "string" ||
      seen.has(value.path) ||
      (value.family !== "openmapx" && value.family !== "dawarich") ||
      !Number.isSafeInteger(value.bytes) ||
      (value.bytes as number) < 0 ||
      (value.bytes as number) > MAX_ENTRY_BYTES ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      (value.records !== null &&
        (!Number.isSafeInteger(value.records) || (value.records as number) < 0)) ||
      typeof value.article15 !== "boolean" ||
      typeof value.portability !== "boolean" ||
      !Array.isArray(value.redactionCodes) ||
      value.redactionCodes.length > 32 ||
      !value.redactionCodes.every(safeCode)
    )
      throw new BackupSourcePartError("manifest_mismatch");
    seen.add(value.path);
    const pathFamily = value.path.startsWith("openmapx/")
      ? "openmapx"
      : value.path.startsWith("dawarich/")
        ? "dawarich"
        : null;
    if (pathFamily !== value.family) throw new BackupSourcePartError("manifest_mismatch");
    return value as unknown as OuterDeclaration;
  });
  return { ...(raw as unknown as Omit<OuterManifest, "entries">), entries };
}

function openmapxId(path: string): string | null {
  const match = /^openmapx\/([a-z0-9][a-z0-9-]{0,63})\.jsonl$/.exec(path);
  return match && OPENMAPX_ENTRY_IDS.has(match[1]) ? match[1] : null;
}

function pathIdentity(path: string): { family: "openmapx" | "dawarich"; id: string } | null {
  const primary = openmapxId(path);
  if (primary) return { family: "openmapx", id: primary };
  const dawarich = dawarichEntryIdForPath(path);
  return dawarich ? { family: "dawarich", id: dawarich } : null;
}

function mediaType(path: string): string {
  if (path.endsWith(".jsonl")) return "application/jsonl";
  if (path.endsWith(".json")) return "application/json";
  if (/\.(?:jpg|jpeg)$/i.test(path)) return "image/jpeg";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.pdf$/i.test(path)) return "application/pdf";
  if (/\.gpx$/i.test(path)) return "application/gpx+xml";
  return "application/octet-stream";
}

function equalCodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function spoolBackupSourceTar(
  input: AsyncIterable<Uint8Array> | Readable,
  options: {
    expected?: { cutoff?: string; subjectUserIdDigest?: string };
    spoolParentDirectory?: string;
    /** Content-derived namespace used when several retained snapshots are included. */
    namespace?: string;
  } = {},
): Promise<{
  entries: CollectorSourcePartEntry[];
  warnings: string[];
  dispose: () => Promise<void>;
}> {
  const spool = await EncryptedSourceSpool.create({
    parentDirectory: options.spoolParentDirectory,
  });
  const reader = new TarByteReader(input, MAX_TOTAL_BYTES + MAX_ENTRIES * BLOCK * 2 + BLOCK * 2);
  const observed = new Map<
    string,
    { bytes: number; sha256: string; stored: CollectorSourcePartEntry; content?: Buffer }
  >();
  let outerContent: Buffer | undefined;
  let total = 0;
  let sawEnd = false;
  try {
    if (options.namespace !== undefined && !/^[a-f0-9]{64}$/.test(options.namespace))
      throw new BackupSourcePartError("manifest_mismatch");
    while (true) {
      const header = await reader.readExact(BLOCK);
      if (!header) break;
      if (header.every((value) => value === 0)) {
        const second = await reader.readExact(BLOCK);
        if (!second?.every((value) => value === 0))
          throw new BackupSourcePartError("trailing_data");
        await reader.drainZeros();
        sawEnd = true;
        break;
      }
      if (outerContent) throw new BackupSourcePartError("manifest_mismatch");
      verifyChecksum(header);
      const path = headerName(header);
      const identity =
        path === "backup/source-manifest.json"
          ? { family: "backup" as const, id: "source-manifest" }
          : pathIdentity(path);
      if (!identity) throw new BackupSourcePartError("unsafe_path");
      if (observed.has(path)) throw new BackupSourcePartError("duplicate");
      const type = header[156];
      if (type !== 0 && type !== 48) throw new BackupSourcePartError("unsupported_type");
      const size = octal(header, 124, 12);
      if (
        size > MAX_ENTRY_BYTES ||
        ((path === "backup/source-manifest.json" || path === "dawarich/source-manifest.json") &&
          size > MAX_MANIFEST_BYTES) ||
        total + size > MAX_TOTAL_BYTES ||
        observed.size >= MAX_ENTRIES
      )
        throw new BackupSourcePartError("limit_exceeded");
      const captured: Buffer[] = [];
      const capture =
        path === "backup/source-manifest.json" || path === "dawarich/source-manifest.json";
      const content = (async function* () {
        for await (const chunk of reader.readChunks(size)) {
          if (capture) captured.push(Buffer.from(chunk));
          yield chunk;
        }
      })();
      const stored = await spool.write({
        logicalId: "pending-backup-source",
        content,
        mediaType: mediaType(path),
        bytes: size,
      });
      if (!stored.sha256) throw new BackupSourcePartError("manifest_mismatch");
      const manifestContent = capture ? Buffer.concat(captured, size) : undefined;
      if (path === "backup/source-manifest.json") outerContent = manifestContent;
      observed.set(path, {
        bytes: size,
        sha256: stored.sha256,
        stored,
        content: manifestContent,
      });
      total += size;
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      const paddingBytes = await reader.readExact(padding);
      if (!paddingBytes || paddingBytes.some((value) => value !== 0))
        throw new BackupSourcePartError("invalid_header");
    }
    if (!sawEnd) throw new BackupSourcePartError("truncated");
    if (!outerContent) throw new BackupSourcePartError("manifest_mismatch");
    const outer = parseOuterManifest(outerContent, options.expected);
    const declarations = new Map(outer.entries.map((entry) => [entry.path, entry]));
    for (const [path, actual] of observed) {
      if (path === "backup/source-manifest.json") continue;
      const declaration = declarations.get(path);
      if (
        !declaration ||
        declaration.bytes !== actual.bytes ||
        declaration.sha256 !== actual.sha256
      )
        throw new BackupSourcePartError("manifest_mismatch");
    }
    for (const declaration of outer.entries) {
      const actual = observed.get(declaration.path);
      if (!actual || actual.bytes !== declaration.bytes || actual.sha256 !== declaration.sha256)
        throw new BackupSourcePartError("manifest_mismatch");
      const identity = pathIdentity(declaration.path);
      if (!identity || identity.family !== declaration.family || !declaration.article15)
        throw new BackupSourcePartError("manifest_mismatch");
      if (
        identity.family === "openmapx" &&
        declaration.portability !== OPENMAPX_PORTABLE_IDS.has(identity.id)
      )
        throw new BackupSourcePartError("manifest_mismatch");
    }

    const dawarichDeclarations = outer.entries.filter((entry) => entry.family === "dawarich");
    let dawarichManifest: DawarichSourceManifestV1 | undefined;
    if (dawarichDeclarations.length) {
      const internal = observed.get("dawarich/source-manifest.json")?.content;
      if (!internal) throw new BackupSourcePartError("manifest_mismatch");
      let raw: unknown;
      try {
        raw = JSON.parse(internal.toString("utf8"));
      } catch {
        throw new BackupSourcePartError("manifest_mismatch");
      }
      const parsed = dawarichSourceManifestV1Schema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.cutoff !== outer.cutoff ||
        parsed.data.subjectUserIdDigest !== outer.subjectUserIdDigest
      )
        throw new BackupSourcePartError("manifest_mismatch");
      dawarichManifest = parsed.data as DawarichSourceManifestV1;
      const inner = new Map(dawarichManifest.entries.map((entry) => [entry.id, entry]));
      for (const declaration of dawarichDeclarations) {
        const id = dawarichEntryIdForPath(declaration.path);
        if (!id) throw new BackupSourcePartError("manifest_mismatch");
        if (id === "source-manifest") continue;
        const expected = inner.get(id);
        if (
          !expected ||
          expected.bytes !== declaration.bytes ||
          expected.sha256 !== declaration.sha256 ||
          expected.records !== declaration.records ||
          expected.article15 !== declaration.article15 ||
          expected.portability !== declaration.portability ||
          !equalCodes(expected.redactionCodes, declaration.redactionCodes)
        )
          throw new BackupSourcePartError("manifest_mismatch");
      }
      for (const entry of dawarichManifest.entries) {
        const found = dawarichDeclarations.some(
          (declaration) => dawarichEntryIdForPath(declaration.path) === entry.id,
        );
        if (!found) throw new BackupSourcePartError("manifest_mismatch");
      }
    }

    const entries: CollectorSourcePartEntry[] = [];
    for (const [path, actual] of observed) {
      if (path === "backup/source-manifest.json") continue;
      const declaration = declarations.get(path);
      if (!declaration) throw new BackupSourcePartError("manifest_mismatch");
      const identity = pathIdentity(path);
      if (!identity) throw new BackupSourcePartError("manifest_mismatch");
      const rootPrefix = options.namespace ? `backup-${options.namespace}` : "backup";
      const prefix =
        identity.family === "openmapx" ? `${rootPrefix}-openmapx` : `${rootPrefix}-dawarich`;
      const entrySchemaId =
        identity.id === "source-manifest"
          ? "backup-source-v1"
          : actual.stored.mediaType === "application/json" ||
              actual.stored.mediaType === "application/jsonl"
            ? "backup-history-record-v1"
            : undefined;
      entries.push({
        ...actual.stored,
        logicalId: `${prefix}-${identity.id}`,
        recordCount: declaration.records ?? undefined,
        schemaId: entrySchemaId,
      });
      const portable =
        identity.family === "openmapx"
          ? declaration.portability
          : identity.id !== "source-manifest" &&
            Boolean(dawarichManifest) &&
            isDawarichPortableEntryId(identity.id as DawarichSourceEntryId) &&
            declaration.portability;
      if (portable)
        entries.push({
          ...actual.stored,
          logicalId: `${prefix}-portable-${identity.id}`,
          recordCount: declaration.records ?? undefined,
          schemaId: entrySchemaId,
        });
    }
    const outerStored = observed.get("backup/source-manifest.json");
    if (!outerStored) throw new BackupSourcePartError("manifest_mismatch");
    entries.push({
      ...outerStored.stored,
      logicalId: options.namespace
        ? `backup-${options.namespace}-source-manifest`
        : "backup-source-manifest",
      schemaId: "backup-source-v1",
    });
    return { entries, warnings: outer.warnings, dispose: () => spool.dispose() };
  } catch (error) {
    await spool.dispose();
    throw error;
  } finally {
    await reader.close();
  }
}

export function isBackupOpenmapxEntryId(value: string): boolean {
  return OPENMAPX_ENTRY_IDS.has(value);
}
