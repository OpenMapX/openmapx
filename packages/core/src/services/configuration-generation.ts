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
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { configurationProjectionFingerprint, type OpsResultFor } from "../ops";
import type { ConfigurationApplyResult } from "../ops/contract";
import {
  type TrustedConfigurationPayload,
  trustedConfigurationPayloadSchema,
} from "../ops/trusted-config";
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
import {
  CONFIGURATION_GENERATIONS,
  CURRENT_CONFIGURATION,
  GENERATED_COMPOSE_FILE,
  GENERATED_HARDLINK_PLAN_FILE,
  SERVICE_SELECTION_FILE,
} from "./deployment";
import { buildAppApiServiceEnv, expandServiceSelection } from "./selection";
import { renderTraefikDynamicConfiguration, renderTraefikDynamicYaml } from "./traefik-renderer";
import type { LoadedService } from "./types";

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
  /** Verified Docker generations that still contain owned containers; absent means retain conservatively. */
  ownedServiceGenerations?: readonly { containerId: string; revisionIds: readonly string[] }[];
  /** A complete bounded acquisition; omission cannot prove a previous container disappeared. */
  observedServiceContainerIds?: readonly string[];
  /** The authenticated candidate identity; omitted, use a fresh activation identity (no ABA). */
  revisionId?: string;
  /** Applied identity to compare under writer ownership; null means no pointer. */
  expectedCurrentRevisionId?: string | null;
  signal?: AbortSignal;
  beforeCommit?: () => Promise<void>;
  afterGenerationRename?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

export interface CommittedConfiguration {
  revisionId: string;
  enabledServiceIds: string[];
  /** Render advisories, such as optional bind mounts skipped for a missing source. */
  warnings: string[];
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

/** The applied generation's name, or null before the first render. */
export function currentConfigurationGeneration(infraDir: string): string | null {
  const current = join(infraDir, CURRENT_CONFIGURATION);
  let target: string;
  try {
    if (!lstatSync(current).isSymbolicLink()) throw new Error(UNSAFE);
    target = readlinkSync(current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!new RegExp(`^${CONFIGURATION_GENERATIONS}/cfg1_[A-Za-z0-9_-]{43}$`).test(target)) {
    throw new Error(`${current} points outside ${CONFIGURATION_GENERATIONS}`);
  }
  const absolute = resolve(infraDir, target);
  if (!absolute.startsWith(`${resolve(infraDir, CONFIGURATION_GENERATIONS)}/`)) {
    throw new Error(`${current} points outside ${CONFIGURATION_GENERATIONS}`);
  }
  safeGenerationTree(absolute);
  return basename(absolute);
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

/**
 * The config, integration config and secrets of the applied generation — what
 * the admin panel last applied — for a render that cannot read the database.
 */
export function readAppliedConfiguration(
  infraDir: string,
): Omit<ConfigurationInput, "domain" | "selectedRoots"> {
  const empty = { serviceConfigs: [], integrationConfigs: [], serviceSecrets: [] };
  const active = currentConfigurationGeneration(infraDir);
  if (!active) return empty;
  const generation = join(infraDir, CONFIGURATION_GENERATIONS, active);
  const resolved = JSON.parse(readFileSync(join(generation, RESOLVED_CONFIG_FILE), "utf-8")) as {
    serviceConfigs?: ConfigurationInput["serviceConfigs"];
    integrationConfigs?: ConfigurationInput["integrationConfigs"];
  };
  const serviceSecrets: ConfigurationInput["serviceSecrets"] = [];
  const secretsRoot = join(generation, GENERATED_SECRETS_DIRNAME);
  if (existsSync(secretsRoot)) {
    for (const serviceId of readdirSync(secretsRoot).sort()) {
      const values: Record<string, string> = {};
      for (const key of readdirSync(join(secretsRoot, serviceId)).sort()) {
        values[key] = readFileSync(join(secretsRoot, serviceId, key), "utf-8");
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
    readFileSync(
      join(infraDir, CONFIGURATION_GENERATIONS, revisionId, RESOLVED_CONFIG_FILE),
      "utf8",
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

const RETAINED_GENERATIONS = ".owned-service-generations.json";
interface GenerationRetention {
  conservative: string[];
  containers: Record<string, string[]>;
}
function readGenerationRetention(infraDir: string): GenerationRetention {
  const path = join(infraDir, RETAINED_GENERATIONS);
  try {
    const metadata = lstatSync(path, { bigint: true });
    const { contents } = readGenerationFile(path, metadata, 64 * 1024, [0o600n]);
    const raw = JSON.parse(contents.toString("utf8")) as GenerationRetention;
    if (
      !raw ||
      Object.keys(raw).sort().join(",") !== "conservative,containers" ||
      !Array.isArray(raw.conservative) ||
      !raw.containers ||
      typeof raw.containers !== "object" ||
      Array.isArray(raw.containers)
    )
      throw new Error(UNSAFE);
    const values = Object.values(raw.containers);
    if (
      Object.keys(raw.containers).length > 256 ||
      Object.keys(raw.containers).some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
      values.some((ids) => !Array.isArray(ids) || ids.length > 256)
    )
      throw new Error(UNSAFE);
    const revisions = [...raw.conservative, ...values.flat()];
    if (
      revisions.length > 512 ||
      revisions.some((id) => typeof id !== "string" || !REVISION.test(id)) ||
      new Set(revisions).size > 256
    )
      throw new Error(UNSAFE);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // An upgraded deployment has no ownership observations yet. Startup and
      // host-only renders must not prune its old containers' generation files.
      const generations = join(infraDir, CONFIGURATION_GENERATIONS);
      let entries: string[];
      try {
        const stat = lstatSync(generations);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== (process.geteuid?.() ?? 0) ||
          (stat.mode & 0o777) !== 0o700
        )
          throw new Error(UNSAFE);
        entries = readdirSync(generations).filter((name) => REVISION.test(name));
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT")
          return { conservative: [], containers: {} };
        throw missing;
      }
      if (entries.length > 256) throw new Error(UNSAFE);
      for (const revision of entries) configurationGenerationComposeFile(infraDir, revision);
      return { conservative: entries, containers: {} };
    }
    throw error;
  }
}
function retainedConfigurationGenerations(infraDir: string): Set<string> {
  const retained = readGenerationRetention(infraDir);
  return new Set([...retained.conservative, ...Object.values(retained.containers).flat()]);
}
async function retainConfigurationGenerations(
  infraDir: string,
  owned?: CommitConfigurationOptions["ownedServiceGenerations"],
  observed?: readonly string[],
): Promise<void> {
  const previous = readGenerationRetention(infraDir);
  let retained = previous;
  if (owned) {
    if (
      owned.length > 256 ||
      new Set(owned.map((entry) => entry.containerId)).size !== owned.length
    )
      throw new Error(UNSAFE);
    if (
      observed &&
      (observed.length > 256 ||
        observed.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
        new Set(observed).size !== observed.length)
    )
      throw new Error(UNSAFE);
    // A missing verified claim is not evidence of cleanup. Retain previously
    // owned IDs still observed by Docker even when their image/provenance no longer verifies.
    const containers: Record<string, string[]> = Object.fromEntries(
      Object.entries(previous.containers).filter(([id]) => !observed || observed.includes(id)),
    );
    for (const entry of owned) {
      if (
        !/^[a-f0-9]{64}$/.test(entry.containerId) ||
        entry.revisionIds.some((id) => !REVISION.test(id))
      )
        throw new Error(UNSAFE);
      // Labels on a live immutable Docker ID do not change. Remember the first
      // resolved generation when older containers named the movable current alias.
      containers[entry.containerId] = previous.containers[entry.containerId] ?? [
        ...new Set(entry.revisionIds),
      ];
    }
    // Unobserved legacy/CLI generations have no per-container attribution.
    // Only a complete empty inventory proves that conservative group is unused.
    retained = { conservative: observed?.length === 0 ? [] : previous.conservative, containers };
  } else {
    const active = currentConfigurationGeneration(infraDir);
    if (active)
      retained = { ...previous, conservative: [...new Set([...previous.conservative, active])] };
  }
  if (new Set([...retained.conservative, ...Object.values(retained.containers).flat()]).size > 256)
    throw new Error(UNSAFE);
  const encoded = `${JSON.stringify(retained)}\n`;
  if (
    [...retained.conservative, ...Object.values(retained.containers).flat()].length > 512 ||
    Buffer.byteLength(encoded) > 64 * 1024
  )
    throw new Error(UNSAFE);
  const path = join(infraDir, RETAINED_GENERATIONS);
  // The generation writer is exclusive. A fixed staging name bounds crash leftovers.
  const temporary = `${path}.tmp`;
  try {
    const stat = lstatSync(temporary);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== (process.geteuid?.() ?? 0) ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 64 * 1024
    )
      throw new Error(UNSAFE);
    rmSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeDurable(temporary, encoded, 0o600);
    renameSync(temporary, path);
    await syncDirectory(infraDir);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Validate a retained generation with the same filesystem rules as the active pointer. */
export function configurationGenerationComposeFile(infraDir: string, revisionId: string): string {
  if (!REVISION.test(revisionId)) throw new Error(UNSAFE);
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  const root = lstatSync(generations);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== (process.geteuid?.() ?? 0) ||
    (root.mode & 0o777) !== 0o700
  )
    throw new Error(UNSAFE);
  const path = join(generations, revisionId);
  safeGenerationTree(path);
  return join(path, GENERATED_COMPOSE_FILE);
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
  if (entries.length > MAX_GENERATIONS + 256 + 8)
    throw new Error(`${generations} has too many entries`);
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
  const pointerName = new RegExp(`^\\.\\${CURRENT_CONFIGURATION}\\.[a-f0-9]{32}\\.tmp$`);
  for (const entry of readdirSync(infraDir, { withFileTypes: true })) {
    if (!pointerName.test(entry.name)) continue;
    const path = join(infraDir, entry.name);
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink() || stats.uid !== owner) throw new Error(UNSAFE);
    const target = readlinkSync(path);
    if (!new RegExp(`^${CONFIGURATION_GENERATIONS}/cfg1_[A-Za-z0-9_-]{43}$`).test(target)) {
      throw new Error(UNSAFE);
    }
    pointerTemporaries.push(path);
  }
  for (const path of [...temporaryPaths, ...pointerTemporaries]) rmSync(path, { recursive: true });
  if (temporaryPaths.length > 0) await syncDirectory(generations);
  if (pointerTemporaries.length > 0) await syncDirectory(infraDir);
  // Keep space for the next generation and prune only after every existing
  // entry has passed validation.
  const retained = retainedConfigurationGenerations(infraDir);
  const removable = complete
    .filter((entry) => entry.name !== active && !retained.has(entry.name))
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
 * Files outside the generation that follow it: Traefik's routes for the
 * enabled first-party services and the writable data directories Compose would
 * otherwise create as root.
 */
function writeStackFiles(
  infraDir: string,
  enabled: readonly LoadedService[],
  context: RenderContext,
  writableBindDirs: readonly string[],
): void {
  const rootDir = resolve(infraDir, "..", "..");
  const traefik = renderTraefikDynamicConfiguration(
    enabled.filter((service) => service.isBuiltIn).map((service) => service.manifest),
    {
      domain: context.domain,
      resolveProxyHost: (manifest) => resolveProxyHost(manifest, context),
    },
  );
  const routesDir = join(rootDir, "services", "traefik", "config", "dynamic");
  mkdirSync(routesDir, { recursive: true });
  const routes = join(routesDir, "generated-routes.yml");
  // Traefik watches the file, so it is replaced, never rewritten in place.
  writeFileSync(`${routes}.tmp`, renderTraefikDynamicYaml(traefik), "utf-8");
  renameSync(`${routes}.tmp`, routes);
  for (const dir of writableBindDirs) mkdirSync(dir, { recursive: true });
  // app-api bind-mounts `${OPENMAPX_HOST_DIR}/custom_integrations`, a path the
  // renderer cannot resolve. Left to Docker it is created root-owned on first
  // start, and the ops-agent then refuses to start on its next boot because
  // its authority scan only trusts directories owned by the checkout's user.
  mkdirSync(join(rootDir, "custom_integrations"), { recursive: true, mode: 0o755 });
}

export type RenderConfigurationOptions = Pick<
  CommitConfigurationOptions,
  "infraDir" | "services" | "integrationSchemas" | "input" | "allowMissingSelected"
>;

/**
 * What a generation would hold, without writing it: the compose preview and
 * every apply render through here.
 */
export function renderConfiguration(options: RenderConfigurationOptions) {
  const { infraDir, input } = options;
  const resolved = resolveInput(
    options.services,
    options.integrationSchemas,
    input,
    options.allowMissingSelected ?? false,
  );
  const context: RenderContext = {
    domain: input.domain,
    composeOutDir: join(infraDir, CURRENT_CONFIGURATION),
    infraDir,
    allServices: resolved.allServices,
    resolvedServiceConfigs: resolved.serviceConfigs,
    serviceConfigEnvKeys: resolved.serviceConfigEnvKeys,
    serviceSecretKeys: new Map(
      [...resolved.serviceSecrets].map(([id, values]) => [id, Object.keys(values)]),
    ),
  };
  return { resolved, context, rendered: renderCompose(resolved.enabled, context) };
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
  const { resolved, context, rendered } = renderConfiguration(options);
  const generations = join(infraDir, CONFIGURATION_GENERATIONS);
  await retainConfigurationGenerations(
    infraDir,
    options.ownedServiceGenerations,
    options.observedServiceContainerIds,
  );
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
      const pointerTemporary = join(infraDir, `.${CURRENT_CONFIGURATION}.${nonce}.tmp`);
      symlinkSync(join(CONFIGURATION_GENERATIONS, revisionId), pointerTemporary);
      renameSync(pointerTemporary, join(infraDir, CURRENT_CONFIGURATION));
      // The rename is the commit point. Record evidence BEFORE any fallible sync/follow-up.
      committed = {
        revisionId,
        enabledServiceIds: resolved.enabledIdsOrdered,
        warnings: rendered.warnings ?? [],
      };
      await syncDirectory(infraDir);
    } else {
      committed = {
        revisionId,
        enabledServiceIds: resolved.enabledIdsOrdered,
        warnings: rendered.warnings ?? [],
      };
    }
    writeStackFiles(infraDir, resolved.enabled, context, rendered.writableBindDirs ?? []);
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
