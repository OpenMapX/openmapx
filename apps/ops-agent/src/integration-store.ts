import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import { services as coreServices, safeDownload } from "@openmapx/core/server";
import {
  extractIntegrationArchive,
  validateStagedIntegration,
} from "@openmapx/integration-framework/installer";
import { OpsAgentBusyError, type OpsRuntime } from "./runtime";

/**
 * The operations agent's installed integrations.
 *
 * The agent is the only writer of `custom_integrations/`. It fetches each
 * integration archive itself, checks its SHA-256, validates and installs it as
 * `custom_integrations/<id>`, and records the SHA-256 of every file it wrote
 * in `infra/docker/state/ops-agent/integrations/<id>.json`. Readers trust an
 * installed integration only while its bytes match that record, so file
 * owners and modes in `custom_integrations/` decide nothing.
 *
 * Installing is a transaction: the previous copy moves to
 * `.agent-backup-<id>-<transaction>` until the API settles it, because only
 * the API knows whether the rest of the extension change committed.
 * Integrations installed before the agent kept records are adopted only when
 * their files match their original artifact fetched again; anything else is
 * recorded as needing a reinstall.
 */

const INTEGRATION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STAGE = /^\.agent-stage-[a-f0-9]{24}$/;
const BACKUP = /^\.agent-backup-([a-z0-9][a-z0-9-]{0,63})-(itx1_[a-f0-9]{24})$/;
const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_PROBLEMS = 64;
const MAX_PROBLEM_LENGTH = 1_024;

const PUBLISH_REJECTED = "The integration could not be installed";
const OWNERSHIP_REJECTED = "The integration belongs to another owner";

const {
  acceptedManifestDigests,
  INTEGRATION_RECORD_VERSION,
  integrationRecordsDirectory,
  integrationUploadsDirectory,
  MAX_RECORDED_FILES,
  MAX_TOTAL_RECORDED_FILES,
  readIntegrationRecords,
  sha256Hex,
} = coreServices;
type IntegrationRecord = coreServices.IntegrationRecord;
type IntegrationInstallation = coreServices.IntegrationInstallation;
type IntegrationPending = coreServices.IntegrationPending;
type IntegrationSource = coreServices.IntegrationSource;
type IntegrationFileDigest = coreServices.IntegrationFileDigest;

/** Fetch `url` into `destination`; the default refuses private addresses. */
export type IntegrationArtifactDownload = (options: {
  url: URL;
  destination: string;
  maxBytes: number;
  signal: AbortSignal;
}) => Promise<void>;

const defaultDownload: IntegrationArtifactDownload = async ({
  url,
  destination,
  maxBytes,
  signal,
}) => {
  await safeDownload({
    url,
    destination,
    maxBytes,
    timeoutMs: 5 * 60_000,
    allowedContentTypes: [],
    credentialPolicy: "none",
    headers: { "User-Agent": "Open-MapX-operations-agent" },
    signal,
  });
};

export interface IntegrationStoreOptions {
  rootDir: string;
  /** Owner of the agent's records. */
  uid: number;
  /** Ids an installed integration may not take: the release's built-in integrations. */
  builtInIds: () => ReadonlySet<string>;
  download?: IntegrationArtifactDownload;
}

/** The archive could not be fetched; adopting may be retried later. */
class ArtifactUnavailableError extends Error {}

interface Staged {
  /** The staging directory holding everything below. */
  work: string;
  /** The integration's validated tree, ready to be renamed into place. */
  tree: string;
  integrationId: string;
  manifest: Record<string, unknown>;
  files: IntegrationFileDigest[];
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function boundedProblems(problems: string[]): string[] {
  return problems
    .slice(0, MAX_PROBLEMS)
    .map((problem) =>
      problem.length > MAX_PROBLEM_LENGTH
        ? `${problem.slice(0, MAX_PROBLEM_LENGTH - 1)}…`
        : problem,
    );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The SHA-256 of every regular file under `directory`, sorted by path, or null
 * when it holds anything else (a link, a device) or more files than a record
 * may list. Nothing is followed.
 */
function digestTree(directory: string): IntegrationFileDigest[] | null {
  const files: IntegrationFileDigest[] = [];
  const walk = (path: string, prefix: string): boolean => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(child);
      if (stats.isDirectory()) {
        if (!walk(child, relativePath)) return false;
      } else if (stats.isFile() && stats.nlink === 1) {
        if (files.length >= MAX_RECORDED_FILES) return false;
        files.push({ path: relativePath, sha256: sha256File(child) });
      } else {
        return false;
      }
    }
    return true;
  };
  try {
    if (!lstatSync(directory).isDirectory()) return null;
    if (!walk(directory, "")) return null;
  } catch {
    return null;
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

function sameFiles(left: IntegrationFileDigest[], right: IntegrationFileDigest[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.sha256 === right[index]?.sha256,
    )
  );
}

function installation(record: IntegrationRecord): IntegrationInstallation {
  return {
    extensionId: record.extensionId,
    status: record.status,
    reason: record.reason,
    source: record.source,
    files: record.files,
  };
}

function manifestDigest(files: IntegrationFileDigest[]): string {
  const manifest = files.find((file) => file.path === "manifest.json");
  if (!manifest) throw new Error(PUBLISH_REJECTED);
  return manifest.sha256;
}

function canonicalSource(source: IntegrationSource): IntegrationSource {
  return source.kind === "artifact"
    ? { ...source, url: coreServices.canonicalExtensionLocator(source.url) }
    : source;
}

export class IntegrationStore {
  private readonly custom: string;
  private readonly infraDir: string;
  private readonly download: IntegrationArtifactDownload;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: IntegrationStoreOptions) {
    this.custom = join(options.rootDir, "custom_integrations");
    this.infraDir = join(options.rootDir, "infra", "docker");
    this.download = options.download ?? defaultDownload;
  }

  /** Run changes one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private target(integrationId: string): string {
    if (!INTEGRATION_ID.test(integrationId)) throw new Error(PUBLISH_REJECTED);
    return join(this.custom, integrationId);
  }

  private backupPath(integrationId: string, transactionId: string): string {
    return join(this.custom, `.agent-backup-${integrationId}-${transactionId}`);
  }

  private ensureDirectories(): void {
    mkdirSync(this.custom, { recursive: true, mode: 0o755 });
    mkdirSync(integrationRecordsDirectory(this.infraDir), { recursive: true, mode: 0o700 });
  }

  private reading() {
    return readIntegrationRecords(this.infraDir, this.options.uid);
  }

  /** The record of `integrationId`; one the agent cannot read is never overwritten. */
  private readRecord(integrationId: string): IntegrationRecord | null {
    const { records, unreadable } = this.reading();
    if (unreadable.includes(integrationId)) throw new Error(PUBLISH_REJECTED);
    return records.get(integrationId) ?? null;
  }

  private writeRecord(record: IntegrationRecord): void {
    const directory = integrationRecordsDirectory(this.infraDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = coreServices.integrationRecordPath(this.infraDir, record.integrationId);
    const temporary = join(
      directory,
      `.${record.integrationId}.json.${randomBytes(8).toString("hex")}.tmp`,
    );
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(directory);
  }

  private deleteRecord(integrationId: string): void {
    rmSync(coreServices.integrationRecordPath(this.infraDir, integrationId), { force: true });
    syncDirectory(integrationRecordsDirectory(this.infraDir));
  }

  /** Copy an archive the operator staged in the agent's state directory. */
  private copyUpload(sha256: string, destination: string): void {
    const path = join(integrationUploadsDirectory(this.infraDir), `${sha256}.tar.gz`);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new Error("No uploaded integration archive has that SHA-256");
    }
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile() || stats.size > MAX_ARTIFACT_BYTES) {
        throw new Error(
          "The uploaded integration archive is not a regular file of at most 200 MiB",
        );
      }
      writeFileSync(destination, readFileSync(fd), { mode: 0o600, flag: "wx" });
    } finally {
      closeSync(fd);
    }
  }

  /** Fetch, verify, extract and validate `source` in a fresh staging directory. */
  private async stage(source: IntegrationSource, signal: AbortSignal): Promise<Staged> {
    const normalizedSource = canonicalSource(source);
    this.ensureDirectories();
    const work = join(this.custom, `.agent-stage-${randomBytes(12).toString("hex")}`);
    mkdirSync(work, { mode: 0o755 });
    try {
      const archive = join(work, "archive.tar.gz");
      if (normalizedSource.kind === "artifact") {
        try {
          await this.download({
            url: new URL(normalizedSource.url),
            destination: archive,
            maxBytes: MAX_ARTIFACT_BYTES,
            signal,
          });
        } catch {
          throw new ArtifactUnavailableError("The archive could not be downloaded");
        }
      } else {
        this.copyUpload(normalizedSource.sha256, archive);
      }
      if (sha256File(archive) !== normalizedSource.sha256) {
        throw new Error("The archive does not have the expected SHA-256");
      }
      const tree = extractIntegrationArchive(
        archive,
        join(work, "extracted"),
        join(work, "unwrapped"),
        MAX_ARTIFACT_BYTES,
      );
      rmSync(archive, { force: true });
      const { id, manifest } = validateStagedIntegration(tree, {
        builtInIds: this.options.builtInIds(),
        artifact: true,
        allowLinks: false,
      });
      const files = digestTree(tree);
      if (!files) {
        throw new Error(`An integration may hold at most ${MAX_RECORDED_FILES} regular files`);
      }
      return { work, tree, integrationId: id, manifest, files };
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Only the owner that installed an integration may change it: the extension
   * named in its record, or the operator for one installed without an
   * extension. A directory the agent holds no record of is never taken over by
   * an extension; the operator, who installed it by hand, may replace it.
   *
   * This is bookkeeping, not a security boundary. It keeps one extension, or a
   * manual install, from replacing another's integration by accident. app-api
   * and the fixed CLI reach the agent as the same `api` principal, so app-api
   * can act as the operator by leaving out `extensionId`; it is the admin and
   * may install any artifact anyway. What the agent enforces is that every
   * installed file is one it verified and recorded.
   */
  private assertOwner(
    integrationId: string,
    record: IntegrationRecord | null,
    extensionId: string | null,
  ): void {
    if (
      record
        ? record.extensionId !== extensionId
        : extensionId !== null && existsSync(this.target(integrationId))
    ) {
      throw new Error(OWNERSHIP_REJECTED);
    }
  }

  /** Why installing `staged` would exceed what one inspection can report. */
  private conflicts(integrationId: string, staged: Staged): string[] {
    const { records } = this.reading();
    let files = staged.files.length;
    for (const [id, record] of records) if (id !== integrationId) files += record.files.length;
    const problems: string[] = [];
    if (files > MAX_TOTAL_RECORDED_FILES) {
      problems.push(
        `Installed integrations would hold more than ${MAX_TOTAL_RECORDED_FILES} files`,
      );
    }
    if (records.size >= 256 && !records.has(integrationId)) {
      problems.push("At most 256 integrations can be installed");
    }
    return problems;
  }

  /** Undo a transaction whose new files may or may not be in place. */
  private restorePrevious(record: IntegrationRecord, pending: IntegrationPending): void {
    const target = this.target(record.integrationId);
    const backup = this.backupPath(record.integrationId, pending.transactionId);
    if (existsSync(backup)) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);
    } else if (!pending.replaced) {
      rmSync(target, { recursive: true, force: true });
    }
    syncDirectory(this.custom);
    if (pending.previous === null) {
      this.deleteRecord(record.integrationId);
    } else {
      this.writeRecord({
        version: INTEGRATION_RECORD_VERSION,
        integrationId: record.integrationId,
        ...pending.previous,
        pending: null,
      });
    }
  }

  /**
   * Startup recovery: drop staging directories, undo transactions interrupted
   * before their files were in place, and drop backups no transaction refers
   * to. Published transactions wait for the API to settle them.
   */
  async recover(): Promise<void> {
    await this.serialize(async () => {
      if (!existsSync(this.custom)) return;
      for (const name of readdirSync(this.custom)) {
        if (STAGE.test(name)) rmSync(join(this.custom, name), { recursive: true, force: true });
      }
      const pendingBackups = new Set<string>();
      for (const record of this.reading().records.values()) {
        if (record.pending?.phase === "prepared") {
          this.restorePrevious(record, record.pending);
        } else if (record.pending?.phase === "published") {
          pendingBackups.add(this.backupPath(record.integrationId, record.pending.transactionId));
        }
      }
      for (const name of readdirSync(this.custom)) {
        const path = join(this.custom, name);
        if (BACKUP.test(name) && !pendingBackups.has(path)) {
          rmSync(path, { recursive: true, force: true });
        }
      }
      syncDirectory(this.custom);
    });
  }

  async inspect(
    operation: Extract<OpsOperation, { kind: "integration.inspect" }>,
    signal: AbortSignal,
  ): Promise<OpsResultFor<"integration.inspect">> {
    let staged: Staged;
    try {
      staged = await this.stage(operation.source, signal);
    } catch (error) {
      return {
        integrationId: null,
        valid: false,
        problems: boundedProblems([(error as Error).message]),
        manifest: null,
      };
    }
    try {
      const problems = this.conflicts(staged.integrationId, staged);
      return {
        integrationId: staged.integrationId,
        valid: problems.length === 0,
        problems: boundedProblems(problems),
        manifest: staged.manifest,
      };
    } finally {
      rmSync(staged.work, { recursive: true, force: true });
    }
  }

  publish(
    operation: Extract<OpsOperation, { kind: "integration.publish" }>,
    signal: AbortSignal,
  ): Promise<OpsResultFor<"integration.publish">> {
    return this.serialize(async () => {
      const { integrationId } = operation;
      const source = canonicalSource(operation.source);
      const extensionId = operation.extensionId ?? null;
      const target = this.target(integrationId);
      const record = this.readRecord(integrationId);
      if (record?.pending) throw new OpsAgentBusyError();
      this.assertOwner(integrationId, record, extensionId);
      const staged = await this.stage(source, signal);
      let prepared: IntegrationRecord | null = null;
      try {
        if (staged.integrationId !== integrationId) {
          throw new Error(
            `The archive installs integration "${staged.integrationId}", not "${integrationId}"`,
          );
        }
        if (this.conflicts(integrationId, staged).length > 0) throw new Error(PUBLISH_REJECTED);
        const next: IntegrationInstallation = {
          extensionId,
          status: "ok",
          reason: null,
          source,
          files: staged.files,
        };
        const pending: IntegrationPending = {
          transactionId: `itx1_${randomBytes(12).toString("hex")}`,
          phase: "prepared",
          replaced: existsSync(target),
          previous: record ? installation(record) : null,
          next,
        };
        prepared = {
          version: INTEGRATION_RECORD_VERSION,
          integrationId,
          ...(record
            ? installation(record)
            : {
                extensionId,
                status: "needs_reinstall" as const,
                reason: "It is being installed.",
                source: null,
                files: [],
              }),
          pending,
        };
        this.writeRecord(prepared);
        if (pending.replaced) {
          renameSync(target, this.backupPath(integrationId, pending.transactionId));
        }
        renameSync(staged.tree, target);
        syncDirectory(this.custom);
        this.writeRecord({
          version: INTEGRATION_RECORD_VERSION,
          integrationId,
          ...next,
          pending: { ...pending, phase: "published" },
        });
        return {
          integrationId,
          transactionId: pending.transactionId,
          manifestSha256: manifestDigest(staged.files),
        };
      } catch (error) {
        if (prepared?.pending) this.restorePrevious(prepared, prepared.pending);
        throw error;
      } finally {
        rmSync(staged.work, { recursive: true, force: true });
      }
    });
  }

  settle(
    operation: Extract<OpsOperation, { kind: "integration.settle" }>,
  ): Promise<OpsResultFor<"integration.settle">> {
    return this.serialize(async () => {
      const { integrationId, transactionId, outcome } = operation;
      const record = this.readRecord(integrationId);
      const pending = record?.pending;
      if (!record || pending?.transactionId !== transactionId) {
        return { integrationId, outcome, changed: false };
      }
      if (outcome === "commit") {
        if (pending.phase !== "published") throw new Error(PUBLISH_REJECTED);
        rmSync(this.backupPath(integrationId, transactionId), { recursive: true, force: true });
        syncDirectory(this.custom);
        this.writeRecord({ ...record, pending: null });
      } else {
        this.restorePrevious(record, pending);
      }
      return { integrationId, outcome, changed: true };
    });
  }

  remove(
    operation: Extract<OpsOperation, { kind: "integration.remove" }>,
  ): Promise<OpsResultFor<"integration.remove">> {
    return this.serialize(async () => {
      const { integrationId } = operation;
      const extensionId = operation.extensionId ?? null;
      const target = this.target(integrationId);
      const record = this.readRecord(integrationId);
      if (record?.pending) throw new OpsAgentBusyError();
      this.assertOwner(integrationId, record, extensionId);
      const existed = existsSync(target) || record !== null;
      rmSync(target, { recursive: true, force: true });
      if (existsSync(this.custom)) syncDirectory(this.custom);
      if (record) this.deleteRecord(integrationId);
      return { integrationId, removed: existed };
    });
  }

  /**
   * Record an integration an earlier release installed. Its files on disk are
   * never recorded as they are: only when they are exactly the files of its
   * original artifact, fetched and verified again, is it recorded. Otherwise it
   * is recorded as needing a reinstall, except when the artifact could not be
   * fetched, which a later attempt may retry.
   */
  adopt(
    operation: Extract<OpsOperation, { kind: "integration.adopt" }>,
    signal: AbortSignal,
  ): Promise<OpsResultFor<"integration.adopt">> {
    return this.serialize(async () => {
      const { integrationId } = operation;
      const source = operation.source ? canonicalSource(operation.source) : undefined;
      const extensionId = operation.extensionId ?? null;
      const target = this.target(integrationId);
      const existing = this.readRecord(integrationId);
      if (existing) {
        return {
          integrationId,
          status: existing.status === "ok" ? "recorded" : "needs_reinstall",
          reason: existing.reason,
        };
      }
      const needsReinstall = (reason: string) => {
        this.ensureDirectories();
        this.writeRecord({
          version: INTEGRATION_RECORD_VERSION,
          integrationId,
          extensionId,
          status: "needs_reinstall",
          reason,
          source: null,
          files: [],
          pending: null,
        });
        return { integrationId, status: "needs_reinstall" as const, reason };
      };
      if (!existsSync(target)) return needsReinstall("It is not installed.");
      if (!source) {
        return needsReinstall("Nothing records the archive it was installed from.");
      }
      let staged: Staged;
      try {
        staged = await this.stage(source, signal);
      } catch (error) {
        if (error instanceof ArtifactUnavailableError) {
          return { integrationId, status: "needs_reinstall", reason: error.message };
        }
        return needsReinstall(
          `Its archive no longer installs: ${(error as Error).message}`.slice(
            0,
            MAX_PROBLEM_LENGTH,
          ),
        );
      }
      try {
        const installed = digestTree(target);
        if (
          staged.integrationId !== integrationId ||
          !installed ||
          !sameFiles(installed, staged.files)
        ) {
          return needsReinstall("Its files differ from the archive it was installed from.");
        }
        this.writeRecord({
          version: INTEGRATION_RECORD_VERSION,
          integrationId,
          extensionId,
          status: "ok",
          reason: null,
          source,
          files: staged.files,
          pending: null,
        });
        return { integrationId, status: "recorded", reason: null };
      } finally {
        rmSync(staged.work, { recursive: true, force: true });
      }
    });
  }

  /** Every record, with its manifest checked now, and the directories without one. */
  async list(): Promise<OpsResultFor<"installedIntegrations.inspect">> {
    const { records, unreadable } = this.reading();
    const integrations = [...records.values()].map((record) => {
      let status: "ok" | "needs_reinstall" = record.status;
      let reason = record.reason;
      if (status === "ok") {
        const accepted = acceptedManifestDigests(record);
        let actual: string | null = null;
        try {
          const fd = openSync(
            join(this.target(record.integrationId), "manifest.json"),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (fstatSync(fd).isFile()) actual = sha256Hex(readFileSync(fd));
          } finally {
            closeSync(fd);
          }
        } catch {
          actual = null;
        }
        if (!actual || !accepted.has(actual)) {
          status = "needs_reinstall";
          reason = "Its manifest.json no longer matches what the operations agent installed.";
        }
      }
      return {
        integrationId: record.integrationId,
        extensionId: record.extensionId,
        status,
        reason,
        source: record.source,
        files: record.files,
        pending:
          record.pending?.phase === "published"
            ? { transactionId: record.pending.transactionId }
            : null,
      };
    });
    const unrecorded: string[] = [];
    if (existsSync(this.custom)) {
      for (const entry of readdirSync(this.custom, { withFileTypes: true })) {
        if (!entry.isDirectory() || !INTEGRATION_ID.test(entry.name)) continue;
        if (!records.has(entry.name)) unrecorded.push(entry.name);
      }
    }
    for (const id of unreadable) if (!unrecorded.includes(id)) unrecorded.push(id);
    return { integrations, unrecorded: unrecorded.sort().slice(0, 256) };
  }
}

export function installIntegrationRuntime(runtime: OpsRuntime, store: IntegrationStore): void {
  runtime["integration.inspect"] = (operation, context) => store.inspect(operation, context.signal);
  runtime["integration.publish"] = (operation, context) => store.publish(operation, context.signal);
  runtime["integration.settle"] = (operation) => store.settle(operation);
  runtime["integration.remove"] = (operation) => store.remove(operation);
  runtime["integration.adopt"] = (operation, context) => store.adopt(operation, context.signal);
  runtime["installedIntegrations.inspect"] = () => store.list();
}
