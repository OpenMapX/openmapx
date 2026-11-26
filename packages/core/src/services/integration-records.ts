import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { COMPONENT_ID_PATTERN } from "../component-id";
import { agentStatePaths } from "./agent-state";
import { canonicalExtensionLocator } from "./extension-schema";

/**
 * The operations agent's records of the integrations it installed in its
 * integration store. Each record lists the SHA-256 of every file the agent
 * wrote there; readers trust an installed integration only while its bytes
 * match. The records live in the agent's own state directory, which no other
 * service mounts, so file modes in the store decide nothing.
 */

export const INTEGRATION_RECORD_VERSION = 1;
/** A record holds three file lists while a transaction is pending. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 256;
/** Files one installed integration may hold, above what every archive kind allows together. */
export const MAX_RECORDED_FILES = 1_024;
/** Files all installed integrations together may hold, so one inspection reports them all. */
export const MAX_TOTAL_RECORDED_FILES = 4_096;
/**
 * Bytes the file paths, digests and artifact locators of all installed
 * integrations may take, as JSON, in one inspection result of at most 1 MiB.
 * The remaining fields of 256 integrations, each with a reason of up to 1,024
 * characters, and the list of unrecorded directories take at most about
 * 360 KiB, which leaves the result under its limit.
 */
export const MAX_RECORDED_INVENTORY_BYTES = 640 * 1024;
/** The hash and JSON framing of one inventory entry in the inspection result. */
const INVENTORY_ENTRY_OVERHEAD_BYTES = 96;
const ID = COMPONENT_ID_PATTERN;
const SHA256 = /^[a-f0-9]{64}$/;
const TRANSACTION = /^itx1_[a-f0-9]{24}$/;
const RECORD_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;

export type IntegrationSource =
  | { kind: "artifact"; url: string; sha256: string }
  | { kind: "upload"; sha256: string };

export interface IntegrationFileDigest {
  /** POSIX path relative to the integration's directory. */
  path: string;
  sha256: string;
}

/** What the agent holds for one installed integration. */
export interface IntegrationInstallation {
  /**
   * The extension that installed it, or null for the operator (host CLI).
   * Bookkeeping that keeps installers from replacing each other's
   * integrations; every installer reaches the agent as the same principal.
   */
  extensionId: string | null;
  /** `needs_reinstall` when nothing proves where its files came from. */
  status: "ok" | "needs_reinstall";
  reason: string | null;
  source: IntegrationSource | null;
  /** Every regular file installed, sorted by path. Empty unless `ok`. */
  files: IntegrationFileDigest[];
}

export interface IntegrationPending {
  transactionId: string;
  /**
   * `prepared`: the record was written, the files may or may not have been
   * swapped. `published`: the new files are in place and the previous copy
   * waits for the transaction to settle.
   */
  phase: "prepared" | "published";
  /**
   * Whether a directory was already at the install path when the transaction
   * began. Undoing it then restores that directory and never deletes it.
   */
  replaced: boolean;
  /** What was installed before, or null when nothing was. */
  previous: IntegrationInstallation | null;
  next: IntegrationInstallation;
}

export interface IntegrationRecord extends IntegrationInstallation {
  version: typeof INTEGRATION_RECORD_VERSION;
  integrationId: string;
  pending: IntegrationPending | null;
}

/** The bytes a string takes as JSON text, its quotes and escapes included. */
function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The bytes `files` take in an inspection result: each path as JSON encodes
 * it (a quote or backslash takes two bytes), plus its hash and framing.
 */
export function recordedInventoryBytes(files: readonly IntegrationFileDigest[]): number {
  let bytes = 0;
  for (const file of files) {
    bytes += jsonBytes(file.path) - 2 + INVENTORY_ENTRY_OVERHEAD_BYTES;
  }
  return bytes;
}

/** The bytes an artifact locator takes as JSON in an inspection result; 0 for an upload. */
export function recordedSourceBytes(source: IntegrationSource | null): number {
  return source?.kind === "artifact" ? jsonBytes(source.url) : 0;
}

export function integrationRecordsDirectory(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, "integrations");
}

export function integrationUploadsDirectory(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, "integration-uploads");
}

export function integrationRecordPath(infraDir: string, integrationId: string): string {
  if (!ID.test(integrationId)) throw new Error("Invalid integration id");
  return join(integrationRecordsDirectory(infraDir), `${integrationId}.json`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSource(value: unknown): IntegrationSource | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error();
  if (value.kind === "artifact") {
    let canonical: string;
    try {
      canonical = typeof value.url === "string" ? canonicalExtensionLocator(value.url) : "";
    } catch {
      throw new Error();
    }
    if (
      canonical === "" ||
      typeof value.sha256 !== "string" ||
      !SHA256.test(value.sha256) ||
      Object.keys(value).length !== 3
    ) {
      throw new Error();
    }
    return { kind: "artifact", url: canonical, sha256: value.sha256 };
  }
  if (value.kind === "upload") {
    if (
      typeof value.sha256 !== "string" ||
      !SHA256.test(value.sha256) ||
      Object.keys(value).length !== 2
    ) {
      throw new Error();
    }
    return { kind: "upload", sha256: value.sha256 };
  }
  throw new Error();
}

function parseFiles(value: unknown): IntegrationFileDigest[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDED_FILES) throw new Error();
  const files = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !safeRelativePath(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      Object.keys(entry).length !== 2
    ) {
      throw new Error();
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
  for (const [index, file] of files.entries()) {
    const previous = files[index - 1];
    if (previous && previous.path >= file.path) {
      throw new Error();
    }
  }
  return files;
}

/** A relative POSIX path that stays inside the directory it is relative to. */
function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 1_024 || path.startsWith("/") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseInstallation(value: unknown): IntegrationInstallation {
  if (!isRecord(value)) throw new Error();
  const { extensionId, status, reason, source, files } = value;
  if (extensionId !== null && (typeof extensionId !== "string" || !ID.test(extensionId))) {
    throw new Error();
  }
  if (status !== "ok" && status !== "needs_reinstall") throw new Error();
  if (reason !== null && (typeof reason !== "string" || reason.length > 1_024)) throw new Error();
  const parsed: IntegrationInstallation = {
    extensionId,
    status,
    reason,
    source: parseSource(source),
    files: parseFiles(files),
  };
  if (
    status === "ok" &&
    (parsed.source === null || !parsed.files.some((file) => file.path === "manifest.json"))
  ) {
    throw new Error();
  }
  return parsed;
}

export function parseIntegrationRecord(value: unknown, integrationId: string): IntegrationRecord {
  if (!isRecord(value) || value.version !== INTEGRATION_RECORD_VERSION) throw new Error();
  if (value.integrationId !== integrationId) throw new Error();
  const installation = parseInstallation(value);
  let pending: IntegrationPending | null = null;
  if (value.pending !== null) {
    const raw = value.pending;
    if (
      !isRecord(raw) ||
      typeof raw.transactionId !== "string" ||
      !TRANSACTION.test(raw.transactionId) ||
      (raw.phase !== "prepared" && raw.phase !== "published") ||
      typeof raw.replaced !== "boolean"
    ) {
      throw new Error();
    }
    pending = {
      transactionId: raw.transactionId,
      phase: raw.phase,
      replaced: raw.replaced,
      previous: raw.previous === null ? null : parseInstallation(raw.previous),
      next: parseInstallation(raw.next),
    };
  }
  return { version: INTEGRATION_RECORD_VERSION, integrationId, ...installation, pending };
}

/** The agent's own directory: owned by `uid` and reachable by nobody else. */
function assertOwnDirectory(path: string, uid: number): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new Error("Integration records directory rejected");
  }
}

function readRecordBytes(path: string, uid: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.uid !== uid ||
      stats.nlink !== 1 ||
      (stats.mode & 0o022) !== 0 ||
      stats.size > MAX_RECORD_BYTES
    ) {
      throw new Error();
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface IntegrationRecordsReading {
  records: Map<string, IntegrationRecord>;
  /** Record files that could not be read, by integration id. */
  unreadable: string[];
}

/**
 * Every record in the agent's state directory. A record that cannot be read
 * or parsed is reported as unreadable rather than trusted; the directory
 * itself must be the agent's (owned by `uid`, mode 0700 or stricter), or
 * nothing is read at all.
 */
export function readIntegrationRecords(
  infraDir: string,
  uid: number = process.geteuid?.() ?? 0,
): IntegrationRecordsReading {
  const directory = integrationRecordsDirectory(infraDir);
  const records = new Map<string, IntegrationRecord>();
  const unreadable: string[] = [];
  try {
    lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records, unreadable };
    throw error;
  }
  assertOwnDirectory(directory, uid);
  const files = readdirSync(directory).flatMap((name) => {
    const [, integrationId] = RECORD_FILE.exec(name) ?? [];
    return integrationId === undefined ? [] : [{ name, integrationId }];
  });
  if (files.length > MAX_RECORDS) throw new Error("Too many integration records");
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const { name, integrationId } of files) {
    try {
      const bytes = readRecordBytes(join(directory, name), uid);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      records.set(integrationId, parseIntegrationRecord(parsed, integrationId));
    } catch {
      unreadable.push(integrationId);
    }
  }
  return { records, unreadable };
}

/**
 * The manifest digests a reader may accept for a record: the installed one,
 * and while a transaction is being prepared also the one it installs, since
 * the files may already have been swapped.
 */
export function acceptedManifestDigests(record: IntegrationRecord): Set<string> {
  const digests = new Set<string>();
  const manifestOf = (installation: IntegrationInstallation | null) =>
    installation?.status === "ok"
      ? installation.files.find((file) => file.path === "manifest.json")?.sha256
      : undefined;
  const current = manifestOf(record);
  if (current) digests.add(current);
  if (record.pending?.phase === "prepared") {
    const next = manifestOf(record.pending.next);
    if (next) digests.add(next);
  }
  return digests;
}
