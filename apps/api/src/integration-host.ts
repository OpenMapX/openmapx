import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ActivationTransactionScope,
  type CacheClient,
  type CustomHealthCheckFn,
  createActivationTransactionScope,
  type HttpClient,
  type IntegrationContext,
  type IntegrationDataSource,
  IntegrationEventBus,
  type IntegrationLoadError,
  type IntegrationManifest,
  type IntegrationStrings,
  type LoadedIntegration,
  type Logger,
  ORCHESTRATOR_BY_DOMAIN,
  orchestratorOf,
  PLATFORM_VERSION,
  providerOrderFingerprintInput,
  readProviderOrder,
  resolveIntegrationPlatformEndpoint,
  satisfiesPlatformVersion,
  validateDataSource,
  validateManifest,
} from "@openmapx/integration-framework";
import {
  integrationBackendBundlePath,
  resolveLayerSelectorPreview,
} from "@openmapx/integration-framework/installer";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import {
  beginPlaceResolverStaging,
  commitPlaceResolverStaging,
  restorePlaceResolvers,
  rollbackPlaceResolverStaging,
  setPlaceResolverRegistrationHook,
  snapshotPlaceResolvers,
} from "@openmapx/place-ids";
import type { FastifyInstance } from "fastify";
import { integrationSql } from "./db";
import { assertBundleImports } from "./integration-bundle-imports";
import { createCacheClient, createHttpClient, createLogger } from "./integration-clients";
import { type IntegrationCodeCache, prepareIntegrationCodeCache } from "./integration-code-cache";
import {
  type ConfigSource,
  type ConfigValueWithSource,
  resolveConfigWithSources,
  resolveIntegrationConfigWithSourcesStrict,
  warnInvalidConfig,
} from "./integration-config";
import { createIntegrationDb } from "./integration-db";
import { readIntegrationFile, setVerifiedIntegrationFiles } from "./integration-files";
import { createProviderRegistrars, type ProviderRegistrars } from "./integration-registrars";
import {
  beginIntegrationRouteStaging,
  commitIntegrationRouteStaging,
  dropIntegrationRoutes,
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
  rollbackIntegrationRouteStaging,
} from "./integration-routes";
import {
  bindPlaceResolverToScope,
  bindProviderToScope,
  currentIntegrationScope,
  type IntegrationScope,
  ignoredAfterUnload,
  runInIntegrationScope,
  SETUP_DEADLINE_MS,
  SETUP_WARNING_MS,
} from "./integration-scope";
import { processLogger } from "./process-logger";
import { redis } from "./redis";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./services/administrative-configuration-context";
import {
  AttributionIndex,
  defaultMotisLicenseFile,
  getAttributionIndex,
  setAttributionIndex,
} from "./services/attribution";
import type { ManifestDataSource } from "./services/attribution/types";
import { loadAllBindingsByIntegration } from "./services/capability-bindings";
import {
  executeAllIntegrationHealthChecks,
  getCachedIntegrationHealthSnapshot,
} from "./services/integration-health";
import {
  integrationRuntimeEvidence,
  stageIntegrationRuntimeEvidence,
} from "./services/integration-runtime-evidence";
import { getMetricsRecorder } from "./services/metrics/recorder";
import { cursorCodecFromEnvironment } from "./services/opaque-cursor";
import {
  getProviderHealth,
  ProviderHealth,
  setProviderHealth,
} from "./services/provider-health/registry";
import { getSecret, secretsKeyProblem } from "./services/secrets";
import { getServiceRegistry, resolveRequiresForIntegration } from "./services/service-registry";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "./services/upstream-runtime";

export type { ConfigSource, ConfigValueWithSource };
export { resolveConfigWithSources };

type SetupFunction = (ctx: IntegrationContext) => void | Promise<void>;

let eventBus = new IntegrationEventBus();
const integrations = new Map<string, LoadedIntegration>();
/** The live generation's `providerOrder` of each orchestrator integration, by its id. */
let providerOrders: ReadonlyMap<string, readonly string[]> = new Map();

const ORCHESTRATOR_IDS = new Set(
  Object.values(ORCHESTRATOR_BY_DOMAIN).filter((id): id is string => id !== null),
);

/** The live generation's provider order for `domain`; empty for a domain without an orchestrator. */
export function getProviderOrder(domain: string): readonly string[] {
  const orchestrator = orchestratorOf(domain);
  return orchestrator ? (providerOrders.get(orchestrator) ?? []) : [];
}

export type IntegrationDirectoryInput = string | { directory: string; isBuiltIn: boolean };
type NormalizedIntegrationDirectory = { directory: string; isBuiltIn: boolean };

/** A read of the current host registry, never a projection of saved bindings. */
export function inspectIntegrationRuntime(integrationId: string) {
  return integrationRuntimeEvidence(integrations.get(integrationId));
}

// Stored for reload support
// biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
let _fastify: FastifyInstance<any, any, any, any> | null = null;
let _integrationDirs: NormalizedIntegrationDirectory[] = [];

function normalizeIntegrationDirs(
  dirs: IntegrationDirectoryInput[],
): NormalizedIntegrationDirectory[] {
  return dirs.map((entry) =>
    typeof entry === "string"
      ? { directory: entry, isBuiltIn: !entry.includes("custom_integrations") }
      : entry,
  );
}

/** An installed integration the operations agent reports intact, with the digests of its files. */
export interface AgentInstalledIntegration {
  integrationId: string;
  files: ReadonlyArray<{ path: string; sha256: string }>;
}

/**
 * The installed integrations the operations agent reports loadable, injected
 * by app.ts. It resolves to null when no agent is configured (host
 * development); the custom directories are then scanned as they are.
 */
let installedIntegrationResolver:
  | (() => Promise<readonly AgentInstalledIntegration[] | null>)
  | null = null;

export function setInstalledIntegrationResolver(
  fn: (() => Promise<readonly AgentInstalledIntegration[] | null>) | null,
): void {
  installedIntegrationResolver = fn;
}

async function resolveInstalledIntegrations(): Promise<
  readonly AgentInstalledIntegration[] | null
> {
  if (!installedIntegrationResolver) return null;
  try {
    return await installedIntegrationResolver();
  } catch (error) {
    // Unknown is not "scan the directory": load none of them.
    _fastify?.log.warn(error, "Installed integrations are unavailable; none are loaded");
    return [];
  }
}

function parseManifest(bytes: Buffer | null): ReturnType<typeof JSON.parse> | null {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch {
    return null;
  }
}

async function discoverManifests(
  dirs: NormalizedIntegrationDirectory[],
): Promise<
  Array<{ manifest: ReturnType<typeof JSON.parse>; directory: string; isBuiltIn: boolean }>
> {
  const results: Array<{
    manifest: ReturnType<typeof JSON.parse>;
    directory: string;
    isBuiltIn: boolean;
  }> = [];

  // With an operations agent, an installed directory is loaded only when the
  // agent reports it intact, and each file read from it is verified against
  // the digests the agent recorded.
  const installed = dirs.some((dir) => !dir.isBuiltIn)
    ? await resolveInstalledIntegrations()
    : null;
  const verifiedRoots = installed
    ? dirs.filter((dir) => !dir.isBuiltIn).map((dir) => dir.directory)
    : [];
  const verified = new Map<string, AgentInstalledIntegration["files"]>();
  for (const root of verifiedRoots) {
    for (const entry of installed ?? [])
      verified.set(resolve(root, entry.integrationId), entry.files);
  }
  setVerifiedIntegrationFiles(verifiedRoots, verified);

  for (const { directory: baseDir, isBuiltIn } of dirs) {
    if (!isBuiltIn && installed) {
      for (const { integrationId } of installed) {
        const directory = resolve(baseDir, integrationId);
        const manifest = parseManifest(readIntegrationFile(directory, "manifest.json"));
        if (!manifest) {
          _fastify?.log.warn(
            { integrationId },
            `Skipping installed integration ${integrationId}: its manifest.json is not the one the operations agent installed`,
          );
          continue;
        }
        results.push({ manifest, directory, isBuiltIn });
      }
      continue;
    }
    if (!existsSync(baseDir)) continue;

    const entries = readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue;
      const manifestPath = join(baseDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        results.push({
          manifest: raw,
          directory: resolve(baseDir, entry.name),
          isBuiltIn,
        });
      } catch {
        // skip invalid JSON
      }
    }
  }

  return results;
}

function loadStrings(directory: string): IntegrationStrings {
  const stringsDir = join(directory, "strings");
  const strings: IntegrationStrings = {};
  if (!existsSync(stringsDir)) return strings;
  try {
    for (const file of readdirSync(stringsDir)) {
      if (!file.endsWith(".json")) continue;
      const locale = file.replace(".json", "");
      const bytes = readIntegrationFile(directory, join("strings", file));
      if (!bytes) continue;
      const content = JSON.parse(bytes.toString("utf-8"));
      if (content && typeof content === "object") {
        strings[locale] = content;
      }
    }
  } catch {
    // skip unreadable strings
  }
  return strings;
}

function resolveBuiltInBackendEntryPoint(directory: string): string | null {
  const bundled = integrationBackendBundlePath(directory);
  if (existsSync(bundled)) return bundled;
  const modulePath = join(directory, "index.ts");
  const jsModulePath = join(directory, "index.js");
  if (existsSync(modulePath)) return modulePath;
  return existsSync(jsModulePath) ? jsModulePath : null;
}

/** The only backend entry an installed integration can declare. */
const INSTALLED_BACKEND_ENTRY = "dist/backend/index.mjs";

let codeCache: IntegrationCodeCache | null = null;

/**
 * Prepared on first use after each boot rather than at boot, so a host
 * without installed backend code never touches the cache directory.
 */
function integrationCodeCache(): IntegrationCodeCache {
  codeCache ??= prepareIntegrationCodeCache();
  return codeCache;
}

/**
 * The `file:` URL of an installed integration's verified backend bundle in the
 * code cache, or null when its manifest declares no backend entry. Only bytes
 * the operations agent recorded are read, and the URL is keyed by their
 * SHA-256, so unchanged bytes reuse the module Node already holds and new
 * bytes get a fresh one.
 */
async function installedBackendImportSpecifier(
  integration: LoadedIntegration,
): Promise<string | null> {
  if (integration.manifest.backend?.entry !== INSTALLED_BACKEND_ENTRY) return null;
  const bytes = readIntegrationFile(integration.directory, INSTALLED_BACKEND_ENTRY);
  if (!bytes) throw new Error("backend entry is missing or changed since installation");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assertBundleImports(bytes, sha256);
  return pathToFileURL(integrationCodeCache().materialize(integration.id, sha256, bytes)).href;
}

// Cache-bust a built-in's dynamic import by the entry file's mtime+size so a
// reload (`reloadIntegrations` — fired by extension install/update and credential
// set/delete) picks up CHANGED backend code WITHOUT restarting the API. ESM
// `import()` is keyed by URL and process-lifetime cached, so re-importing the
// same file URL returns the stale module — which is why a store update of an
// integration whose bundle path is unchanged otherwise silently keeps running
// the old code until a restart.
//
// Keying the bust on mtime+size (in dev AND prod) means an UNCHANGED file
// reuses the same URL → the cached module is returned, no new module is created;
// only a CHANGED file mints a new URL → a fresh import. The cost is that ESM
// modules are never garbage-collected, so each new URL leaks its (tiny,
// self-contained) module graph for the process lifetime — but the leak is now
// bounded to one module per actual code change (reloads with no code change,
// e.g. a credential rotation, reuse the cached URL and leak nothing), which over
// a process lifetime is negligible and well worth not requiring a restart.
function backendEntryImportSpecifier(entryPoint: string): string {
  const url = pathToFileURL(entryPoint);
  try {
    const stats = statSync(entryPoint);
    url.searchParams.set("v", `${stats.mtimeMs}-${stats.size}`);
  } catch {
    url.searchParams.set("v", Date.now().toString());
  }
  return url.href;
}

type DiscoveredEntry = {
  manifest: Record<string, unknown>;
  directory: string;
  isBuiltIn: boolean;
};

function topologicalSort(entries: DiscoveredEntry[]): DiscoveredEntry[] {
  const byId = new Map<string, DiscoveredEntry>();
  for (const entry of entries) {
    const id = entry.manifest.id as string;
    if (!id) continue;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, entry);
      continue;
    }

    if (!existing.isBuiltIn && entry.isBuiltIn) {
      byId.set(id, entry);
      processLogger.warn(
        { component: "integration-host", integrationId: id },
        "Ignoring a duplicate integration id: the community integration was replaced by the built-in integration",
      );
      continue;
    }

    const reason =
      existing.isBuiltIn && !entry.isBuiltIn
        ? "community integration was ignored in favor of the built-in integration"
        : "the later integration was ignored";
    processLogger.warn(
      { component: "integration-host", integrationId: id },
      `Ignoring a duplicate integration id: ${reason}`,
    );
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const skipped = new Set<string>();
  const result: DiscoveredEntry[] = [];

  function visit(id: string) {
    if (visited.has(id) || skipped.has(id)) return;
    if (inStack.has(id)) {
      processLogger.warn(
        { component: "integration-host", integrationId: id },
        "Skipping an integration in a dependency cycle",
      );
      skipped.add(id);
      return;
    }
    inStack.add(id);
    const entry = byId.get(id);
    if (!entry) {
      inStack.delete(id);
      return;
    }
    const deps = (entry.manifest.dependencies ?? []) as string[];
    for (const dep of deps) {
      if (!byId.has(dep)) {
        processLogger.warn(
          { component: "integration-host", integrationId: id, dependency: dep },
          "Skipping an integration whose required integration is not installed",
        );
        skipped.add(id);
        inStack.delete(id);
        return;
      }
      visit(dep);
      if (skipped.has(dep)) {
        processLogger.warn(
          { component: "integration-host", integrationId: id, dependency: dep },
          "Skipping an integration because its dependency was skipped",
        );
        skipped.add(id);
        inStack.delete(id);
        return;
      }
    }
    inStack.delete(id);
    visited.add(id);
    result.push(entry);
  }

  for (const entry of entries) visit(entry.manifest.id as string);
  return result;
}

function collectManifestDataSources(
  entries: Array<{ manifest: Record<string, unknown> }>,
): ManifestDataSource[] {
  const out: ManifestDataSource[] = [];
  for (const { manifest } of entries) {
    const dataSources = manifest.dataSources;
    if (!Array.isArray(dataSources)) continue;
    for (const ds of dataSources) {
      if (!ds || typeof ds !== "object") continue;
      const row = ds as Record<string, unknown>;
      if (typeof row.sourceId !== "string" || typeof row.name !== "string") continue;
      out.push({
        sourceId: row.sourceId,
        name: row.name,
        url: typeof row.url === "string" ? row.url : undefined,
        licensing: parseLicensing(row.licensing),
        attribution: typeof row.attribution === "string" ? row.attribution : undefined,
        commercialUse:
          typeof row.commercialUse === "string"
            ? (row.commercialUse as ManifestDataSource["commercialUse"])
            : undefined,
        providerCountry: typeof row.providerCountry === "string" ? row.providerCountry : undefined,
        providerPrivacyUrl:
          typeof row.providerPrivacyUrl === "string" ? row.providerPrivacyUrl : undefined,
        endUserExposure:
          typeof row.endUserExposure === "string"
            ? (row.endUserExposure as ManifestDataSource["endUserExposure"])
            : undefined,
        personalData: typeof row.personalData === "boolean" ? row.personalData : undefined,
        cookies: typeof row.cookies === "boolean" ? row.cookies : undefined,
        dpaAvailable: typeof row.dpaAvailable === "boolean" ? row.dpaAvailable : undefined,
      });
    }
  }
  return out;
}

function manifestDeclaresSecretFields(manifest: IntegrationManifest): boolean {
  const schema = manifest.configSchema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  if (!props) return false;
  for (const value of Object.values(props)) {
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>)["x-openmapx-secret"] === true
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `ctx.db` on the integration pool when the manifest requires PostGIS (via
 * `requires: [{ service: "postgis" }]`); `undefined` otherwise. Shared by cold
 * start and reload.
 */
function buildIntegrationDb(manifest: IntegrationManifest): IntegrationContext["db"] {
  const needsDb = manifest.requires?.some((r) => r.service === "postgis");
  return needsDb ? createIntegrationDb(integrationSql) : undefined;
}

/**
 * Assembles the `IntegrationContext` passed to an integration's `setup()`.
 * The register* methods, event-bus wiring, and shutdown handling are identical
 * for cold start (`initIntegrations`) and reload (`reloadIntegrations`); only
 * the resolved `requiresMap`, per-integration clients, and target `integration`
 * record differ, so the caller supplies those.
 */
/**
 * Resolver for the data-use policy's disallowed source set, injected by the host
 * app (app.ts) to avoid a static import cycle with the policy service. The
 * IntegrationContext exposes it to orchestrators via `getDisallowedSourceIds`.
 */
let disallowedSourceResolver: (() => Promise<Set<string>>) | null = null;

export function setDisallowedSourceResolver(fn: () => Promise<Set<string>>): void {
  disallowedSourceResolver = fn;
}

/** Policy authority is injected alongside source filtering to avoid a host/service cycle. */
let roadConditionsPolicyResolver: NonNullable<
  IntegrationContext["getRoadConditionsPolicySnapshot"]
> | null = null;

export function setRoadConditionsPolicyResolver(
  fn: NonNullable<IntegrationContext["getRoadConditionsPolicySnapshot"]>,
): void {
  roadConditionsPolicyResolver = fn;
}

/**
 * Resolver for the data-use policy's disallowed *integration* set (every data
 * source fully gated), injected by app.ts alongside the source resolver. The
 * IntegrationContext exposes it via `getDisallowedIntegrationIds` for transit /
 * knowledge orchestrators that key on the integration rather than a `source` field.
 */
let disallowedIntegrationResolver: (() => Promise<Set<string>>) | null = null;

export function setDisallowedIntegrationResolver(fn: () => Promise<Set<string>>): void {
  disallowedIntegrationResolver = fn;
}

/**
 * Hook run whenever the live registry's data sources change — after
 * `reloadIntegrations` rebuilds the registry and after a live integration's
 * `ctx.setDataSources()`. Injected by app.ts to drop caches derived from
 * the source set — chiefly the data-use policy's memoized gated
 * source/integration sets, which are computed from `getAllIntegrations()` and
 * would otherwise stay stale until their own TTL. Injected (not imported) to
 * avoid a static cycle with the policy service.
 */
let integrationSourcesChangedHook: (() => void) | null = null;

export function setIntegrationSourcesChangedHook(fn: () => void): void {
  integrationSourcesChangedHook = fn;
}

function runIntegrationSourcesChangedHook(): void {
  try {
    integrationSourcesChangedHook?.();
  } catch (err) {
    _fastify?.log.warn(err, "Integration sources-changed hook failed");
  }
}

let attributionRefresh: Promise<void> = Promise.resolve();

/**
 * Re-index attribution from the data sources of the live registry, which
 * includes the lists runtime integrations supplied through
 * `ctx.setDataSources()`. Serialized, and each run reads the registry when it
 * starts, so a slow earlier refresh never overwrites a later one.
 */
function refreshAttributionFromRegistry(): Promise<void> {
  attributionRefresh = attributionRefresh.then(async () => {
    const index = getAttributionIndex();
    if (!index) return;
    index.setIntegrationManifests(
      collectManifestDataSources(
        Array.from(integrations.values(), (integration) => ({
          manifest: integration.manifest as unknown as Record<string, unknown>,
        })),
      ),
    );
    try {
      await index.reload();
    } catch (err) {
      _fastify?.log.warn(err, "AttributionIndex reload failed");
    }
  });
  return attributionRefresh;
}

/** The live integration other than `id` that declares `sourceId`, if any. */
function otherDeclarer(id: string, sourceId: string): string | undefined {
  for (const other of integrations.values()) {
    if (other.id === id) continue;
    if (other.manifest.dataSources?.some((ds) => ds.sourceId === sourceId)) return other.id;
  }
  return undefined;
}

/**
 * Validate and install a runtime integration's data sources and return the
 * ones accepted. A source that fails the manifest rules, repeats a sourceId,
 * or carries a sourceId another live integration already declares is dropped
 * with a warning naming it. Only a live integration triggers the refreshes:
 * one still being set up is covered by the refresh that follows its
 * generation's activation.
 */
function setRuntimeDataSources(
  integration: LoadedIntegration,
  log: Logger,
  list: IntegrationDataSource[],
): IntegrationDataSource[] {
  const { manifest } = integration;
  if (manifest.runtimeDataSources !== true) {
    throw new Error(
      `Integration ${integration.id} cannot call setDataSources: its manifest does not set runtimeDataSources`,
    );
  }
  if (!Array.isArray(list)) {
    throw new Error(`Integration ${integration.id}: setDataSources expects an array`);
  }
  const accepted: IntegrationDataSource[] = [];
  const seen = new Set<string>();
  for (const candidate of list) {
    const label =
      candidate && typeof candidate.sourceId === "string" && candidate.sourceId
        ? candidate.sourceId
        : "(no sourceId)";
    const result = validateDataSource(candidate, manifest.domains);
    if (!result.valid) {
      log.warn(`Dropping runtime data source ${label}: ${result.errors.join("; ")}`);
      continue;
    }
    if (seen.has(result.dataSource.sourceId)) {
      log.warn(`Dropping runtime data source ${label}: duplicate sourceId`);
      continue;
    }
    const declarer = otherDeclarer(integration.id, result.dataSource.sourceId);
    if (declarer !== undefined) {
      log.warn(
        `Dropping runtime data source ${label} of ${integration.id}: integration ${declarer} already declares it`,
      );
      continue;
    }
    seen.add(result.dataSource.sourceId);
    accepted.push(result.dataSource);
  }
  manifest.dataSources = accepted;
  if (integrations.get(integration.id) === integration) {
    void refreshAttributionFromRegistry();
    runIntegrationSourcesChangedHook();
  }
  return [...accepted];
}

type DiscoveredManifest = Awaited<ReturnType<typeof discoverManifests>>[number];

/**
 * Resolves each integration's configuration at most once per generation, and
 * the provider order of every orchestrator before any setup runs: a provider's
 * integration may ask for the order of a domain whose orchestrator is set up
 * after it, or never because it is disabled. Only the manifest a generation
 * would load for an id supplies an order, by the same tests its load applies.
 */
async function prepareGenerationConfig(
  sorted: DiscoveredManifest[],
  resolve: (
    manifest: IntegrationManifest,
    directory: string,
  ) => Promise<Record<string, ConfigValueWithSource>>,
): Promise<{
  configOf: (manifest: IntegrationManifest, directory: string) => Promise<Record<string, unknown>>;
  orders: ReadonlyMap<string, readonly string[]>;
}> {
  const configs = new Map<string, Promise<Record<string, ConfigValueWithSource>>>();
  const withSourcesOf = (manifest: IntegrationManifest, directory: string) => {
    let pending = configs.get(directory);
    if (!pending) {
      pending = resolve(manifest, directory);
      configs.set(directory, pending);
    }
    return pending;
  };
  const configOf = async (manifest: IntegrationManifest, directory: string) =>
    Object.fromEntries(
      Object.entries(await withSourcesOf(manifest, directory)).map(([key, entry]) => [
        key,
        entry.value,
      ]),
    );
  const orders = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  for (const { manifest: raw, directory, isBuiltIn } of sorted) {
    if (!validateManifest(raw, { firstParty: isBuiltIn }).valid) continue;
    const manifest = raw as IntegrationManifest;
    if (seen.has(manifest.id)) continue;
    if (!isBuiltIn && !satisfiesPlatformVersion(manifest.platform ?? "")) continue;
    seen.add(manifest.id);
    if (!ORCHESTRATOR_IDS.has(manifest.id)) continue;
    const entry = (await withSourcesOf(manifest, directory)).providerOrder;
    orders.set(
      manifest.id,
      readProviderOrder(entry?.value, (entries) =>
        processLogger.warn(
          { component: "integration-host", integrationId: manifest.id, source: entry?.source },
          `providerOrder from ${entry?.source} has ${entries} entries; only the first 64 are used`,
        ),
      ),
    );
  }
  return { configOf, orders };
}

function buildIntegrationContext(args: {
  id: string;
  manifest: IntegrationManifest;
  config: Record<string, unknown>;
  log: Logger;
  http: HttpClient;
  cache: CacheClient;
  db: IntegrationContext["db"];
  requiresMap: ReturnType<typeof resolveRequiresForIntegration>;
  providers: Map<string, unknown[]>;
  shutdownHandlers: Array<() => Promise<void>>;
  integration: LoadedIntegration;
  eventBus: IntegrationEventBus;
  integrationsByDomain: (domain: string) => LoadedIntegration[];
  /** The generation's provider order of each orchestrator integration, by its id. */
  providerOrders: ReadonlyMap<string, readonly string[]>;
  activationScope: ActivationTransactionScope;
}): IntegrationContext {
  const {
    id,
    manifest,
    config,
    log,
    http,
    cache,
    db,
    requiresMap,
    providers,
    shutdownHandlers,
    eventBus: contextEventBus,
    integrationsByDomain,
    providerOrders: generationProviderOrders,
    activationScope,
  } = args;
  const { integration } = args;
  integration.resolvedServices = Object.freeze(
    Object.fromEntries(
      [...requiresMap].map(([key, service]) => [key, Object.freeze({ ...service })]),
    ),
  );
  const subscriptions = new Set<() => void>();
  // An installed integration that fails is left out of a generation that goes
  // on, so nothing it registers may activate before its setup has returned.
  let pendingActivations: Array<{ activate: () => void; rollback?: () => void }> | null =
    integration.isBuiltIn ? null : [];
  const scope: IntegrationScope = {
    integrationId: id,
    isBuiltIn: integration.isBuiltIn,
    revoked: false,
  };
  integrationScopes.set(integration, scope);
  const inScope =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R =>
      runInIntegrationScope(scope, () => fn(...args));
  // Work an unloaded integration scheduled may still run; it must not reach
  // the generation that left the integration out, and gets `inert()` back.
  const live =
    <A extends unknown[], R>(method: string, fn: (...args: A) => R, inert: () => R) =>
    (...args: A): R =>
      ignoredAfterUnload(scope, method, hostLog) ? inert() : fn(...args);
  const nothing = () => undefined;
  const registrars = createProviderRegistrars({
    integrationId: id,
    manifest,
    providers,
    bind: (domain, provider) => bindProviderToScope(provider, scope, { domain, log: hostLog }),
  });
  const ctx: IntegrationContext = {
    id,
    manifest,
    config,
    http,
    cache,
    db,
    log,
    secrets: { get: (key: string) => getSecret(id, key) },
    attributionIndex: getAttributionIndex() ?? undefined,
    providerHealth: getProviderHealth() ?? undefined,
    metricsRecorder: getMetricsRecorder(),
    cursorCodec: cursorCodecFromEnvironment(),
    upstreamRuntime: redis
      ? createRedisUpstreamRuntime(redis as unknown as UpstreamRedisClient, {
          namespace: process.env.OPENMAPX_UPSTREAM_NAMESPACE?.trim() || "default",
          integrationId: id,
        })
      : undefined,
    getRequiredService(key: string) {
      return requiresMap.get(key) ?? null;
    },
    resolvePlatformEndpoint(endpointId) {
      return resolveIntegrationPlatformEndpoint(
        { manifest, config },
        (serviceId) => requiresMap.get(serviceId),
        endpointId,
      );
    },
    ...(Object.fromEntries(
      Object.entries(registrars as unknown as Record<string, (provider: object) => void>).map(
        ([name, register]) => [name, live(name, register, nothing)],
      ),
    ) as unknown as ProviderRegistrars),
    registerRoute: live(
      "registerRoute",
      (method, path, handler, options) => {
        registerIntegrationRoute(id, method, path, inScope(handler), options);
      },
      nothing,
    ),
    registerHealthCheck: live(
      "registerHealthCheck",
      (fn: CustomHealthCheckFn) => {
        integration.customHealthCheck = inScope(fn);
      },
      nothing,
    ),
    registerDisclosure: live(
      "registerDisclosure",
      (disclosure) => {
        if (!integration.disclosures) integration.disclosures = [];
        integration.disclosures.push(disclosure);
      },
      nothing,
    ),
    setDataSources: live(
      "setDataSources",
      (list) => setRuntimeDataSources(integration, log, list),
      () => [],
    ),
    emit: live(
      "emit",
      (event: string, data: unknown) => {
        contextEventBus.emit({
          type: event,
          integrationId: id,
          ...(typeof data === "object" && data !== null ? data : {}),
        } as never);
      },
      nothing,
    ),
    on: live(
      "on",
      (event: string, handler: (data: unknown) => void) => {
        const unsubscribe = contextEventBus.on(event as never, inScope(handler) as never);
        const tracked = () => {
          subscriptions.delete(tracked);
          unsubscribe();
        };
        subscriptions.add(tracked);
        return tracked;
      },
      () => nothing,
    ),
    onActivate: live(
      "onActivate",
      (activate: () => void, rollback?: () => void) => {
        const scoped = { activate: inScope(activate), rollback: rollback && inScope(rollback) };
        if (pendingActivations) pendingActivations.push(scoped);
        else activationScope.register(scoped.activate, scoped.rollback);
      },
      nothing,
    ),
    onShutdown: live(
      "onShutdown",
      (cleanup: () => Promise<void>) => {
        shutdownHandlers.push(inScope(cleanup));
      },
      nothing,
    ),
    getIntegrationsByDomain(domain: string) {
      return integrationsByDomain(domain);
    },
    getProviderOrder(domain: string) {
      const orchestrator = orchestratorOf(domain);
      return orchestrator ? (generationProviderOrders.get(orchestrator) ?? []) : [];
    },
    getProviderOrderFingerprint(domain: string) {
      return createHash("sha256")
        .update(providerOrderFingerprintInput(ctx, domain))
        .digest("hex")
        .slice(0, 16);
    },
    getDisallowedSourceIds() {
      return disallowedSourceResolver
        ? disallowedSourceResolver()
        : Promise.resolve(new Set<string>());
    },
    async getRoadConditionsPolicySnapshot() {
      return roadConditionsPolicyResolver
        ? roadConditionsPolicyResolver()
        : {
            authoritative: false,
            revision: "",
            validUntil: null,
            disallowedSourceIds: [],
            allowGreyArea: false,
            allowNonCommercial: false,
          };
    },
    getDisallowedIntegrationIds() {
      return disallowedIntegrationResolver
        ? disallowedIntegrationResolver()
        : Promise.resolve(new Set<string>());
    },
  };
  contextControls.set(ctx, {
    releaseActivations() {
      const released = pendingActivations ?? [];
      pendingActivations = null;
      for (const { activate, rollback } of released) activationScope.register(activate, rollback);
    },
    discardActivations() {
      pendingActivations = null;
    },
    unsubscribeAll() {
      for (const unsubscribe of [...subscriptions]) unsubscribe();
    },
  });
  return ctx;
}

/** Host-side controls over a context's registrations that the integration cannot reach. */
interface IntegrationContextControl {
  /** Hands the `onActivate` registrations held back during setup to the generation's scope. */
  releaseActivations(): void;
  /** Drops the held-back registrations of an integration that is left out. */
  discardActivations(): void;
  /** Removes every `ctx.on` subscription the context made. */
  unsubscribeAll(): void;
}

const contextControls = new WeakMap<IntegrationContext, IntegrationContextControl>();

/** The scope each loaded integration's code runs in, for this generation. */
const integrationScopes = new WeakMap<LoadedIntegration, IntegrationScope>();

/**
 * Revokes the scope of an installed integration that is left out or whose
 * generation is retired, so the work it scheduled can no longer register.
 */
function revokeInstalledScope(integration: LoadedIntegration): void {
  if (integration.isBuiltIn) return;
  const scope = integrationScopes.get(integration);
  if (scope) scope.revoked = true;
}

/** Host warnings whose second argument is a record of structured log fields. */
const hostLog: Logger = (() => {
  const write =
    (level: "info" | "warn" | "error" | "debug") => (message: string, fields?: unknown) =>
      (_fastify?.log ?? processLogger)[level](
        typeof fields === "object" && fields !== null ? fields : {},
        message,
      );
  return { info: write("info"), warn: write("warn"), error: write("error"), debug: write("debug") };
})();

class LoadDeadlineError extends Error {
  constructor() {
    super(`Import and setup did not finish within ${SETUP_DEADLINE_MS / 1000} seconds`);
    this.name = "LoadDeadlineError";
  }
}

interface LoadDeadline {
  /** Settles as `step` does, unless the deadline passes first. */
  within<T>(step: () => Promise<T>): Promise<T>;
  clear(): void;
}

/**
 * The one deadline an installed integration's import and `setup` share, so a
 * bundle whose top-level `await` never settles is left out as a hung setup
 * is. When it passes, the scope is revoked at once, before anything the
 * integration scheduled can run, and the step in progress rejects with
 * `LoadDeadlineError`. A step that settles later is ignored, and no further
 * step starts.
 */
function startLoadDeadline(scope: IntegrationScope): LoadDeadline {
  let expired = false;
  let abandon: ((error: Error) => void) | undefined;
  const timer = setTimeout(() => {
    expired = true;
    scope.revoked = true;
    abandon?.(new LoadDeadlineError());
  }, SETUP_DEADLINE_MS);
  timer.unref?.();
  return {
    within<T>(step: () => Promise<T>): Promise<T> {
      if (expired) return Promise.reject(new LoadDeadlineError());
      return new Promise<T>((resolve, reject) => {
        abandon = reject;
        try {
          step().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      }).finally(() => {
        abandon = undefined;
      });
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * Runs an integration's `setup` in its scope. A setup still running after
 * `SETUP_WARNING_MS` is named in a warning, unless its integration was left
 * out by then.
 */
function runSetup(
  integration: LoadedIntegration,
  scope: IntegrationScope,
  setup: () => void | Promise<void>,
): Promise<void> {
  const warning = setTimeout(() => {
    if (scope.revoked) return;
    (_fastify?.log ?? processLogger).warn(
      { integrationId: integration.id },
      `Integration ${integration.id} has not finished setting up after ${SETUP_WARNING_MS / 1000} seconds`,
    );
  }, SETUP_WARNING_MS);
  warning.unref?.();
  return new Promise<void>((resolve, reject) => {
    try {
      Promise.resolve(runInIntegrationScope(scope, setup)).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }).finally(() => clearTimeout(warning));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Imports an integration's backend and runs its `setup`. A built-in's failure
 * is rethrown for the caller to handle. An installed integration that fails is
 * left out: it is recorded as failed and disabled, everything it registered is
 * undone, its shutdown handlers run, and the generation goes on without it.
 */
async function loadIntegrationBackend(args: {
  integration: LoadedIntegration;
  ctx: IntegrationContext;
  shutdownHandlers: Array<() => Promise<void>>;
}): Promise<"loaded" | "left-out"> {
  const { integration, ctx, shutdownHandlers } = args;
  const scope = integrationScopes.get(integration);
  if (!scope) throw new Error(`Integration ${integration.id} has no context`);
  let phase: IntegrationLoadError["phase"] = "import";
  if (integration.isBuiltIn) {
    try {
      const entryPoint = resolveBuiltInBackendEntryPoint(integration.directory);
      if (entryPoint) {
        const specifier = backendEntryImportSpecifier(entryPoint);
        const mod = (await runInIntegrationScope(scope, () => import(specifier))) as {
          setup?: SetupFunction;
        };
        phase = "setup";
        const { setup } = mod;
        if (typeof setup === "function") await runSetup(integration, scope, () => setup(ctx));
      }
      return "loaded";
    } catch (error) {
      integration.loadState = "failed";
      integration.loadError = { phase, message: errorMessage(error) };
      throw error;
    }
  }

  const control = contextControls.get(ctx);
  const resolvers = snapshotPlaceResolvers();
  const declaredDataSources = integration.manifest.dataSources;
  try {
    const specifier = await installedBackendImportSpecifier(integration);
    if (specifier) {
      const deadline = startLoadDeadline(scope);
      try {
        const mod = (await deadline.within(() =>
          runInIntegrationScope(scope, () => import(specifier)),
        )) as { setup?: SetupFunction };
        phase = "setup";
        const { setup } = mod;
        if (typeof setup === "function")
          await deadline.within(() => runSetup(integration, scope, () => setup(ctx)));
      } finally {
        deadline.clear();
      }
    }
    phase = "setup";
    control?.releaseActivations();
    return "loaded";
  } catch (error) {
    scope.revoked = true;
    if (error instanceof LoadDeadlineError) phase = "deadline";
    control?.discardActivations();
    control?.unsubscribeAll();
    dropIntegrationRoutes(integration.id);
    restorePlaceResolvers(resolvers);
    integration.providers.clear();
    integration.customHealthCheck = undefined;
    integration.disclosures = undefined;
    integration.manifest.dataSources = declaredDataSources;
    integration.enabled = false;
    integration.loadState = "failed";
    integration.loadError = { phase, message: errorMessage(error) };
    _fastify?.log.error(
      { err: error, integrationId: integration.id, phase },
      `Leaving out installed integration ${integration.id}: its backend failed to ${phase === "import" ? "import" : phase === "deadline" ? "import and set up in time" : "set up"}`,
    );
    const handlers = shutdownHandlers.splice(0);
    for (const handler of handlers) {
      try {
        await handler();
      } catch (shutdownError) {
        _fastify?.log.warn(
          { err: shutdownError, integrationId: integration.id },
          `A shutdown handler of the left-out integration ${integration.id} failed`,
        );
      }
    }
    return "left-out";
  }
}

/**
 * The integrations of the live generation whose load failed, limited to `ids`
 * when given. Install and update jobs use it to fail a change whose
 * integration the reload left out.
 */
export function failedIntegrationLoads(
  ids?: readonly string[],
): Array<{ id: string; phase: IntegrationLoadError["phase"]; message: string }> {
  const wanted = ids ? new Set(ids) : null;
  const failed: Array<{ id: string; phase: IntegrationLoadError["phase"]; message: string }> = [];
  for (const integration of integrations.values()) {
    if (integration.loadState !== "failed" || (wanted && !wanted.has(integration.id))) continue;
    failed.push({
      id: integration.id,
      phase: integration.loadError?.phase ?? "setup",
      message: integration.loadError?.message ?? "",
    });
  }
  return failed;
}

export async function initIntegrations(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  fastify: FastifyInstance<any, any, any, any>,
  integrationDirs: IntegrationDirectoryInput[],
): Promise<void> {
  const generationId = randomUUID();
  _fastify = fastify;
  _integrationDirs = normalizeIntegrationDirs(integrationDirs);
  resetIntegrationRoutes();
  codeCache = null;
  setPlaceResolverRegistrationHook((_scheme, resolver) => {
    const scope = currentIntegrationScope();
    if (!scope) return resolver;
    if (ignoredAfterUnload(scope, "registerPlaceResolver", hostLog)) return null;
    return scope.isBuiltIn ? resolver : bindPlaceResolverToScope(resolver, scope, hostLog);
  });

  const discovered = await discoverManifests(_integrationDirs);
  const sorted = topologicalSort(discovered);

  // Hard-fail at startup when any selected integration declares vault-backed
  // secret fields but the secrets key is unusable. The lazy fallback in
  // secrets.ts already throws on first decrypt, but lazy failure means the
  // operator only finds out via a 500 from a user-facing route; bailing here
  // surfaces it as a boot error with a clear remediation hint.
  const keyProblem = secretsKeyProblem();
  if (keyProblem) {
    const requiringSecrets = sorted.filter((d) =>
      manifestDeclaresSecretFields(d.manifest as IntegrationManifest),
    );
    if (requiringSecrets.length > 0) {
      const names = requiringSecrets.map((d) => d.manifest.id).join(", ");
      throw new Error(
        `The secrets key is not usable, but the following integrations require it: ${names}. ${keyProblem}`,
      );
    }
    fastify.log.warn(
      `The secrets key is not usable, so vault-backed integration secrets cannot be stored or decrypted. ${keyProblem}`,
    );
  }

  // Load all capability bindings once for requires: resolution.
  // Falls back gracefully if DB is unavailable (e.g. no PostgreSQL in dev).
  let allBindings = new Map<string, Map<string, string>>();
  try {
    allBindings = await loadAllBindingsByIntegration();
  } catch {
    fastify.log.debug(
      "Capability bindings unavailable — requires: resolution uses auto-select only",
    );
  }

  let registryInstance: ReturnType<typeof getServiceRegistry> | null = null;
  let loadedServices: ReturnType<ReturnType<typeof getServiceRegistry>["list"]> = [];
  try {
    registryInstance = getServiceRegistry();
    loadedServices = registryInstance.list();
  } catch {
    fastify.log.debug("Service registry unavailable — requires: resolution skipped");
  }

  // Initialise the persistent ProviderHealth tracker once per host boot.
  // When Redis is unavailable we leave the holder null and the orchestrator
  // falls back to its no-op handle (treats every provider as healthy).
  if (redis && !getProviderHealth()) {
    try {
      const providerHealthLog = {
        info: (m: string) => fastify.log.info(m),
        warn: (m: string) => fastify.log.warn(m),
        error: (m: string) => fastify.log.error(m),
        debug: (m: string) => fastify.log.debug(m),
      };
      const ph = await ProviderHealth.init({ redis, log: providerHealthLog });
      setProviderHealth(ph);
    } catch (err) {
      fastify.log.warn(err, "ProviderHealth initialization failed (continuing without it)");
    }
  }

  // Initialise the AttributionIndex once per host boot. Pre-loads MOTIS
  // license.json + every integration manifest's dataSources[] so providers
  // can resolve attribution rows via ctx.attributionIndex without each one
  // re-reading the underlying sources.
  try {
    const manifestDataSources = collectManifestDataSources(sorted);
    const attributionLog = {
      info: (m: string) => fastify.log.info(m),
      warn: (m: string) => fastify.log.warn(m),
      error: (m: string) => fastify.log.error(m),
      debug: (m: string) => fastify.log.debug(m),
    };
    const idx = await AttributionIndex.init({
      redis,
      log: attributionLog,
      motisLicenseFile: defaultMotisLicenseFile(),
      integrationManifests: manifestDataSources,
      enableMtimePoller: false,
    });
    setAttributionIndex(idx);
  } catch (err) {
    fastify.log.warn(err, "AttributionIndex initialization failed (continuing without it)");
  }

  const { configOf, orders } = await prepareGenerationConfig(sorted, resolveConfigWithSources);
  providerOrders = orders;

  for (const { manifest: raw, directory, isBuiltIn } of sorted) {
    const validation = validateManifest(raw, { firstParty: isBuiltIn });
    if (!validation.valid) {
      fastify.log.warn(
        { id: raw.id, errors: validation.errors },
        `Skipping integration ${raw.id}: manifest validation failed`,
      );
      continue;
    }

    const manifest = raw as IntegrationManifest;
    const id = manifest.id;

    if (integrations.has(id)) {
      fastify.log.warn(`Skipping duplicate integration: ${id}`);
      continue;
    }

    // A community manifest always states its protocol; validation requires it.
    if (!isBuiltIn && !satisfiesPlatformVersion(manifest.platform ?? "")) {
      fastify.log.warn(
        `Skipping community integration ${id}: requires platform >=${manifest.platform}, current is ${PLATFORM_VERSION}`,
      );
      continue;
    }

    const config = await configOf(manifest, directory);
    warnInvalidConfig(manifest, config, id, (msg) => fastify.log.warn(msg));

    const log = createLogger(id, fastify);
    const http = createHttpClient(log);
    const cache = createCacheClient(id);
    const shutdownHandlers: Array<() => Promise<void>> = [];
    const providers = new Map<string, unknown[]>();

    const integration: LoadedIntegration = {
      id,
      manifest,
      config,
      directory,
      isBuiltIn,
      enabled: config.enabled !== false,
      providers,
      strings: loadStrings(directory),
      customHealthCheck: undefined,
      loadState: "loaded",
      shutdownHandlers,
    };

    if (!integration.enabled) {
      integrations.set(id, integration);
      log.info(`Integration ${id} is disabled`);
      continue;
    }

    const integrationDb = buildIntegrationDb(manifest);

    const requiresMap = resolveRequiresForIntegration({
      manifestId: id,
      requires: manifest.requires,
      loadedServices,
      bindings: allBindings.get(id) ?? new Map(),
      onUnsatisfied: (requirement, reason) =>
        fastify.log.warn(
          { integration: id, requirement, reason },
          `Integration ${id}: required service unresolved`,
        ),
    });

    const activationScope = createActivationTransactionScope({ activateOnRegister: true });
    const ctx = buildIntegrationContext({
      id,
      manifest,
      config,
      log,
      http,
      cache,
      db: integrationDb,
      requiresMap,
      providers,
      shutdownHandlers,
      integration,
      eventBus,
      integrationsByDomain: getIntegrationsByDomain,
      providerOrders: orders,
      activationScope,
    });

    try {
      if ((await loadIntegrationBackend({ integration, ctx, shutdownHandlers })) === "left-out") {
        for (const rollbackError of activationScope.rollback()) {
          fastify.log.warn(rollbackError, `Failed to roll back activation for integration ${id}`);
        }
        integrations.set(id, integration);
        eventBus.emit({
          type: "integration.error",
          integrationId: id,
          error: new Error(integration.loadError?.message),
        });
        continue;
      }

      stageIntegrationRuntimeEvidence(integration, generationId);
      activationScope.complete();
      integrations.set(id, integration);
      log.info(`Integration ${id} v${manifest.version ?? "unknown"} loaded successfully`);
      eventBus.emit({ type: "integration.loaded", integrationId: id });
    } catch (err) {
      for (const rollbackError of activationScope.rollback()) {
        fastify.log.warn(rollbackError, `Failed to roll back activation for integration ${id}`);
      }
      fastify.log.error(err, `Failed to load integration ${id}`);
      integration.enabled = false;
      if (integration.loadState !== "failed") {
        integration.loadState = "failed";
        integration.loadError = { phase: "setup", message: errorMessage(err) };
      }
      integrations.set(id, integration);
      eventBus.emit({
        type: "integration.error",
        integrationId: id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // The index above was seeded from the manifests on disk; runtime integrations
  // supplied their sources during setup, so re-index from the live registry.
  await refreshAttributionFromRegistry();

  const warnedPreviewIds = new Set<string>();
  fastify.get<{ Params: { id: string } }>("/api/integrations/:id/preview", async (req, reply) => {
    const integration = integrations.get(req.params.id);
    if (!integration?.enabled) {
      return reply.status(404).send({ error: "Not found" });
    }

    let previewPath: string | null;
    try {
      previewPath = resolveLayerSelectorPreview(
        integration.directory,
        integration.manifest as Record<string, unknown>,
      );
    } catch (error) {
      if (!warnedPreviewIds.has(integration.id)) {
        warnedPreviewIds.add(integration.id);
        fastify.log.warn(
          { integrationId: integration.id, err: error },
          "Integration layer preview is unavailable",
        );
      }
      return reply.status(404).send({ error: "Not found" });
    }
    if (!previewPath) {
      return reply.status(404).send({ error: "Not found" });
    }

    const bytes = readIntegrationFile(
      integration.directory,
      relative(realpathSync(integration.directory), previewPath),
    );
    if (!bytes) {
      return reply.status(404).send({ error: "Not found" });
    }
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    reply.header("Content-Type", "image/svg+xml; charset=utf-8");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    reply.header("Cache-Control", "public, max-age=0, must-revalidate");
    reply.header("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
    return reply.send(bytes);
  });

  // Public status reads are deliberately cache-only. The background scheduler
  // below and the authenticated admin sweep are the only full-check callers.
  fastify.get("/api/integrations/health", () => {
    const all = Array.from(integrations.values()).filter((i) => i.enabled);
    const snapshot = getCachedIntegrationHealthSnapshot(all);
    return {
      timestamp: new Date(snapshot.updatedAt ?? Date.now()).toISOString(),
      services: snapshot.results,
    };
  });

  registerIntegrationRouteDispatcher(fastify, integrations);

  // Reload endpoint — re-discovers and re-initializes integrations (dev only)
  if (process.env.NODE_ENV !== "production") {
    fastify.post("/api/integrations/reload", async (_request, reply) => {
      try {
        const result = await reloadIntegrations();
        return result;
      } catch (err) {
        return reply.status(500).send({
          error: "Reload failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  fastify.log.info(
    `Loaded ${integrations.size} integrations (${Array.from(integrations.values()).filter((i) => i.enabled).length} enabled)`,
  );
}

let healthRefreshSeed: ReturnType<typeof setTimeout> | undefined;
let healthRefreshInterval: ReturnType<typeof setInterval> | undefined;

/** Starts watching the MOTIS licence file; `shutdownIntegrations` stops it. */
export function startAttributionLicenseWatch(): void {
  getAttributionIndex()?.startMtimePoller();
}

/** Seeds the integration health cache shortly after startup, then keeps it fresh. */
export function startIntegrationHealthRefresh(): void {
  if (healthRefreshInterval) return;
  const runHealthRefresh = () => {
    const enabled = Array.from(integrations.values()).filter((i) => i.enabled);
    executeAllIntegrationHealthChecks(enabled, { scheduled: true }).catch((err) =>
      _fastify?.log.warn(err, "Health cache refresh failed"),
    );
  };
  // Seed asynchronously (don't block startup)
  healthRefreshSeed = setTimeout(runHealthRefresh, 5_000);
  // Refresh every 60 seconds
  healthRefreshInterval = setInterval(runHealthRefresh, 60_000);
  healthRefreshInterval.unref();
}

export function stopIntegrationHealthRefresh(): void {
  clearTimeout(healthRefreshSeed);
  clearInterval(healthRefreshInterval);
  healthRefreshSeed = undefined;
  healthRefreshInterval = undefined;
}

/** Whether `initIntegrations` has run, so `reloadIntegrations` can. */
export function isIntegrationHostInitialized(): boolean {
  return _fastify !== null;
}

export function getIntegration(id: string): LoadedIntegration | undefined {
  return integrations.get(id);
}

export function getAllIntegrations(): LoadedIntegration[] {
  return Array.from(integrations.values());
}

/**
 * True when `scheme` matches the id of an installed integration manifest —
 * regardless of whether its `setup()` succeeded. The places route uses this
 * to decide whether an unregistered resolver should 404 (the integration
 * owns the scheme but didn't boot) or fall through to the freeform name+
 * coord lookup (the scheme is a UI-side convention like `saved`/`style-poi`,
 * not an integration). Manifest discovery runs before `setup()`, so this
 * stays accurate even when an integration crashes during boot — which is
 * the failure mode this gate exists to catch.
 */
export function isIntegrationScheme(scheme: string): boolean {
  return integrations.has(scheme);
}

/**
 * True when `scheme` matches an installed integration that is **not**
 * config-disabled (`config.enabled !== false`). The places route uses this
 * to decide whether a missing resolver should 404 (the integration owns the
 * scheme and is enabled, so the missing resolver is a boot failure) or fall
 * through to coord-fallback (the integration is config-disabled, so a stale
 * deep-link should degrade gracefully rather than hard-404).
 *
 * Keyed on `config.enabled`, not the runtime `enabled` flag: both a
 * config-disabled integration and an enabled-but-`setup()`-threw integration
 * have `enabled === false` at runtime, but only `config.enabled === false`
 * uniquely marks config-disabled. Using the runtime flag would let a broken
 * enabled integration fall through to coord-fallback, re-opening the
 * tag-substitution leak the 404 trap closes.
 */
export function isEnabledIntegrationScheme(scheme: string): boolean {
  const i = integrations.get(scheme);
  return i !== undefined && i.config?.enabled !== false;
}

export function getIntegrationsByDomain(domain: string): LoadedIntegration[] {
  return Array.from(integrations.values()).filter(
    (i) => i.enabled && i.manifest.domains.includes(domain),
  );
}

export function getIntegrationProviders<T>(id: string, domain: string): T[] {
  return (integrations.get(id)?.providers.get(domain) ?? []) as T[];
}

// A `type` (not `interface`) so it keeps an implicit index signature and stays
// assignable to Record<string, unknown> — the integration.reload job handler
// casts the result, and an interface would break that at the call site.
type ReloadResult = {
  message: string;
  reloaded: number;
  enabled: number;
};

let activeReload: Promise<ReloadResult> | null = null;
let pendingReload: Promise<ReloadResult> | null = null;

/**
 * Serialized reload. If a reload is in flight, callers share ONE trailing full
 * pass that starts after it finishes — a caller that just wrote new integration
 * files is guaranteed a discover+setup pass starting at or after its call,
 * while N concurrent callers cause at most one queued rebuild.
 */
export async function reloadIntegrations(
  context?: AdministrativeConfigurationReadContext,
): Promise<ReloadResult> {
  if (context) {
    assertAdministrativeConfigurationRead(context);
    // Each committed candidate receives its own exact pass. Coalescing it with
    // another caller's snapshot could publish a different desired generation.
    while (activeReload) await activeReload.catch(() => undefined);
    activeReload = doReloadIntegrations(context).finally(() => {
      activeReload = null;
    });
    return activeReload;
  }
  if (!activeReload) {
    activeReload = doReloadIntegrations().finally(() => {
      activeReload = null;
    });
    return activeReload;
  }
  if (!pendingReload) {
    pendingReload = activeReload
      .catch(() => undefined)
      .then(() => {
        pendingReload = null;
        return reloadIntegrations();
      });
  }
  return pendingReload;
}

/**
 * Build a complete integration generation off to the side, synchronously swap
 * every request-visible registry after setup succeeds, and only then retire the
 * previous generation. A failed rebuild is discarded without disturbing the
 * integrations that are currently serving requests.
 */
async function doReloadIntegrations(
  context?: AdministrativeConfigurationReadContext,
): Promise<ReloadResult> {
  const generationId = randomUUID();
  if (!_fastify) throw new Error("Integration host not initialized");
  if (context) assertAdministrativeConfigurationRead(context);

  const previousCount = integrations.size;
  const previousIntegrations = Array.from(integrations.values());
  const previousEventBus = eventBus;
  const stagedEventBus = new IntegrationEventBus();
  const next = new Map<string, LoadedIntegration>();
  const activationScope = createActivationTransactionScope();

  try {
    beginIntegrationRouteStaging();
    beginPlaceResolverStaging();

    // Re-discover and re-setup (topological sort by dependencies, same as cold start).
    const discovered = await discoverManifests(_integrationDirs);
    const sorted = topologicalSort(discovered);
    if (
      context &&
      (sorted.length !== context.integrations.length ||
        sorted.some((item) => {
          const captured = context.integrations.find((i) => i.id === item.manifest.id);
          return (
            !captured ||
            captured.directory !== item.directory ||
            JSON.stringify(captured.manifest) !== JSON.stringify(item.manifest)
          );
        }))
    )
      throw Error("Captured integration registry changed");

    // Reload capability bindings and service registry for requires: resolution.
    let reloadBindings = new Map<string, Map<string, string>>();
    try {
      reloadBindings = await loadAllBindingsByIntegration(context);
    } catch {
      throw Error("Captured integration bindings unavailable");
    }

    let reloadRegistry: ReturnType<typeof getServiceRegistry> | null = null;
    let reloadServices: ReturnType<ReturnType<typeof getServiceRegistry>["list"]> = [];
    try {
      reloadRegistry = getServiceRegistry();
      reloadServices = reloadRegistry.list();
      if (context) reloadServices = [...context.services];
    } catch {
      if (context) throw Error("Captured service registry unavailable");
      _fastify.log.debug("Service registry unavailable during reload");
    }

    const { configOf, orders: stagedProviderOrders } = await prepareGenerationConfig(
      sorted,
      context
        ? (manifest, directory) =>
            resolveIntegrationConfigWithSourcesStrict(manifest, directory, context)
        : resolveConfigWithSources,
    );

    for (const { manifest: raw, directory, isBuiltIn } of sorted) {
      const validation = validateManifest(raw, { firstParty: isBuiltIn });
      if (!validation.valid) {
        const replacesActiveIntegration = previousIntegrations.some(
          (integration) => integration.directory === directory,
        );
        _fastify.log[replacesActiveIntegration ? "error" : "warn"](
          { id: raw.id, errors: validation.errors },
          `${replacesActiveIntegration ? "Cannot stage" : "Skipping"} integration ${raw.id}: manifest validation failed`,
        );
        if (replacesActiveIntegration) {
          throw new Error(
            `Integration ${raw.id} manifest validation failed: ${validation.errors.join("; ")}`,
          );
        }
        continue;
      }

      const manifest = raw as IntegrationManifest;
      const id = manifest.id;

      if (next.has(id)) {
        _fastify.log.warn(`Skipping duplicate integration: ${id}`);
        continue;
      }

      if (!isBuiltIn && !satisfiesPlatformVersion(manifest.platform ?? "")) {
        _fastify.log.warn(
          `Skipping community integration ${id}: requires platform >=${manifest.platform}, current is ${PLATFORM_VERSION}`,
        );
        continue;
      }

      const config = await configOf(manifest, directory);
      const log = createLogger(id, _fastify);
      const http = createHttpClient(log);
      const cache = createCacheClient(id);
      const shutdownHandlers: Array<() => Promise<void>> = [];
      const providers = new Map<string, unknown[]>();

      warnInvalidConfig(manifest, config, id, (msg) => _fastify?.log.warn(msg));

      const integration: LoadedIntegration = {
        id,
        manifest,
        config,
        directory,
        isBuiltIn,
        enabled: config.enabled !== false,
        providers,
        strings: loadStrings(directory),
        customHealthCheck: undefined,
        loadState: "loaded",
        shutdownHandlers,
      };

      if (!integration.enabled) {
        next.set(id, integration);
        continue;
      }

      const integrationDb = buildIntegrationDb(manifest);

      const fastifyForReload = _fastify;
      const reloadRequiresMap = resolveRequiresForIntegration({
        manifestId: id,
        requires: manifest.requires,
        loadedServices: reloadServices,
        bindings: reloadBindings.get(id) ?? new Map(),
        onUnsatisfied: (requirement, reason) =>
          fastifyForReload?.log.warn(
            { integration: id, requirement, reason },
            `Integration ${id}: required service unresolved`,
          ),
      });

      const ctx = buildIntegrationContext({
        id,
        manifest,
        config,
        log,
        http,
        cache,
        db: integrationDb,
        requiresMap: reloadRequiresMap,
        providers,
        shutdownHandlers,
        integration,
        eventBus: stagedEventBus,
        integrationsByDomain: (domain) =>
          Array.from(next.values()).filter(
            (candidate) => candidate.enabled && candidate.manifest.domains.includes(domain),
          ),
        providerOrders: stagedProviderOrders,
        activationScope,
      });

      try {
        if ((await loadIntegrationBackend({ integration, ctx, shutdownHandlers })) === "left-out") {
          next.set(id, integration);
          stagedEventBus.emit({
            type: "integration.error",
            integrationId: id,
            error: new Error(integration.loadError?.message),
          });
          continue;
        }

        stageIntegrationRuntimeEvidence(integration, generationId);
        next.set(id, integration);
        log.info(`Integration ${id} v${manifest.version ?? "unknown"} reloaded successfully`);
        stagedEventBus.emit({ type: "integration.loaded", integrationId: id });
      } catch (err) {
        _fastify.log.error(err, `Failed to stage integration ${id}; keeping current generation`);
        next.delete(id);
        for (const handler of shutdownHandlers) {
          try {
            await handler();
          } catch {
            // best effort cleanup for the partially staged integration
          }
        }
        throw err;
      }
    }

    // No awaits in this block: request handlers see the entire old graph or the
    // entire new graph, never a mixture of registry/routes/resolver/event generations.
    activationScope.activate();
    integrations.clear();
    for (const [id, integration] of next) integrations.set(id, integration);
    providerOrders = stagedProviderOrders;
    commitIntegrationRouteStaging();
    commitPlaceResolverStaging();
    eventBus = stagedEventBus;
    activationScope.complete();
    // The previous generation stops serving here. Revoking it before the next
    // await keeps its late work out of the registries just committed.
    for (const integration of previousIntegrations) revokeInstalledScope(integration);
  } catch (err) {
    for (const rollbackError of activationScope.rollback()) {
      _fastify.log.warn(rollbackError, "Failed to roll back staged integration activation");
    }
    rollbackIntegrationRouteStaging();
    rollbackPlaceResolverStaging();
    stagedEventBus.removeAll();
    for (const integration of next.values()) {
      revokeInstalledScope(integration);
      for (const handler of integration.shutdownHandlers) {
        try {
          await handler();
        } catch {
          // best effort cleanup for resources created by the failed generation
        }
      }
    }
    throw err;
  }

  // Request-visible state is now committed. Refresh dependent indexes and
  // invalidate derived caches before retiring the previous generation. The
  // index reads the live registry, so it carries the lists runtime
  // integrations supplied while staging and nothing of the retired generation.
  await refreshAttributionFromRegistry();

  const enabledCount = Array.from(integrations.values()).filter((i) => i.enabled).length;
  _fastify.log.info(
    `Reloaded integrations: ${integrations.size} total (${enabledCount} enabled), was ${previousCount}`,
  );

  // The data-use policy memoizes gated sets derived from the (now-rebuilt)
  // registry; drop them so the next request re-derives against the new set.
  runIntegrationSourcesChangedHook();

  for (const integration of previousIntegrations) {
    previousEventBus.emit({ type: "integration.unloaded", integrationId: integration.id });
    for (const handler of integration.shutdownHandlers) {
      try {
        await handler();
      } catch {
        // best effort retirement of the previous generation
      }
    }
  }
  previousEventBus.removeAll();

  return {
    message: "Integrations reloaded",
    reloaded: integrations.size,
    enabled: enabledCount,
  };
}

export async function shutdownIntegrations(): Promise<void> {
  for (const integration of integrations.values()) {
    eventBus.emit({ type: "integration.unloaded", integrationId: integration.id });
    revokeInstalledScope(integration);

    for (const handler of integration.shutdownHandlers) {
      try {
        await handler();
      } catch {
        // best effort
      }
    }
  }
  integrations.clear();
  providerOrders = new Map();
  eventBus.removeAll();
  resetIntegrationRoutes();

  const idx = getAttributionIndex();
  if (idx) {
    idx.close();
    setAttributionIndex(null);
  }

  const ph = getProviderHealth();
  if (ph) {
    ph.close();
    setProviderHealth(null);
  }
}
