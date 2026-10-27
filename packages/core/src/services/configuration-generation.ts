import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { configurationProjectionFingerprint, type OpsResultFor } from "../ops";
import type { ConfigurationApplyResult } from "../ops/contract";
import {
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "../ops/trusted-config";
import { type AgentMountLayout, runningAgentMountLayout } from "./agent-mounts";
import { ensureTraefikDynamicDirectory } from "./agent-state";
import {
  GENERATED_SECRETS_DIRNAME,
  type RenderContext,
  renderCompose,
  resolveProxyHost,
} from "./compose-renderer";
import {
  configSchemaKeys,
  flattenResolvedConfig,
  resolveServiceConfigFromEnv,
  serviceConfigEnvPrefix,
} from "./config-resolver";
import {
  acquireConfigurationOwnership,
  ConfigurationWriterBusyError,
} from "./configuration-ownership";
import { validateTrustedConfigurationValues } from "./configuration-schema";
import type { ContainerBindMounts } from "./container-mounts";
import {
  CONFIGURATION_GENERATIONS,
  CURRENT_CONFIGURATION,
  GENERATED_COMPOSE_FILE,
  GENERATED_HARDLINK_PLAN_FILE,
  LEGACY_CONFIGURATION_GENERATIONS,
  LEGACY_CURRENT_CONFIGURATION,
  readServiceSelectionFile,
  SERVICE_SELECTION_FILE,
  writeServiceSelectionFile,
} from "./deployment";
import {
  type ReleaseServiceFiles,
  releaseServiceFiles,
  ServiceFileError,
} from "./release-service-files";
import { buildAppApiServiceEnv, expandServiceSelection } from "./selection";
import { type CheckoutPosition, importCheckoutServiceFiles } from "./service-file-import";
import { describeServiceFiles } from "./service-file-report";
import {
  appliedServiceFilePath,
  collectServiceFileTrees,
  pathInServiceFileTree,
  type ResolvedServiceFiles,
  readGenerationServiceFiles,
  resolveServiceFiles,
  SERVICE_FILES_GENERATION_FILE,
  serializeGenerationServiceFiles,
  serviceFileTreePath,
  writeServiceFileTrees,
} from "./service-file-store";
import { overrideOverlay, readServiceOverrides, staleOverrides } from "./service-overrides";
import {
  TRAEFIK_STATIC_GENERATION_FILE,
  writeLegacyTraefikRoutes,
  writeTraefikDynamicDirectory,
} from "./traefik-files";
import { renderTraefikDynamicConfiguration, renderTraefikDynamicYaml } from "./traefik-renderer";
import type { LoadedService } from "./types";
import { seedMissingWritableCopies, seedWritableCopies } from "./writable-copies";

const MAX_GENERATIONS = 16;
const MAX_GENERATION_BYTES = 2 * 1024 * 1024;
const RESOLVED_CONFIG_FILE = "resolved-config.generated.json";
const REVISION = /^cfg1_[A-Za-z0-9_-]{43}$/;

/**
 * One configuration generation: everything a render needs that is not in the
 * manifests. `selectedRoots` is the selection being applied; config and
 * secrets may name any registered service, so a generation carries what was
 * saved for services that are not enabled yet.
 */
export type ConfigurationInput = Omit<TrustedConfigurationPayload, "selectedRoots"> & {
  selectedRoots: string[];
};

export interface CommitConfigurationOptions {
  infraDir: string;
  services: readonly LoadedService[];
  /** Integration schemas the stored integration config is checked against; omitted, it is carried as is. */
  integrationSchemas?: ReadonlyMap<string, Record<string, unknown>>;
  input: ConfigurationInput;
  /** Tolerate selected services that are not installed (the default selection in a reduced checkout). */
  allowMissingSelected?: boolean;
  /** The authenticated candidate identity; omitted, use a fresh activation identity (no ABA). */
  revisionId?: string;
  /** Applied identity to compare under writer ownership; null means no pointer. */
  expectedCurrentRevisionId?: string | null;
  signal?: AbortSignal;
  beforeCommit?: () => Promise<void>;
  afterGenerationRename?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
  /**
   * Whether a container, running or stopped, still mounts the checkout's
   * Traefik dynamic directory. The routes are written there too while one
   * does, and when it is not known.
   */
  legacyTraefikDynamicMounted?: boolean;
  /**
   * The service files to render: the selected release's, which the host CLI
   * reads from its image. Omitted, this process's own (its bundle's when
   * bundled, otherwise the checkout's).
   */
  releaseServiceFiles?: ReleaseServiceFiles;
  /**
   * Where the checkout stands against the release, for the one-time import
   * of its edits: the host CLI asks git. Omitted, the checkout's own service
   * file history says (the agent, which has no git).
   */
  checkoutPosition?: CheckoutPosition;
  /**
   * The bind mounts of every container, running or stopped: a service-file
   * tree one of them mounts is kept, and those still on the checkout's files
   * are reported. Omitted (Docker can't tell), no tree is removed.
   */
  containerBindMounts?: readonly ContainerBindMounts[];
  /**
   * How the generation mounts the operations agent, asked once the one-time
   * import has run: only a render on the host may choose the narrow layout.
   * Omitted, it keeps the layout this process has (see agent-mounts.ts).
   */
  agentMountLayout?: () => AgentMountLayout;
}

export interface CommittedConfiguration {
  revisionId: string;
  enabledServiceIds: string[];
  /** Render advisories, such as optional bind mounts skipped for a missing source. */
  warnings: string[];
  /** Files beside the generation that were not written, and why; for every render's output. */
  stackFileProblems: string[];
  /**
   * The service files: the one-time import, the overrides in use, flagged and
   * ignored, unused checkout edits, containers still on the checkout's files.
   */
  serviceFileReport: string[];
}

/** Evidence about THIS attempt, never inferred from a transport exception. */
export class ConfigurationGenerationError extends Error {
  constructor(
    readonly result: ConfigurationApplyResult,
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Configuration generation failed", { cause });
    this.name = "ConfigurationGenerationError";
  }
}

export interface ConfigurationGenerationWriter {
  commit(options: Omit<CommitConfigurationOptions, "infraDir">): Promise<CommittedConfiguration>;
}

/** Hold ownership before reading state used to construct a write, through all follow-up work. */
export async function withConfigurationGenerationWriter<T>(
  infraDir: string,
  run: (writer: ConfigurationGenerationWriter) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let release: (() => void) | undefined;
  let committed: CommittedConfiguration | undefined;
  let failure: unknown;
  let value!: T;
  let active = true;
  let pending: Promise<CommittedConfiguration> | undefined;
  try {
    release = await acquireConfigurationOwnership(infraDir, signal);
    value = await run({
      commit: (options) => {
        if (!active || pending) throw new Error("Configuration writer is not available");
        pending = commitOwnedConfigurationGeneration({
          ...options,
          infraDir,
          signal: options.signal ?? signal,
        }).then((result) => {
          committed = result;
          return result;
        });
        return pending;
      },
    });
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("Configuration generation failed", { cause: error });
  }
  active = false;
  // Even a misbehaving callback that did not await commit cannot release its fence early.
  try {
    await pending;
  } catch (error) {
    if (error instanceof ConfigurationGenerationError && error.result.outcome === "committed") {
      failure = new ConfigurationGenerationError(error.result, failure ?? error);
    } else {
      failure ??=
        error instanceof Error
          ? error
          : new Error("Configuration generation failed", { cause: error });
    }
  }
  const followUpFailed = failure !== undefined;
  let cleanupFailed = false;
  try {
    release?.();
  } catch (error) {
    cleanupFailed = true;
    failure ??=
      error instanceof Error
        ? error
        : new Error("Configuration generation failed", { cause: error });
  }
  if (failure) {
    const result: ConfigurationApplyResult =
      failure instanceof ConfigurationGenerationError
        ? failure.result
        : committed
          ? {
              outcome: "committed",
              revisionId: committed.revisionId,
              enabledServiceIds: committed.enabledServiceIds,
              followUp: followUpFailed ? "failed" : "complete",
              cleanupFailed: false,
            }
          : {
              outcome: "not_committed",
              reason: failure instanceof ConfigurationWriterBusyError ? "busy" : "failed",
              cleanupFailed: false,
            };
    throw new ConfigurationGenerationError(
      { ...result, cleanupFailed: result.cleanupFailed || cleanupFailed },
      failure,
    );
  }
  return value;
}

function schemaProperties(
  schema: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  if (!schema) return {};
  const candidate = (schema.properties ?? schema) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(candidate).filter(
      ([key, value]) =>
        key !== "type" &&
        key !== "properties" &&
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value),
    ),
  ) as Record<string, Record<string, unknown>>;
}

function validateConfig(
  owner: string,
  values: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  controlledKeys: Iterable<string> = [],
): void {
  if (!validateTrustedConfigurationValues(values, schema, controlledKeys)) {
    throw new Error(`Configuration of ${owner} does not match its schema`);
  }
}

function resolveInput(
  services: readonly LoadedService[],
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>> | undefined,
  input: ConfigurationInput,
  allowMissingSelected: boolean,
) {
  const serviceById = new Map(services.map((service) => [service.manifest.id, service]));
  const expanded = expandServiceSelection([...services], input.selectedRoots, {
    allowMissingSelected,
  });
  if (expanded.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${expanded.missingIds.join(", ")}`);
  }
  const enabledIds = new Set(expanded.enabledIds);
  const allServices = services.map((service) => ({
    ...service,
    enabled: enabledIds.has(service.manifest.id),
  }));
  const enabled = allServices.filter((service) => service.enabled);
  const known = (serviceId: string) => {
    const service = serviceById.get(serviceId);
    if (!service) throw new Error(`Configuration names an unknown service: ${serviceId}`);
    return service;
  };
  const serviceConfigs = new Map<string, Record<string, unknown>>();
  const serviceConfigEnvKeys = new Map<string, string[]>();
  const saved = new Map<string, ConfigurationInput["serviceConfigs"][number]>();
  for (const entry of input.serviceConfigs) {
    const service = known(entry.serviceId);
    validateConfig(entry.serviceId, entry.values, service.manifest.configSchema);
    saved.set(entry.serviceId, entry);
    if (entry.envKeys?.length) {
      // An env reference names a non-secret field of this service, and only one
      // the input carries no value for: the env layer wins over everything else.
      const fields = new Set(configSchemaKeys(service.manifest.configSchema).map(({ key }) => key));
      for (const key of entry.envKeys) {
        if (!fields.has(key) || key in entry.values) {
          throw new Error(`Configuration of ${entry.serviceId} has a bad env reference: ${key}`);
        }
      }
      serviceConfigEnvKeys.set(entry.serviceId, entry.envKeys);
    }
  }
  // default < saved < env: the input carries what was saved; the schema
  // defaults are the manifest's, so they follow the manifest being rendered.
  for (const service of allServices) {
    const entry = saved.get(service.manifest.id);
    const envKeys = new Set(entry?.envKeys ?? []);
    const defaults = Object.entries(
      flattenResolvedConfig(resolveServiceConfigFromEnv(service.manifest, {})),
    ).filter(([key]) => !envKeys.has(key));
    const values = { ...Object.fromEntries(defaults), ...entry?.values };
    if (Object.keys(values).length > 0) serviceConfigs.set(service.manifest.id, values);
  }
  if (integrationSchemas) {
    for (const entry of input.integrationConfigs) {
      const schema = integrationSchemas.get(entry.integrationId);
      if (!schema)
        throw new Error(`Configuration names an unknown integration: ${entry.integrationId}`);
      validateConfig(entry.integrationId, entry.values, schema, ["enabled"]);
    }
  }
  const appApi = enabled.find((service) => service.manifest.id === "app-api");
  if (appApi) {
    const passthroughKeys: string[] = [];
    for (const service of allServices) {
      const prefix = serviceConfigEnvPrefix(service.manifest.id);
      for (const { key } of configSchemaKeys(service.manifest.configSchema)) {
        passthroughKeys.push(`${prefix}${key.toUpperCase()}`);
      }
    }
    for (const [integrationId, schema] of integrationSchemas ?? []) {
      const id = integrationId.replaceAll("-", "_").toUpperCase();
      for (const { key } of configSchemaKeys(schema)) {
        passthroughKeys.push(`INTEGRATION_${id}_${key.replaceAll("-", "_").toUpperCase()}`);
      }
    }
    serviceConfigs.set(
      "app-api",
      buildAppApiServiceEnv(enabled, serviceConfigs.get("app-api") ?? {}, passthroughKeys),
    );
  }
  const serviceSecrets = new Map<string, Record<string, string>>();
  for (const entry of input.serviceSecrets) {
    const properties = schemaProperties(known(entry.serviceId).manifest.configSchema);
    for (const key of Object.keys(entry.values)) {
      if (properties[key]?.["x-openmapx-secret"] !== true) {
        throw new Error(`Secret ${key} of ${entry.serviceId} is not a secret field`);
      }
    }
    serviceSecrets.set(entry.serviceId, entry.values);
  }
  return {
    appliedRoots: input.selectedRoots.filter((id) => serviceById.has(id)),
    allServices,
    enabled,
    enabledIdsOrdered: expanded.enabledIdsOrdered,
    serviceConfigs,
    serviceConfigEnvKeys,
    serviceSecrets,
  };
}

async function writeDurable(
  path: string,
  contents: string | Uint8Array,
  mode: number,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(contents);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const UNSAFE = "Configuration generation is not owned by this user or has unsafe permissions";

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** The local POSIX directory boundary is trusted; pin and validate the final file. */
function readGenerationFile(
  path: string,
  before: BigIntStats,
  maximum: number,
  modes: readonly bigint[],
): { contents: Buffer; mode: bigint } {
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(process.geteuid?.() ?? 0) ||
    !modes.includes(before.mode & 0o777n) ||
    before.size < 0n ||
    before.size > BigInt(maximum)
  ) {
    throw new Error(UNSAFE);
  }
  // NONBLOCK prevents a raced-in FIFO from blocking before fstat can reject it.
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileObservation(before, opened)) throw new Error(UNSAFE);
    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (count === 0) throw new Error(UNSAFE);
      offset += count;
    }
    // Never follow growth with an unbounded allocation or read-to-EOF loop.
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) throw new Error(UNSAFE);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileObservation(opened, after)) throw new Error(UNSAFE);
    return { contents, mode: opened.mode & 0o777n };
  } finally {
    closeSync(descriptor);
  }
}

function safeGenerationTree(path: string): { entries: number; bytes: number } {
  const owner = process.geteuid?.() ?? 0;
  const rootStats = lstatSync(path);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    rootStats.uid !== owner ||
    (rootStats.mode & 0o777) !== 0o700
  ) {
    throw new Error(UNSAFE);
  }
  let entries = 1;
  let bytes = 0;
  // Secret files are 0444 inside their 0700 directories (see
  // commitConfigurationGeneration); every other generated file is private.
  const visit = (directory: string, secrets: boolean) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 1024) throw new Error(UNSAFE);
      const child = join(directory, entry.name);
      const stats = lstatSync(child);
      if (stats.uid !== owner || stats.isSymbolicLink()) throw new Error(UNSAFE);
      if (stats.isDirectory()) {
        if ((stats.mode & 0o777) !== 0o700) throw new Error(UNSAFE);
        visit(child, secrets || (directory === path && entry.name === GENERATED_SECRETS_DIRNAME));
      } else if (stats.isFile()) {
        const modes = secrets ? [0o444] : [0o400, 0o600];
        if (stats.nlink !== 1 || !modes.includes(stats.mode & 0o777)) throw new Error(UNSAFE);
        bytes += stats.size;
      } else throw new Error(UNSAFE);
      if (bytes > MAX_GENERATION_BYTES) throw new Error(UNSAFE);
    }
  };
  visit(path, false);
  return { entries, bytes };
}

function generationDigest(path: string): string {
  safeGenerationTree(path);
  const digest = createHash("sha256").update("openmapx-trusted-generation-v1\0");
  let entries = 1;
  let bytes = 0;
  const visit = (directory: string, prefix = "", secrets = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (++entries > 1024) throw new Error(UNSAFE);
      const stats = lstatSync(child, { bigint: true });
      digest
        .update(entry.isDirectory() ? "d\0" : "f\0")
        .update(relative)
        .update("\0");
      if (entry.isDirectory()) {
        if (
          !stats.isDirectory() ||
          stats.uid !== BigInt(process.geteuid?.() ?? 0) ||
          (stats.mode & 0o777n) !== 0o700n
        ) {
          throw new Error(UNSAFE);
        }
        digest.update(String(stats.mode & 0o777n)).update("\0");
        visit(
          child,
          relative,
          secrets || (directory === path && entry.name === GENERATED_SECRETS_DIRNAME),
        );
      } else {
        const { contents, mode } = readGenerationFile(
          child,
          stats,
          MAX_GENERATION_BYTES - bytes,
          secrets ? [0o444n] : [0o400n, 0o600n],
        );
        bytes += contents.length;
        digest.update(String(mode)).update("\0").update(contents).update("\0");
      }
    }
  };
  visit(path);
  return digest.digest("base64url");
}

/** Where a pointer and its generations live, relative to `infra/docker`. */
interface GenerationLayout {
  pointer: string;
  generations: string;
}

const LAYOUT: GenerationLayout = {
  pointer: CURRENT_CONFIGURATION,
  generations: CONFIGURATION_GENERATIONS,
};
const LEGACY_LAYOUT: GenerationLayout = {
  pointer: LEGACY_CURRENT_CONFIGURATION,
  generations: LEGACY_CONFIGURATION_GENERATIONS,
};

/** A pointer's link text: the generation, relative to the pointer's directory. */
function pointerTarget(layout: GenerationLayout, revisionId: string): string {
  return join(relativeTo(dirname(layout.pointer), layout.generations), revisionId);
}

function relativeTo(from: string, to: string): string {
  const fromParts = from === "." ? [] : from.split("/");
  const toParts = to.split("/");
  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) common += 1;
  return [...fromParts.slice(common).map(() => ".."), ...toParts.slice(common)].join("/");
}

function generationAt(infraDir: string, layout: GenerationLayout): string | null {
  const current = join(infraDir, layout.pointer);
  let target: string;
  try {
    const stats = lstatSync(current);
    // The pointer is this user's: one swapped in by anyone else is refused.
    if (!stats.isSymbolicLink() || stats.uid !== (process.geteuid?.() ?? 0)) {
      throw new Error(UNSAFE);
    }
    target = readlinkSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const expected = pointerTarget(layout, "cfg1_");
  if (
    !target.startsWith(expected) ||
    !/^cfg1_[A-Za-z0-9_-]{43}$/.test(target.slice(expected.length - "cfg1_".length))
  ) {
    throw new Error(`${current} points outside ${layout.generations}`);
  }
  const absolute = resolve(dirname(current), target);
  if (!absolute.startsWith(`${resolve(infraDir, layout.generations)}/`)) {
    throw new Error(`${current} points outside ${layout.generations}`);
  }
  safeGenerationTree(absolute);
  return basename(absolute);
}

/** The applied generation's name, or null before the first render. */
export function currentConfigurationGeneration(infraDir: string): string | null {
  return generationAt(infraDir, LAYOUT);
}

/**
 * Whether this is the first render since releases kept the configuration in
 * `infra/docker` itself: no current generation in the agent's state yet, and
 * one the earlier release applied. Only then is the earlier one read, once, to
 * carry the applied settings and selection over; afterwards nothing reads it.
 */
export function configurationMigrationPending(infraDir: string): boolean {
  if (currentConfigurationGeneration(infraDir) !== null) return false;
  try {
    return generationAt(infraDir, LEGACY_LAYOUT) !== null;
  } catch (error) {
    // Rendering without it would silently drop the settings it holds.
    throw new Error(
      `The earlier release's applied configuration (infra/docker/${LEGACY_CURRENT_CONFIGURATION}) cannot be verified as this user's own (${(error as Error).message}), so it is not carried over. Remove infra/docker/${LEGACY_CURRENT_CONFIGURATION} to render without it; the admin panel applies its saved settings again.`,
    );
  }
}

/** The generation readers carry settings from: the current one, or while migrating the earlier release's. */
function appliedGenerationDirectory(infraDir: string): string | null {
  const active = currentConfigurationGeneration(infraDir);
  if (active) return join(infraDir, CONFIGURATION_GENERATIONS, active);
  if (!configurationMigrationPending(infraDir)) return null;
  const legacy = generationAt(infraDir, LEGACY_LAYOUT);
  return legacy ? join(infraDir, LEGACY_CONFIGURATION_GENERATIONS, legacy) : null;
}

/**
 * On the first render of this release, carry the earlier release's applied
 * selection over as `service-selection.json` in the agent's state, unless one
 * exists there. It is taken from the applied generation, which only this user
 * can have written, never from the earlier `infra/docker/service-selection.json`.
 * Call under writer ownership.
 */
export function migrateLegacyServiceSelection(infraDir: string): boolean {
  if (!configurationMigrationPending(infraDir)) return false;
  if (readServiceSelectionFile(infraDir) !== null) return false;
  const directory = appliedGenerationDirectory(infraDir);
  if (!directory) return false;
  const path = join(directory, SERVICE_SELECTION_FILE);
  const { contents } = readGenerationFile(path, lstatSync(path, { bigint: true }), 64 * 1024, [
    0o400n,
    0o600n,
  ]);
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as {
    selected?: unknown;
  };
  if (!Array.isArray(raw.selected) || raw.selected.some((id) => typeof id !== "string")) {
    throw new Error(`Malformed applied service selection at ${path}`);
  }
  writeServiceSelectionFile(infraDir, raw.selected as string[]);
  return true;
}

function hasGenerations(infraDir: string): boolean {
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  try {
    const metadata = lstatSync(generations);
    const owner = process.geteuid?.() ?? 0;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new Error(UNSAFE);
    }
    return readdirSync(generations).some((name) => REVISION.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The enabled services of the applied generation, or null before the first
 * render. A generation directory without a current pointer is an error, not
 * "nothing applied".
 */
export function readAppliedServiceIds(
  infraDir: string,
  services: readonly LoadedService[],
): ReadonlySet<string> | null {
  const active = currentConfigurationGeneration(infraDir);
  if (!active) {
    if (hasGenerations(infraDir)) {
      throw new Error(`${CONFIGURATION_GENERATIONS} has generations but none is current`);
    }
    return null;
  }
  const path = join(infraDir, CONFIGURATION_GENERATIONS, active, SERVICE_SELECTION_FILE);
  const metadata = lstatSync(path, { bigint: true });
  const { contents } = readGenerationFile(path, metadata, 64 * 1024, [0o400n, 0o600n]);
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) {
    throw new Error(`Malformed applied service selection at ${path}`);
  }
  const selected = (raw as { selected?: unknown }).selected;
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string")) {
    throw new Error(`Malformed applied service selection at ${path}`);
  }
  const expanded = expandServiceSelection([...services], selected, {
    allowMissingSelected: false,
  });
  if (expanded.missingIds.length > 0) {
    throw new Error(`Applied service(s) are not installed: ${expanded.missingIds.join(", ")}`);
  }
  return new Set(expanded.enabledIds);
}

function readOwnGenerationFile(path: string, modes: readonly bigint[]): string {
  return readGenerationFile(
    path,
    lstatSync(path, { bigint: true }),
    MAX_GENERATION_BYTES,
    modes,
  ).contents.toString("utf8");
}

/**
 * The config, integration config and secrets of the applied generation — what
 * the admin panel last applied — for a render that cannot read the database.
 */
export function readAppliedConfiguration(
  infraDir: string,
): Omit<ConfigurationInput, "domain" | "selectedRoots"> {
  const empty = { serviceConfigs: [], integrationConfigs: [], serviceSecrets: [] };
  const generation = appliedGenerationDirectory(infraDir);
  if (!generation) return empty;
  // Each file is opened without following links and must be this user's
  // own, as the generation's tree was checked: while migrating, the earlier
  // generation sits below infra/docker, whose entries its group may rename.
  const resolved = JSON.parse(
    readOwnGenerationFile(join(generation, RESOLVED_CONFIG_FILE), [0o400n, 0o600n]),
  ) as {
    serviceConfigs?: ConfigurationInput["serviceConfigs"];
    integrationConfigs?: ConfigurationInput["integrationConfigs"];
  };
  const serviceSecrets: ConfigurationInput["serviceSecrets"] = [];
  const secretsRoot = join(generation, GENERATED_SECRETS_DIRNAME);
  if (existsSync(secretsRoot)) {
    for (const serviceId of readdirSync(secretsRoot).sort()) {
      const values: Record<string, string> = {};
      for (const key of readdirSync(join(secretsRoot, serviceId)).sort()) {
        values[key] = readOwnGenerationFile(join(secretsRoot, serviceId, key), [0o444n]);
      }
      serviceSecrets.push({ serviceId, values });
    }
  }
  return {
    serviceConfigs: resolved.serviceConfigs ?? [],
    integrationConfigs: resolved.integrationConfigs ?? [],
    serviceSecrets,
  };
}

/** Call under writer ownership so the pointer and its projections are one observation.
 * Only the resolved integration file is read: service secrets never enter this result.
 */
export function inspectAppliedConfiguration(
  infraDir: string,
): OpsResultFor<"configuration.inspect"> {
  const revisionId = currentConfigurationGeneration(infraDir);
  if (revisionId === null) return { revisionId, integrationConfigDigests: [] };
  const resolved = JSON.parse(
    readOwnGenerationFile(
      join(infraDir, CONFIGURATION_GENERATIONS, revisionId, RESOLVED_CONFIG_FILE),
      [0o400n, 0o600n],
    ),
  );
  const { integrationConfigs } = trustedConfigurationPayloadSchema.parse({
    domain: "inspection.invalid",
    serviceConfigs: [],
    serviceSecrets: [],
    integrationConfigs: resolved.integrationConfigs,
  });
  return {
    revisionId,
    integrationConfigDigests: integrationConfigs.map(({ integrationId, values }) => ({
      integrationId,
      digest: configurationProjectionFingerprint(values),
    })),
  };
}

/**
 * Create the generations directory, drop interrupted writes and prune old
 * generations. The applied generation is never pruned.
 */
export async function initializeConfigurationGenerations(infraDir: string): Promise<void> {
  return withConfigurationGenerationWriter(infraDir, () =>
    initializeOwnedConfigurationGenerations(infraDir),
  );
}

async function initializeOwnedConfigurationGenerations(infraDir: string): Promise<void> {
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  try {
    lstatSync(generations);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(generations, { mode: 0o700 });
  }
  const generationRoot = lstatSync(generations);
  const owner = process.geteuid?.() ?? 0;
  if (
    !generationRoot.isDirectory() ||
    generationRoot.isSymbolicLink() ||
    generationRoot.uid !== owner ||
    (generationRoot.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      `${generations} must be a 0700 directory owned by uid ${owner} (it is uid ${generationRoot.uid}); render as the user the stack runs as`,
    );
  }
  const active = currentConfigurationGeneration(infraDir);
  const entries = readdirSync(generations, { withFileTypes: true });
  if (entries.length > MAX_GENERATIONS + 8) throw new Error(`${generations} has too many entries`);
  const temporaryPaths: string[] = [];
  const complete: Array<{ name: string; path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(generations, entry.name);
    if (/^\.cfg1_[A-Za-z0-9_-]{43}\.[a-f0-9]{32}\.tmp$/.test(entry.name)) {
      safeGenerationTree(path);
      temporaryPaths.push(path);
      continue;
    }
    if (!REVISION.test(entry.name))
      throw new Error(`Unexpected entry in ${generations}: ${entry.name}`);
    safeGenerationTree(path);
    complete.push({ name: entry.name, path, mtimeMs: lstatSync(path).mtimeMs });
  }
  const pointerTemporaries: string[] = [];
  const pointerDirectory = dirname(join(infraDir, CURRENT_CONFIGURATION));
  const pointerName = new RegExp(`^\\.${basename(CURRENT_CONFIGURATION)}\\.[a-f0-9]{32}\\.tmp$`);
  const targetName = new RegExp(`^${pointerTarget(LAYOUT, "cfg1_")}[A-Za-z0-9_-]{43}$`);
  for (const entry of readdirSync(pointerDirectory, { withFileTypes: true })) {
    if (!pointerName.test(entry.name)) continue;
    const path = join(pointerDirectory, entry.name);
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink() || stats.uid !== owner) throw new Error(UNSAFE);
    if (!targetName.test(readlinkSync(path))) throw new Error(UNSAFE);
    pointerTemporaries.push(path);
  }
  for (const path of [...temporaryPaths, ...pointerTemporaries]) rmSync(path, { recursive: true });
  if (temporaryPaths.length > 0) await syncDirectory(generations);
  if (pointerTemporaries.length > 0) await syncDirectory(pointerDirectory);
  // Keep space for the next generation and prune only after every existing
  // entry has passed validation.
  const removable = complete
    .filter((entry) => entry.name !== active)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let retainedCount = complete.length;
  while (retainedCount > MAX_GENERATIONS - 1) {
    const oldest = removable.shift();
    if (!oldest) break;
    rmSync(oldest.path, { recursive: true });
    retainedCount -= 1;
  }
  if (complete.some((entry) => !existsSync(entry.path))) await syncDirectory(generations);
  if (active && !existsSync(join(generations, active))) {
    throw new Error(`The applied generation ${active} is missing`);
  }
}

/**
 * The host path of a release file of `serviceId` as the applied generation
 * mounts it, for a build that must read the same bytes (OTP, Pelias).
 */
export function appliedServiceFile(infraDir: string, serviceId: string, path: string): string {
  const revisionId = currentConfigurationGeneration(infraDir);
  return appliedServiceFilePath(
    infraDir,
    revisionId ? join(infraDir, CONFIGURATION_GENERATIONS, revisionId) : null,
    serviceId,
    path,
  );
}

/** `<serviceId>/<hash>` of every service-file tree a retained generation records. */
function recordedServiceFileTrees(infraDir: string): Set<string> {
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  const recorded = new Set<string>();
  for (const name of readdirSync(generations)) {
    if (!REVISION.test(name)) continue;
    for (const [serviceId, hash] of readGenerationServiceFiles(join(generations, name)) ?? []) {
      recorded.add(`${serviceId}/${hash}`);
    }
  }
  return recorded;
}

/**
 * Files outside the generation that follow it: Traefik's dynamic directory,
 * with the routes for the enabled first-party services, the writable copies
 * of files their containers rewrite, and the writable data directories
 * Compose would otherwise create as root. Returns what render reports about
 * them.
 */
function writeStackFiles(
  infraDir: string,
  enabled: readonly LoadedService[],
  context: RenderContext,
  serviceFiles: ResolvedServiceFiles,
  writableBindDirs: readonly string[],
  legacyTraefikDynamicMounted: boolean | undefined,
): string[] {
  const traefik = renderTraefikDynamicConfiguration(
    enabled.filter((service) => service.isBuiltIn).map((service) => service.manifest),
    {
      domain: context.domain,
      resolveProxyHost: (manifest) => resolveProxyHost(manifest, context),
    },
  );
  const routes = renderTraefikDynamicYaml(traefik);
  // Traefik watches its dynamic directory, so every file there is replaced,
  // never rewritten in place.
  writeTraefikDynamicDirectory(infraDir, serviceFiles.traefik.dynamic, routes);
  for (const dir of writableBindDirs) mkdirSync(dir, { recursive: true });
  const enabledIds = new Set(enabled.map((service) => service.manifest.id));
  const problems = seedWritableCopies(
    infraDir,
    serviceFiles.writableCopies.filter((seed) => enabledIds.has(seed.serviceId)),
  );
  // A Traefik not recreated since an earlier release still reads them there.
  const legacy =
    legacyTraefikDynamicMounted === false
      ? null
      : writeLegacyTraefikRoutes(infraDir, routes, legacyTraefikDynamicMounted);
  if (legacy) problems.push(legacy);
  return problems;
}

export type RenderConfigurationOptions = Pick<
  CommitConfigurationOptions,
  | "infraDir"
  | "services"
  | "integrationSchemas"
  | "input"
  | "allowMissingSelected"
  | "releaseServiceFiles"
>;

/**
 * What a generation would hold, without writing it: the compose preview and
 * every apply render through here. The release's service files, with the
 * operator's overrides in their place.
 */
export function renderConfiguration(
  options: RenderConfigurationOptions & { agentMountLayout?: AgentMountLayout },
) {
  const { infraDir, input } = options;
  const resolved = resolveInput(
    options.services,
    options.integrationSchemas,
    input,
    options.allowMissingSelected ?? false,
  );
  const release = options.releaseServiceFiles ?? releaseServiceFiles(options.services);
  const overrides = readServiceOverrides(infraDir, release);
  const serviceFiles = resolveServiceFiles(options.services, release, overrideOverlay(overrides));
  const context: RenderContext = {
    domain: input.domain,
    agentMountLayout: options.agentMountLayout ?? runningAgentMountLayout(infraDir),
    composeOutDir: join(infraDir, CURRENT_CONFIGURATION),
    infraDir,
    allServices: resolved.allServices,
    resolvedServiceConfigs: resolved.serviceConfigs,
    serviceConfigEnvKeys: resolved.serviceConfigEnvKeys,
    serviceSecretKeys: new Map(
      [...resolved.serviceSecrets].map(([id, values]) => [id, Object.keys(values)]),
    ),
    serviceFileSource: (serviceId, path) => {
      const tree = serviceFiles.trees.get(serviceId);
      return tree
        ? pathInServiceFileTree(tree, serviceFileTreePath(infraDir, serviceId, tree.hash), path)
        : undefined;
    },
  };
  return {
    resolved,
    context,
    rendered: renderCompose(resolved.enabled, context),
    serviceFiles,
    overrides,
  };
}

/**
 * Render a generation from the manifests and `input`, make it the applied one
 * and bring the files that follow it up to date. The CLI and the ops-agent
 * both apply configuration through here.
 */
export async function commitConfigurationGeneration(
  options: CommitConfigurationOptions,
): Promise<CommittedConfiguration> {
  return withConfigurationGenerationWriter(
    options.infraDir,
    (writer) => writer.commit(options),
    options.signal,
  );
}

async function commitOwnedConfigurationGeneration(
  options: CommitConfigurationOptions,
): Promise<CommittedConfiguration> {
  const { infraDir, input } = options;
  if (
    options.expectedCurrentRevisionId !== undefined &&
    options.expectedCurrentRevisionId !== null &&
    !REVISION.test(options.expectedCurrentRevisionId)
  ) {
    throw new Error("Bad expected current generation");
  }
  options.signal?.throwIfAborted();
  // Its bind mount is optional, left out when the directory is missing, so
  // it is there before the generation is rendered.
  ensureTraefikDynamicDirectory(infraDir);
  // The first generation with the release's files takes the operator's
  // checkout edits along as overrides, before it renders.
  const release = options.releaseServiceFiles ?? releaseServiceFiles(options.services);
  const imported = importCheckoutServiceFiles({
    infraDir,
    services: options.services,
    release,
    ...(options.checkoutPosition ? { position: options.checkoutPosition } : {}),
  });
  const { resolved, context, rendered, serviceFiles, overrides } = renderConfiguration({
    ...options,
    releaseServiceFiles: release,
    agentMountLayout: options.agentMountLayout?.(),
  });
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  await initializeOwnedConfigurationGenerations(infraDir);
  const nonce = randomUUID().replaceAll("-", "");
  const placeholder = options.revisionId ?? `cfg1_${"0".repeat(43)}`;
  if (!REVISION.test(placeholder)) throw new Error(`Bad generation name ${placeholder}`);
  let temporary: string | undefined = join(generations, `.${placeholder}.${nonce}.tmp`);
  let committed: CommittedConfiguration | undefined;
  let failure: unknown;
  let cleanupFailed = false;
  try {
    mkdirSync(temporary, { mode: 0o700 });
    await writeDurable(join(temporary, GENERATED_COMPOSE_FILE), rendered.composeYaml, 0o600);
    await writeDurable(
      join(temporary, GENERATED_HARDLINK_PLAN_FILE),
      `${JSON.stringify(rendered.hardlinkPlan, null, 2)}\n`,
      0o600,
    );
    await writeDurable(
      join(temporary, SERVICE_SELECTION_FILE),
      `${JSON.stringify({ selected: resolved.appliedRoots }, null, 2)}\n`,
      0o600,
    );
    await writeDurable(
      join(temporary, RESOLVED_CONFIG_FILE),
      `${JSON.stringify({
        serviceConfigs: input.serviceConfigs,
        integrationConfigs: input.integrationConfigs,
      })}\n`,
      0o600,
    );
    // The service files its containers mount, in the store beside the
    // generations; the generation records which trees it uses.
    writeServiceFileTrees(infraDir, serviceFiles.trees.values());
    await writeDurable(
      join(temporary, SERVICE_FILES_GENERATION_FILE),
      serializeGenerationServiceFiles(serviceFiles.trees),
      0o600,
    );
    // A writable copy the generation mounts must be there before it commits;
    // one that is changes after (writeStackFiles).
    const enabledIds = new Set(resolved.enabled.map((service) => service.manifest.id));
    seedMissingWritableCopies(
      infraDir,
      serviceFiles.writableCopies.filter((seed) => enabledIds.has(seed.serviceId)),
    );
    // Traefik's static configuration, read once at its start, belongs to the
    // generation; its dynamic directory, which it watches, stays put.
    if (
      resolved.enabled.some((service) => service.isBuiltIn && service.manifest.id === "traefik")
    ) {
      const staticConfiguration = serviceFiles.traefik.staticConfiguration;
      if (!staticConfiguration) {
        throw new ServiceFileError("The release has no services/traefik/config/traefik.yml");
      }
      mkdirSync(join(temporary, dirname(TRAEFIK_STATIC_GENERATION_FILE)), { mode: 0o700 });
      await writeDurable(
        join(temporary, TRAEFIK_STATIC_GENERATION_FILE),
        staticConfiguration,
        0o400,
      );
      await syncDirectory(join(temporary, dirname(TRAEFIK_STATIC_GENERATION_FILE)));
    }
    const populatedSecrets = [...resolved.serviceSecrets].filter(
      ([, values]) => Object.keys(values).length > 0,
    );
    if (populatedSecrets.length > 0) {
      const secretsRoot = join(temporary, GENERATED_SECRETS_DIRNAME);
      mkdirSync(secretsRoot, { mode: 0o700 });
      for (const [serviceId, values] of populatedSecrets) {
        const serviceDirectory = join(secretsRoot, serviceId);
        mkdirSync(serviceDirectory, { mode: 0o700 });
        for (const [key, value] of Object.entries(values)) {
          // Compose bind-mounts a file secret with its host owner and mode (it
          // ignores `uid`/`mode` for file sources), so a container running as
          // another uid (OpenConditions runs as 1001) could not read an 0400
          // file. The 0700 directories above are the host-side boundary; the
          // file itself is readable by whichever container mounts it.
          await writeDurable(join(serviceDirectory, key), value, 0o444);
        }
        await syncDirectory(serviceDirectory);
      }
      await syncDirectory(secretsRoot);
    }
    await syncDirectory(temporary);
    const revisionId = options.revisionId ?? `cfg1_${randomBytes(32).toString("base64url")}`;
    const finalGeneration = join(generations, revisionId);
    await options.beforeCommit?.();
    options.signal?.throwIfAborted();
    if (existsSync(finalGeneration)) {
      if (generationDigest(finalGeneration) !== generationDigest(temporary)) {
        throw new Error(`Generation ${revisionId} exists with other content`);
      }
      rmSync(temporary, { recursive: true });
      temporary = undefined;
    } else {
      renameSync(temporary, finalGeneration);
      temporary = undefined;
      await syncDirectory(generations);
      await options.afterGenerationRename?.();
    }
    options.signal?.throwIfAborted();
    const currentRevisionId = currentConfigurationGeneration(infraDir);
    if (
      options.expectedCurrentRevisionId !== undefined &&
      options.expectedCurrentRevisionId !== currentRevisionId
    ) {
      throw new ConfigurationGenerationError({
        outcome: "not_committed",
        reason: "conflict",
        currentRevisionId,
        cleanupFailed: false,
      });
    }
    if (currentRevisionId !== revisionId) {
      const pointer = join(infraDir, CURRENT_CONFIGURATION);
      const pointerTemporary = join(dirname(pointer), `.${basename(pointer)}.${nonce}.tmp`);
      symlinkSync(pointerTarget(LAYOUT, revisionId), pointerTemporary);
      renameSync(pointerTemporary, pointer);
      // The rename is the commit point. Record evidence BEFORE any fallible sync/follow-up.
      committed = {
        revisionId,
        enabledServiceIds: resolved.enabledIdsOrdered,
        warnings: rendered.warnings ?? [],
        stackFileProblems: [],
        serviceFileReport: [],
      };
      await syncDirectory(dirname(join(infraDir, CURRENT_CONFIGURATION)));
    } else {
      committed = {
        revisionId,
        enabledServiceIds: resolved.enabledIdsOrdered,
        warnings: rendered.warnings ?? [],
        stackFileProblems: [],
        serviceFileReport: [],
      };
    }
    committed.serviceFileReport.push(
      ...describeServiceFiles({
        infraDir,
        services: options.services,
        release,
        overrides,
        // This generation's overrides become the reviewed ones.
        stale: staleOverrides(infraDir, overrides, { record: true }),
        imported,
        ...(options.containerBindMounts ? { mounts: options.containerBindMounts } : {}),
      }),
    );
    committed.stackFileProblems.push(
      ...writeStackFiles(
        infraDir,
        resolved.enabled,
        context,
        serviceFiles,
        rendered.writableBindDirs ?? [],
        options.legacyTraefikDynamicMounted,
      ),
    );
    try {
      collectServiceFileTrees(
        infraDir,
        recordedServiceFileTrees(infraDir),
        options.containerBindMounts?.flatMap((mount) => mount.sources),
      );
    } catch (error) {
      // They take little space; the next render tries again.
      committed.stackFileProblems.push(
        `Service-file trees no generation uses were not removed: ${(error as Error).message}`,
      );
    }
    await options.afterCommit?.();
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("Configuration generation failed", { cause: error });
  }
  try {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    failure ??=
      error instanceof Error
        ? error
        : new Error("Configuration generation failed", { cause: error });
  }
  if (failure) {
    const result: ConfigurationApplyResult = committed
      ? {
          outcome: "committed",
          revisionId: committed.revisionId,
          enabledServiceIds: committed.enabledServiceIds,
          followUp: "failed",
          cleanupFailed,
        }
      : failure instanceof ConfigurationGenerationError
        ? { ...failure.result, cleanupFailed: failure.result.cleanupFailed || cleanupFailed }
        : { outcome: "not_committed", reason: "failed", cleanupFailed };
    throw new ConfigurationGenerationError(result, failure);
  }
  if (!committed) throw new Error("Configuration generation did not produce commit evidence");
  return committed;
}
