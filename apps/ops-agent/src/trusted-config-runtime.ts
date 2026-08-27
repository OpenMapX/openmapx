import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import type { OpsRuntime, OpsTrustedClaim } from "./runtime";
import { validateTrustedConfigurationValues } from "./trusted-config-schema";

const GENERATIONS = ".trusted-config-generations";
const CURRENT = ".trusted-config-current";
const MAX_GENERATIONS = 16;
const MAX_GENERATION_BYTES = 2 * 1024 * 1024;
const FAILED = "Trusted configuration apply failed";
type TrustedConfigurationOperation = Extract<OpsOperation, { revisionId: string }>;

export interface TrustedConfigurationRuntimeOptions {
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
  loadAuthority?: () => Promise<TrustedConfigurationAuthoritySnapshot>;
  infraDir: string;
  beforeCommit?: () => Promise<void>;
  afterGenerationRename?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

export interface TrustedConfigurationAuthoritySnapshot {
  revisionId: string;
  services: readonly coreServices.LoadedService[];
  integrationSchemas: ReadonlyMap<string, Record<string, unknown>>;
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
  values: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  controlledKeys: Iterable<string> = [],
): void {
  if (!validateTrustedConfigurationValues(values, schema, controlledKeys)) throw new Error(FAILED);
}

function validateAndResolve(
  options: TrustedConfigurationRuntimeOptions,
  payload: TrustedConfigurationPayload,
  authority?: TrustedConfigurationAuthoritySnapshot,
) {
  const services = authority?.services ?? options.services;
  const integrationSchemas = authority?.integrationSchemas ?? options.integrationSchemas;
  const serviceById = new Map(services.map((service) => [service.manifest.id, service]));
  const expanded = coreServices.expandServiceSelection([...services], payload.selectedRoots, {
    allowMissingSelected: false,
  });
  if (expanded.missingIds.length > 0) throw new Error(FAILED);
  const enabledIds = new Set(expanded.enabledIds);
  const allServices = services.map((service) => ({
    ...service,
    enabled: enabledIds.has(service.manifest.id),
  }));
  const enabled = allServices.filter((service) => service.enabled);
  const serviceConfigs = new Map<string, Record<string, unknown>>();
  for (const entry of payload.serviceConfigs) {
    const service = serviceById.get(entry.serviceId);
    if (!service || !enabledIds.has(entry.serviceId)) throw new Error(FAILED);
    validateConfig(entry.values, service.manifest.configSchema);
    serviceConfigs.set(entry.serviceId, entry.values);
  }
  for (const entry of payload.integrationConfigs) {
    const schema = integrationSchemas.get(entry.integrationId);
    if (!schema) throw new Error(FAILED);
    validateConfig(entry.values, schema, ["enabled"]);
  }
  const appApi = allServices.find(
    (service) => service.enabled && service.manifest.id === "app-api",
  );
  if (appApi) {
    const passthroughKeys: string[] = [];
    for (const service of allServices) {
      const prefix = coreServices.serviceConfigEnvPrefix(service.manifest.id);
      for (const { key } of coreServices.configSchemaKeys(service.manifest.configSchema)) {
        passthroughKeys.push(`${prefix}${key.toUpperCase()}`);
      }
    }
    for (const [integrationId, schema] of integrationSchemas) {
      const id = integrationId.replaceAll("-", "_").toUpperCase();
      for (const { key } of coreServices.configSchemaKeys(schema)) {
        passthroughKeys.push(`INTEGRATION_${id}_${key.replaceAll("-", "_").toUpperCase()}`);
      }
    }
    serviceConfigs.set(
      "app-api",
      coreServices.buildAppApiServiceEnv(
        enabled,
        serviceConfigs.get("app-api") ?? {},
        {},
        passthroughKeys,
      ),
    );
  }
  const serviceSecrets = new Map<string, Record<string, string>>();
  for (const entry of payload.serviceSecrets) {
    const service = serviceById.get(entry.serviceId);
    if (!service || !enabledIds.has(entry.serviceId)) throw new Error(FAILED);
    const properties = schemaProperties(service.manifest.configSchema);
    for (const key of Object.keys(entry.values)) {
      if (properties[key]?.["x-openmapx-secret"] !== true) throw new Error(FAILED);
    }
    serviceSecrets.set(entry.serviceId, entry.values);
  }
  return { allServices, enabled, serviceConfigs, serviceSecrets };
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

function safeGenerationTree(path: string): { entries: number; bytes: number } {
  const owner = process.geteuid?.() ?? 0;
  const rootStats = lstatSync(path);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    rootStats.uid !== owner ||
    (rootStats.mode & 0o777) !== 0o700
  ) {
    throw new Error(FAILED);
  }
  let entries = 1;
  let bytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 1024) throw new Error(FAILED);
      const child = join(directory, entry.name);
      const stats = lstatSync(child);
      if (stats.uid !== owner || stats.isSymbolicLink()) throw new Error(FAILED);
      if (stats.isDirectory()) {
        if ((stats.mode & 0o777) !== 0o700) throw new Error(FAILED);
        visit(child);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1 || ![0o400, 0o600].includes(stats.mode & 0o777))
          throw new Error(FAILED);
        bytes += stats.size;
      } else throw new Error(FAILED);
      if (bytes > MAX_GENERATION_BYTES) throw new Error(FAILED);
    }
  };
  visit(path);
  return { entries, bytes };
}

function generationDigest(path: string): string {
  safeGenerationTree(path);
  const digest = createHash("sha256").update("openmapx-trusted-generation-v1\0");
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = lstatSync(child);
      digest
        .update(entry.isDirectory() ? "d\0" : "f\0")
        .update(relative)
        .update("\0");
      digest.update(String(stats.mode & 0o777)).update("\0");
      if (entry.isDirectory()) visit(child, relative);
      else digest.update(readFileSync(child)).update("\0");
    }
  };
  visit(path);
  return digest.digest("base64url");
}

function currentGeneration(infraDir: string): string | null {
  const current = join(infraDir, CURRENT);
  try {
    const stats = lstatSync(current);
    if (!stats.isSymbolicLink()) throw new Error();
    const target = readlinkSync(current);
    if (!new RegExp(`^${GENERATIONS}/cfg1_[A-Za-z0-9_-]{43}$`).test(target)) throw new Error();
    const absolute = resolve(infraDir, target);
    if (!absolute.startsWith(`${resolve(infraDir, GENERATIONS)}/`)) throw new Error();
    safeGenerationTree(absolute);
    return basename(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(current);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null;
      }
    }
    throw new Error(FAILED);
  }
}

function hasTrustedGenerationEvidence(infraDir: string): boolean {
  const generations = join(infraDir, GENERATIONS);
  try {
    const metadata = lstatSync(generations);
    const owner = process.geteuid?.() ?? 0;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o777) !== 0o700
    ) {
      throw new Error();
    }
    return readdirSync(generations).some((name) => /^cfg1_[A-Za-z0-9_-]{43}$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(FAILED);
  }
}

export function readTrustedEnabledServiceIds(
  infraDir: string,
  services: readonly coreServices.LoadedService[],
): ReadonlySet<string> | null {
  const active = currentGeneration(infraDir);
  if (!active) {
    if (hasTrustedGenerationEvidence(infraDir)) throw new Error(FAILED);
    return null;
  }
  try {
    const path = join(infraDir, GENERATIONS, active, "service-selection.json");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64 * 1024) throw new Error();
    const raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)),
    ) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1) {
      throw new Error();
    }
    const selected = (raw as { selected?: unknown }).selected;
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string"))
      throw new Error();
    const expanded = coreServices.expandServiceSelection([...services], selected, {
      allowMissingSelected: false,
    });
    if (expanded.missingIds.length > 0) throw new Error();
    return new Set(expanded.enabledIds);
  } catch {
    throw new Error(FAILED);
  }
}

export async function initializeTrustedConfigurationRuntime(infraDir: string): Promise<void> {
  const generations = join(infraDir, GENERATIONS);
  try {
    lstatSync(generations);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(FAILED);
    mkdirSync(generations, { mode: 0o700 });
  }
  const generationRoot = lstatSync(generations);
  const owner = process.geteuid?.() ?? 0;
  if (
    !generationRoot.isDirectory() ||
    generationRoot.isSymbolicLink() ||
    generationRoot.uid !== owner ||
    (generationRoot.mode & 0o777) !== 0o700
  )
    throw new Error(FAILED);
  const active = currentGeneration(infraDir);
  const entries = readdirSync(generations, { withFileTypes: true });
  if (entries.length > MAX_GENERATIONS + 8) throw new Error(FAILED);
  const temporaryPaths: string[] = [];
  const complete: Array<{ name: string; path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(generations, entry.name);
    if (/^\.cfg1_[A-Za-z0-9_-]{43}\.[a-f0-9]{32}\.tmp$/.test(entry.name)) {
      safeGenerationTree(path);
      temporaryPaths.push(path);
      continue;
    }
    if (!/^cfg1_[A-Za-z0-9_-]{43}$/.test(entry.name)) throw new Error(FAILED);
    safeGenerationTree(path);
    complete.push({ name: entry.name, path, mtimeMs: lstatSync(path).mtimeMs });
  }
  const pointerTemporaries: string[] = [];
  for (const entry of readdirSync(infraDir, { withFileTypes: true })) {
    if (!/^\.\.trusted-config-current\.[a-f0-9]{32}\.tmp$/.test(entry.name)) continue;
    const path = join(infraDir, entry.name);
    const stats = lstatSync(path);
    const owner = process.geteuid?.() ?? 0;
    if (!stats.isSymbolicLink() || stats.uid !== owner) throw new Error(FAILED);
    const target = readlinkSync(path);
    if (!new RegExp(`^${GENERATIONS}/cfg1_[A-Za-z0-9_-]{43}$`).test(target))
      throw new Error(FAILED);
    pointerTemporaries.push(path);
  }
  for (const path of [...temporaryPaths, ...pointerTemporaries]) rmSync(path, { recursive: true });
  if (temporaryPaths.length > 0) await syncDirectory(generations);
  if (pointerTemporaries.length > 0) await syncDirectory(infraDir);
  // Keep space for the next generation and prune only after every existing
  // entry has passed validation. The active generation is never a candidate.
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
  if (active && !existsSync(join(generations, active))) throw new Error(FAILED);
}

async function commitGeneration(
  options: TrustedConfigurationRuntimeOptions,
  operation: TrustedConfigurationOperation,
  payload: TrustedConfigurationPayload,
  claim: OpsTrustedClaim,
): Promise<{ revisionId: string }> {
  let temporary: string | undefined;
  let committed = false;
  try {
    const authority = await options.loadAuthority?.();
    if (
      authority &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.revisionId) ||
        claim.capability.values.authorityRevision !== authority.revisionId)
    ) {
      throw new Error(FAILED);
    }
    const resolved = validateAndResolve(options, payload, authority);
    const revisionId = operation.revisionId;
    const generations = join(options.infraDir, GENERATIONS);
    await initializeTrustedConfigurationRuntime(options.infraDir);
    const finalGeneration = join(generations, revisionId);
    const nonce = randomUUID().replaceAll("-", "");
    temporary = join(generations, `.${revisionId}.${nonce}.tmp`);
    mkdirSync(temporary, { mode: 0o700 });
    const rendered = coreServices.renderCompose(resolved.enabled, {
      domain: payload.domain,
      composeOutDir: join(options.infraDir, CURRENT),
      infraDir: options.infraDir,
      allServices: resolved.allServices,
      resolvedServiceConfigs: resolved.serviceConfigs,
      serviceSecretKeys: new Map(
        [...resolved.serviceSecrets].map(([id, values]) => [id, Object.keys(values)]),
      ),
    });
    await writeDurable(
      join(temporary, "docker-compose.generated.yml"),
      rendered.composeYaml,
      0o600,
    );
    await writeDurable(
      join(temporary, "docker-compose.generated.hardlinks.json"),
      `${JSON.stringify(rendered.hardlinkPlan, null, 2)}\n`,
      0o600,
    );
    await writeDurable(
      join(temporary, "service-selection.json"),
      `${JSON.stringify({ selected: payload.selectedRoots }, null, 2)}\n`,
      0o600,
    );
    await writeDurable(
      join(temporary, "resolved-config.generated.json"),
      `${JSON.stringify({
        serviceConfigs: payload.serviceConfigs,
        integrationConfigs: payload.integrationConfigs,
      })}\n`,
      0o600,
    );
    const populatedSecrets = [...resolved.serviceSecrets].filter(
      ([, values]) => Object.keys(values).length > 0,
    );
    if (populatedSecrets.length > 0) {
      const secretsRoot = join(temporary, ".generated-secrets");
      mkdirSync(secretsRoot, { mode: 0o700 });
      for (const [serviceId, values] of populatedSecrets) {
        const serviceDirectory = join(secretsRoot, serviceId);
        mkdirSync(serviceDirectory, { mode: 0o700 });
        for (const [key, value] of Object.entries(values)) {
          await writeDurable(join(serviceDirectory, key), value, 0o400);
        }
        await syncDirectory(serviceDirectory);
      }
      await syncDirectory(secretsRoot);
    }
    await syncDirectory(temporary);
    await options.beforeCommit?.();
    if (existsSync(finalGeneration)) {
      if (generationDigest(finalGeneration) !== generationDigest(temporary))
        throw new Error(FAILED);
      rmSync(temporary, { recursive: true });
      temporary = undefined;
    } else {
      renameSync(temporary, finalGeneration);
      temporary = undefined;
      await syncDirectory(generations);
      await options.afterGenerationRename?.();
    }
    if (currentGeneration(options.infraDir) === revisionId) {
      await options.afterCommit?.();
      return { revisionId };
    }
    const pointerTemporary = join(options.infraDir, `.${CURRENT}.${nonce}.tmp`);
    symlinkSync(join(GENERATIONS, revisionId), pointerTemporary);
    renameSync(pointerTemporary, join(options.infraDir, CURRENT));
    committed = true;
    await syncDirectory(options.infraDir);
    await options.afterCommit?.();
    return { revisionId };
  } catch {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (!committed) {
      // A fully staged immutable generation without the current-pointer swap is
      // inert and is validated/cleaned by startup reconciliation.
    }
    throw new Error(FAILED);
  }
}

function trustedPayload(
  operation: TrustedConfigurationOperation,
  context: Parameters<OpsRuntime["stack.render"]>[1],
): TrustedConfigurationPayload {
  const snapshot = context.claim.capability.trustedConfiguration;
  if (
    context.claim.source !== "trusted-data" ||
    context.claim.capability.revisionId !== operation.revisionId ||
    !snapshot ||
    opsOperationFingerprint(context.claim.operation) !== opsOperationFingerprint(operation)
  ) {
    throw new Error(FAILED);
  }
  return snapshot as TrustedConfigurationPayload;
}

export function installTrustedConfigurationRuntime(
  runtime: OpsRuntime,
  options: TrustedConfigurationRuntimeOptions,
): void {
  const apply = async (
    operation: TrustedConfigurationOperation,
    context: Parameters<OpsRuntime["stack.render"]>[1],
  ) => commitGeneration(options, operation, trustedPayload(operation, context), context.claim);
  runtime["stack.render"] = apply;
  runtime["serviceSelection.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["serviceConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceConfigs.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["integrationConfig.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (
      !payload.integrationConfigs.some((entry) => entry.integrationId === operation.integrationId)
    ) {
      throw new Error(FAILED);
    }
    return commitGeneration(options, operation, payload, context.claim);
  };
  runtime["vault.apply"] = async (operation, context) => {
    const payload = trustedPayload(operation, context);
    if (!payload.serviceSecrets.some((entry) => entry.serviceId === operation.serviceId))
      throw new Error(FAILED);
    return commitGeneration(options, operation, payload, context.claim);
  };
}
