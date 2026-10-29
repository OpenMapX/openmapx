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
import {
  SOURCE_TAR_LIMITS,
  type SourceTarErrorCode,
  SourceTarReader,
} from "./source-tar-reader.js";

const MAX_ENTRIES = SOURCE_TAR_LIMITS.maxEntries;
const MAX_ENTRY_BYTES = SOURCE_TAR_LIMITS.maxEntryBytes;
const MAX_MANIFEST_BYTES = SOURCE_TAR_LIMITS.maxManifestBytes;

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
  constructor(readonly code: SourceTarErrorCode | "manifest_mismatch") {
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
  let spool: EncryptedSourceSpool | undefined;
  const reader = new SourceTarReader(
    input,
    SOURCE_TAR_LIMITS,
    (code) => new BackupSourcePartError(code),
  );
  const observed = new Map<
    string,
    { bytes: number; sha256: string; stored: CollectorSourcePartEntry; content?: Buffer }
  >();
  let outerContent: Buffer | undefined;
  try {
    if (options.namespace !== undefined && !/^[a-f0-9]{64}$/.test(options.namespace))
      throw new BackupSourcePartError("manifest_mismatch");
    await reader.read(async ({ path, bytes: size, content: body }) => {
      if (outerContent) throw new BackupSourcePartError("manifest_mismatch");
      const identity =
        path === "backup/source-manifest.json"
          ? { family: "backup" as const, id: "source-manifest" }
          : pathIdentity(path);
      if (!identity) throw new BackupSourcePartError("unsafe_path");
      if (observed.has(path)) throw new BackupSourcePartError("duplicate");
      if (
        (path === "backup/source-manifest.json" || path === "dawarich/source-manifest.json") &&
        size > MAX_MANIFEST_BYTES
      )
        throw new BackupSourcePartError("limit_exceeded");
      const captured: Buffer[] = [];
      const capture =
        path === "backup/source-manifest.json" || path === "dawarich/source-manifest.json";
      const content = (async function* () {
        for await (const chunk of body) {
          if (capture) captured.push(Buffer.from(chunk));
          yield chunk;
        }
      })();
      spool ??= await EncryptedSourceSpool.create({
        parentDirectory: options.spoolParentDirectory,
      });
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
    });
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
    if (!spool) throw new BackupSourcePartError("manifest_mismatch");
    const completedSpool = spool;
    return { entries, warnings: outer.warnings, dispose: () => completedSpool.dispose() };
  } catch (error) {
    await spool?.dispose();
    await reader.close().catch(() => {});
    throw error;
  }
}

export function isBackupOpenmapxEntryId(value: string): boolean {
  return OPENMAPX_ENTRY_IDS.has(value);
}
