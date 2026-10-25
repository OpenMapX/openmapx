import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import type { OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import {
  assertAllowedGitUrl,
  services as coreServices,
  type GitShallowCloneOptions,
  gitShallowCloneSnapshot,
} from "@openmapx/core/server";
import { OpsAgentBusyError, type OpsRuntime } from "./runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";
import { readCommunityRepository } from "./trusted-configuration-authority";

/**
 * The operations agent's community service repositories.
 *
 * The agent is the only writer of its community store,
 * `infra/docker/state/ops-agent/community`. Each repository is a
 * checkout of one exact commit in `<repository>/`, where the repository id is
 * the first 16 hex digits of the SHA-256 of its canonical URL, described by
 * `.repository-<repository>.json`. Installing a commit is a transaction: the
 * previous checkout moves to `.backup-<repository>-<transaction>/` and stays
 * there until the API settles the transaction, because only the API knows
 * whether the rest of the extension change committed. A rolled-back
 * transaction keeps its recovery note until the API has restored the service
 * selection it describes and releases it. Dot-prefixed entries are
 * ignored by the authority snapshot, so staging, backups and records never
 * become services.
 */

const REPOSITORY = /^[a-f0-9]{16}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BACKUP = /^\.backup-([a-f0-9]{16})-(txn1_[a-f0-9]{24})$/;
const STAGE = /^\.stage-[a-f0-9]{24}$/;
const MAX_PROBLEMS = 64;
const MAX_PROBLEM_LENGTH = 1_024;
// communityServices.inspect returns every installed manifest in one result of
// at most 1 MiB, so installed manifests must fit with room to spare.
const MAX_LISTED_MANIFEST_BYTES = 768 * 1024;
// Bounds of the inspect and installed-services results.
const MAX_REPOSITORY_SERVICES = 64;
const MAX_COMMUNITY_SERVICES = 256;

const OWNERSHIP_REJECTED = "The repository belongs to another extension";
const PUBLISH_REJECTED = "The repository could not be installed";

const {
  communityRecordFileName,
  communityRecordRepository,
  COMMUNITY_RECORD_VERSION,
  manifestSha256,
  readCommunityRepositoryRecord,
  TrustedAuthorityFilesystem,
} = coreServices;
type RepositorySource = coreServices.CommunityRepositorySource;
type PendingTransaction = coreServices.CommunityRepositoryPending;
type RepositoryRecord = coreServices.CommunityRepositoryRecord;

export type CommunityRepositoryClone = (
  options: Required<Pick<GitShallowCloneOptions, "url" | "ref" | "targetDir">> &
    Pick<GitShallowCloneOptions, "signal">,
) => Promise<{ directory: string; commit: string }>;

export interface CommunityRepositoryStoreOptions {
  rootDir: string;
  /**
   * The store; the agent's own, in its state directory, unless named. Only
   * the startup recovery of an earlier release's store names another.
   */
  directory?: string;
  /** Owner every checkout must have; the authority snapshot rejects anything else. */
  uid: number;
  loadAuthority: () => Promise<TrustedConfigurationAuthoritySnapshot>;
  clone?: CommunityRepositoryClone;
}

export function communityRepositoryId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Remove group and other write access, which the authority snapshot refuses. */
function normalizePermissions(directory: string): void {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = lstatSync(path);
    if (stats.isDirectory()) normalizePermissions(path);
    else if (stats.isFile()) chmodSync(path, stats.mode & 0o755);
    else throw new Error(PUBLISH_REJECTED);
  }
}

function manifestSize(manifest: unknown): number {
  return Buffer.byteLength(JSON.stringify(manifest));
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

export class CommunityRepositoryStore {
  private readonly community: string;
  private readonly clone: CommunityRepositoryClone;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when undoing a failed publish failed; recovery runs before the next operation. */
  private needsRecovery = false;

  constructor(private readonly options: CommunityRepositoryStoreOptions) {
    this.community =
      options.directory ??
      coreServices.agentStatePaths(join(options.rootDir, "infra", "docker")).community;
    this.clone = options.clone ?? gitShallowCloneSnapshot;
  }

  /** Run repository mutations one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      if (this.needsRecovery) {
        this.recoverNow(false);
        this.needsRecovery = false;
      }
      return work();
    };
    const run = this.queue.then(guarded, guarded);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkout(repository: string): string {
    return join(this.community, repository);
  }

  private recordPath(repository: string): string {
    return join(this.community, communityRecordFileName(repository));
  }

  private backupPath(repository: string, transactionId: string): string {
    return join(this.community, `.backup-${repository}-${transactionId}`);
  }

  private ensureCommunity(): void {
    mkdirSync(this.community, { recursive: true, mode: 0o700 });
    chmodSync(this.community, 0o700);
  }

  /** Records are the agent's own files, so they are read strictly. */
  private readRecord(repository: string): RepositoryRecord | null {
    return readCommunityRepositoryRecord(this.community, repository, this.options.uid);
  }

  private writeRecord(record: RepositoryRecord): void {
    const path = this.recordPath(record.repository);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", 0o644);
    try {
      writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(this.community);
  }

  private deleteRecord(repository: string): void {
    rmSync(this.recordPath(repository), { force: true });
    syncDirectory(this.community);
  }

  /** Clone `ref` into a fresh staging directory and read the services it provides. */
  private async stage(
    url: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<{
    directory: string;
    commit: string;
    reading: ReturnType<typeof readCommunityRepository>;
  }> {
    this.ensureCommunity();
    const directory = join(this.community, `.stage-${randomBytes(12).toString("hex")}`);
    try {
      const cloned = await this.clone({ url, ref, targetDir: directory, signal });
      if (cloned.directory !== directory || !COMMIT.test(cloned.commit)) {
        throw new Error(PUBLISH_REJECTED);
      }
      normalizePermissions(directory);
      const filesystem = new TrustedAuthorityFilesystem(this.community, this.options.uid);
      try {
        return {
          directory,
          commit: cloned.commit,
          reading: readCommunityRepository(filesystem, directory),
        };
      } finally {
        filesystem.close();
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Only the extension that installed a repository may change it. The agent
   * never leaves a checkout without an owner record, so one placed by hand is
   * refused rather than adopted by whichever extension names its URL first.
   */
  private assertOwner(
    repository: string,
    record: RepositoryRecord | null,
    extensionId: string,
  ): void {
    if (record ? record.extensionId !== extensionId : existsSync(this.checkout(repository))) {
      throw new Error(OWNERSHIP_REJECTED);
    }
  }

  /**
   * Why installing `staged` as `repository` would conflict with the rest of the
   * deployment: a service id already in use, or more manifest bytes than
   * communityServices.inspect can report.
   */
  private async conflicts(
    repository: string,
    staged: Awaited<ReturnType<CommunityRepositoryStore["stage"]>>,
  ): Promise<string[]> {
    const authority = await this.options.loadAuthority();
    const own = `${this.checkout(repository)}${sep}`;
    const taken = new Set<string>();
    let manifestBytes = 0;
    for (const service of authority.services) {
      if (!service.isBuiltIn && `${service.directory}${sep}`.startsWith(own)) continue;
      taken.add(service.manifest.id);
      if (!service.isBuiltIn) manifestBytes += manifestSize(service.manifest);
    }
    const problems: string[] = [];
    const communityCount =
      authority.services.filter(
        (service) => !service.isBuiltIn && !`${service.directory}${sep}`.startsWith(own),
      ).length + staged.reading.services.length;
    if (staged.reading.services.length > MAX_REPOSITORY_SERVICES) {
      problems.push(`The repository provides more than ${MAX_REPOSITORY_SERVICES} services`);
    } else if (communityCount > MAX_COMMUNITY_SERVICES) {
      problems.push(`More than ${MAX_COMMUNITY_SERVICES} community services would be installed`);
    }
    for (const { service } of staged.reading.services) {
      if (taken.has(service.manifest.id)) {
        problems.push(`Service id "${service.manifest.id}" is already used by another service`);
      }
      manifestBytes += manifestSize(service.manifest);
    }
    if (manifestBytes > MAX_LISTED_MANIFEST_BYTES) {
      problems.push(
        `Installed community service manifests would exceed ${MAX_LISTED_MANIFEST_BYTES} bytes`,
      );
    }
    return problems;
  }

  /**
   * Undo a transaction whose new checkout may or may not be in place. With
   * `keepNote`, the record keeps the transaction as `rolledBack` so the API can
   * still restore the selection it describes.
   */
  private restorePrevious(
    record: RepositoryRecord,
    pending: PendingTransaction,
    keepNote: boolean,
  ): void {
    const checkout = this.checkout(record.repository);
    const backup = this.backupPath(record.repository, pending.transactionId);
    if (existsSync(backup)) {
      rmSync(checkout, { recursive: true, force: true });
      renameSync(backup, checkout);
    } else if (pending.previous === null) {
      rmSync(checkout, { recursive: true, force: true });
    }
    syncDirectory(this.community);
    const previous = pending.previous ?? {
      url: null,
      commit: null,
      extensionId: null,
      manifests: null,
    };
    if (keepNote) {
      this.writeRecord({ ...record, ...previous, pending: { ...pending, phase: "rolledBack" } });
    } else if (pending.previous === null) {
      this.deleteRecord(record.repository);
    } else {
      this.writeRecord({ ...record, ...previous, pending: null });
    }
  }

  /**
   * Startup recovery: drop staging clones, undo transactions interrupted before
   * their checkout was in place, and drop backups no transaction refers to.
   * Published and rolled-back transactions wait for the API to settle them.
   * A prepared transaction needs no note: the API changes nothing else until
   * publish returns.
   */
  async recover(): Promise<void> {
    await this.serialize(async () => this.recoverNow(true));
  }

  /** Staging clones are only dropped at startup, when no inspect can be using one. */
  private recoverNow(startup: boolean): void {
    if (!existsSync(this.community)) return;
    const entries = readdirSync(this.community);
    for (const name of entries) {
      if (startup && STAGE.test(name)) {
        rmSync(join(this.community, name), { recursive: true, force: true });
      }
    }
    const pendingBackups = new Set<string>();
    for (const name of entries) {
      const repository = communityRecordRepository(name);
      if (!repository) continue;
      const record = this.readRecord(repository);
      if (!record?.pending) continue;
      if (record.pending.phase === "prepared") {
        this.restorePrevious(record, record.pending, false);
      } else if (record.pending.phase === "published") {
        pendingBackups.add(this.backupPath(record.repository, record.pending.transactionId));
      }
    }
    for (const name of readdirSync(this.community)) {
      const path = join(this.community, name);
      if (BACKUP.test(name) && !pendingBackups.has(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    syncDirectory(this.community);
  }

  async inspect(
    operation: Extract<OpsOperation, { kind: "serviceRepository.inspect" }>,
    signal: AbortSignal,
  ): Promise<OpsResultFor<"serviceRepository.inspect">> {
    const { canonical } = assertAllowedGitUrl(operation.url);
    const repository = communityRepositoryId(canonical);
    const staged = await this.stage(canonical, operation.ref ?? "HEAD", signal);
    try {
      const problems = [...staged.reading.problems];
      if (staged.reading.services.length === 0 && problems.length === 0) {
        problems.push("The repository contains no service.json");
      }
      problems.push(...(await this.conflicts(repository, staged)));
      // Oversized results are not echoed back: they would exceed the result's
      // own limits and hide the explanation.
      const reportable =
        staged.reading.services.length <= MAX_REPOSITORY_SERVICES &&
        staged.reading.services.reduce(
          (total, { service }) => total + manifestSize(service.manifest),
          0,
        ) <= MAX_LISTED_MANIFEST_BYTES;
      return {
        url: canonical,
        repository,
        commit: staged.commit,
        valid: problems.length === 0,
        problems: boundedProblems(problems),
        services: reportable
          ? staged.reading.services.map(({ service, path }) => ({
              path,
              manifest: service.manifest as unknown as Record<string, unknown>,
            }))
          : [],
      };
    } finally {
      rmSync(staged.directory, { recursive: true, force: true });
    }
  }

  publish(
    operation: Extract<OpsOperation, { kind: "serviceRepository.publish" }>,
    signal: AbortSignal,
  ): Promise<OpsResultFor<"serviceRepository.publish">> {
    return this.serialize(async () => {
      const { canonical } = assertAllowedGitUrl(operation.url);
      if (canonical !== operation.url) throw new Error(PUBLISH_REJECTED);
      const repository = communityRepositoryId(canonical);
      const record = this.readRecord(repository);
      if (record?.pending) throw new OpsAgentBusyError();
      this.assertOwner(repository, record, operation.extensionId);
      const staged = await this.stage(canonical, operation.commit, signal).catch((error) => {
        if (!operation.ref) throw error;
        return this.stage(canonical, operation.ref, signal);
      });
      let current: RepositoryRecord | null = null;
      let pending: PendingTransaction | null = null;
      try {
        if (
          staged.commit !== operation.commit ||
          staged.reading.problems.length > 0 ||
          staged.reading.services.length === 0
        ) {
          throw new Error(PUBLISH_REJECTED);
        }
        if ((await this.conflicts(repository, staged)).length > 0) {
          throw new Error(PUBLISH_REJECTED);
        }
        const checkout = this.checkout(repository);
        const previous: RepositorySource | null =
          record && existsSync(checkout)
            ? {
                url: record.url,
                commit: record.commit,
                extensionId: record.extensionId,
                manifests: record.manifests,
              }
            : null;
        pending = {
          transactionId: `txn1_${randomBytes(12).toString("hex")}`,
          phase: "prepared",
          previous,
          next: {
            url: canonical,
            commit: staged.commit,
            extensionId: operation.extensionId,
            // Readers load exactly these manifests, by digest: the bytes this
            // publish validated.
            manifests: staged.reading.services
              .map(({ path, bytes }) => ({ path, sha256: manifestSha256(bytes) }))
              .sort((left, right) => left.path.localeCompare(right.path)),
          },
          recovery: {
            selectionBefore: operation.recovery.selectionBefore,
            touchedServiceIds: [...operation.recovery.touchedServiceIds],
            previouslyEnabledServiceIds: [...operation.recovery.previouslyEnabledServiceIds],
          },
        };
        current = {
          version: COMMUNITY_RECORD_VERSION,
          repository,
          url: previous?.url ?? null,
          commit: previous?.commit ?? null,
          extensionId: previous?.extensionId ?? null,
          manifests: previous?.manifests ?? null,
          pending,
        };
        this.writeRecord(current);
        if (previous) renameSync(checkout, this.backupPath(repository, pending.transactionId));
        renameSync(staged.directory, checkout);
        syncDirectory(this.community);
        // The new checkout must leave the authority snapshot loadable; otherwise
        // every later operation would be refused.
        await this.options.loadAuthority();
        const published: PendingTransaction = { ...pending, phase: "published" };
        this.writeRecord({ ...current, ...pending.next, pending: published });
        return {
          repository,
          commit: staged.commit,
          transactionId: pending.transactionId,
          serviceIds: staged.reading.services.map(({ service }) => service.manifest.id),
        };
      } catch (error) {
        rmSync(staged.directory, { recursive: true, force: true });
        if (current && pending) {
          try {
            this.restorePrevious(current, pending, false);
          } catch {
            // The checkout may now be one the authority snapshot refuses;
            // recovery retries before the next operation.
            this.needsRecovery = true;
          }
        }
        throw error;
      }
    });
  }

  settle(
    operation: Extract<OpsOperation, { kind: "serviceRepository.settle" }>,
  ): Promise<OpsResultFor<"serviceRepository.settle">> {
    return this.serialize(async () => {
      const { repository, transactionId, outcome } = operation;
      const record = this.readRecord(repository);
      const pending = record?.pending;
      if (!record || pending?.transactionId !== transactionId) {
        return { repository, outcome, changed: false };
      }
      switch (outcome) {
        case "commit":
          if (pending.phase !== "published") throw new Error(PUBLISH_REJECTED);
          rmSync(this.backupPath(repository, transactionId), { recursive: true, force: true });
          syncDirectory(this.community);
          this.writeRecord({ ...record, pending: null });
          return { repository, outcome, changed: true };
        case "rollback":
          if (pending.phase === "rolledBack") return { repository, outcome, changed: false };
          this.restorePrevious(record, pending, true);
          return { repository, outcome, changed: true };
        case "release":
          if (pending.phase !== "rolledBack") throw new Error(PUBLISH_REJECTED);
          if (record.extensionId === null && !existsSync(this.checkout(repository))) {
            this.deleteRecord(repository);
          } else {
            this.writeRecord({ ...record, pending: null });
          }
          return { repository, outcome, changed: true };
      }
    });
  }

  remove(
    operation: Extract<OpsOperation, { kind: "serviceRepository.remove" }>,
  ): Promise<OpsResultFor<"serviceRepository.remove">> {
    return this.serialize(async () => {
      const { repository, extensionId } = operation;
      const record = this.readRecord(repository);
      if (record?.pending) throw new OpsAgentBusyError();
      this.assertOwner(repository, record, extensionId);
      const checkout = this.checkout(repository);
      const existed = existsSync(checkout) || record !== null;
      rmSync(checkout, { recursive: true, force: true });
      if (existsSync(this.community)) syncDirectory(this.community);
      if (record) this.deleteRecord(repository);
      return { repository, removed: existed };
    });
  }

  /** Installed community services and repositories, as the authority snapshot sees them. */
  async list(): Promise<OpsResultFor<"communityServices.inspect">> {
    if (this.needsRecovery) await this.serialize(async () => undefined);
    const authority = await this.options.loadAuthority();
    const services = authority.services
      .filter((service) => !service.isBuiltIn)
      .map((service) => ({
        repository: relative(this.community, service.directory).split(sep)[0] ?? "",
        directory: service.directory,
        manifest: service.manifest as unknown as Record<string, unknown>,
      }));
    const repositories = new Set<string>();
    if (existsSync(this.community)) {
      for (const name of readdirSync(this.community)) {
        if (REPOSITORY.test(name)) repositories.add(name);
        const record = communityRecordRepository(name);
        if (record) repositories.add(record);
      }
    }
    return {
      revisionId: authority.revisionId,
      repositories: [...repositories].sort().map((repository) => {
        const record = this.readRecord(repository);
        const pending =
          record?.pending && record.pending.phase !== "prepared" ? record.pending : null;
        return {
          repository,
          url: record?.url ?? null,
          commit: record?.commit ?? null,
          extensionId: record?.extensionId ?? null,
          pending: pending
            ? {
                transactionId: pending.transactionId,
                phase: pending.phase as "published" | "rolledBack",
                previousCommit: pending.previous?.commit ?? null,
                recovery: pending.recovery,
              }
            : null,
        };
      }),
      services,
    };
  }
}

export function installCommunityRepositoryRuntime(
  runtime: OpsRuntime,
  store: CommunityRepositoryStore,
): void {
  runtime["serviceRepository.inspect"] = (operation, context) =>
    store.inspect(operation, context.signal);
  runtime["serviceRepository.publish"] = (operation, context) =>
    store.publish(operation, context.signal);
  runtime["serviceRepository.settle"] = (operation) => store.settle(operation);
  runtime["serviceRepository.remove"] = (operation) => store.remove(operation);
  runtime["communityServices.inspect"] = () => store.list();
}
