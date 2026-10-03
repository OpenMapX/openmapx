import { statSync } from "node:fs";
import { basename } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import {
  BUILD_ARTIFACTS,
  type BuildRecord,
  currentRevision,
  writeBuildRecord,
} from "./build-artifacts";
import { runningComposeServices } from "./docker";
import { resolveBuildRegion } from "./env-defaults";
import { buildMotisData, importMotisData } from "./motis-data";
import { buildOsrmGraph } from "./osrm-graph";
import { buildOtpGraph } from "./otp-graph";
import { log } from "./output";
import { repoPaths } from "./paths";
import { buildPeliasData } from "./pelias-data";
import { buildTileMbtiles } from "./tile-mbtiles";

/**
 * Builds stage into `<dir>.next` and swap at the end, but the consumers still
 * hold the old inodes through their hardlinked mounts until they restart and
 * the post-build link pass runs. Refusing while a consumer (listed per service
 * in {@link BUILD_ARTIFACTS}) is up keeps that window explicit — nothing in
 * this project supports live rebuilds.
 */
function consumersBlockingBuild(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.flatMap(
        (id) => (Object.hasOwn(BUILD_ARTIFACTS, id) ? BUILD_ARTIFACTS[id]?.consumers : []) ?? [],
      ),
    ),
  ];
}

const { ServiceRegistry } = coreServices;
type LoadedService = coreServices.LoadedService;

const SERVICE_BUILD_COMMAND_RE = /^openmapx\s+services\s+build\s+([a-z0-9-]+)$/;

export const SERVICE_BUILD_ORDER = ["osrm", "otp", "motis", "pelias", "tileserver"] as const;

export interface ServiceBuildContext {
  rootDir: string;
  region?: string;
  registry: coreServices.ServiceRegistry;
  service: LoadedService;
  /** MOTIS only: also run `motis import` so the output is ready to serve. */
  motisImport?: boolean;
}

export interface ServiceBuildArtifact {
  sourcePbf: string;
  runtimeImages: BuildRecord["runtimeImages"];
  toolImages: BuildRecord["toolImages"];
}

export interface ServiceBuildHandlerResult {
  summary: string;
  warnings?: string[];
  /** Provenance recorded for `data export`; omitted by test/custom handlers. */
  artifact?: ServiceBuildArtifact;
}

export type ServiceBuildHandler = (
  context: ServiceBuildContext,
) => Promise<ServiceBuildHandlerResult>;

export interface PlannedServiceBuild {
  id: string;
  buildCommand: string;
  service: LoadedService;
  handler: ServiceBuildHandler;
}

export interface ServiceBuildFailure {
  id: string;
  message: string;
}

export interface ServiceBuildExecutionResult {
  plannedIds: string[];
  completedIds: string[];
  failures: ServiceBuildFailure[];
}

export interface PlanServiceBuildsOptions {
  rootDir?: string;
  mode: "explicit" | "all";
  serviceIds?: string[];
  handlers?: Record<string, ServiceBuildHandler>;
}

export interface BuildServicesOptions extends PlanServiceBuildsOptions {
  region?: string;
  continueOnError?: boolean;
  motisImport?: boolean;
}

function serviceImage(service: LoadedService): string {
  return coreServices.serviceContainerImageReference(service.manifest.container);
}

function requireService(registry: coreServices.ServiceRegistry, id: string): LoadedService {
  const service = registry.get(id);
  if (!service) throw new Error(`Service manifest not found: ${id}`);
  return service;
}

const BUILT_IN_SERVICE_BUILD_HANDLERS: Record<string, ServiceBuildHandler> = {
  async motis({ rootDir, region, service, motisImport }): Promise<ServiceBuildHandlerResult> {
    log.info("Building MOTIS prepared data with Transitous tools");
    const result = await buildMotisData({ rootDir, region });
    const toolImages = { "transitous-tools": result.image };
    if (!motisImport) {
      return {
        summary: `Built MOTIS prepared data → ${result.motisDir}`,
        warnings:
          result.gtfsFeeds.length === 0
            ? ["No GTFS feeds found; staged MOTIS data with OSM only"]
            : [],
        artifact: { sourcePbf: result.sourcePbf, runtimeImages: {}, toolImages },
      };
    }
    const image = serviceImage(service);
    log.info(`Importing MOTIS data with ${image}`);
    await importMotisData({ motisDir: result.motisDir, image });
    return {
      summary: `Built and imported MOTIS data → ${result.motisDir}`,
      artifact: { sourcePbf: result.sourcePbf, runtimeImages: { motis: image }, toolImages },
    };
  },
  async osrm({ rootDir, region, service }) {
    const image = serviceImage(service);
    log.info(`Building OSRM graph with ${image}`);
    const result = await buildOsrmGraph({ rootDir, region, image });
    // A skipped build keeps the record of the build that actually wrote it.
    if (result.skipped) {
      return { summary: `OSRM graph unchanged → ${result.graphPath}` };
    }
    return {
      summary: `Built OSRM graph → ${result.graphPath}`,
      artifact: { sourcePbf: result.sourcePbf, runtimeImages: { osrm: image }, toolImages: {} },
    };
  },
  async otp({ rootDir, region, service }) {
    const image = serviceImage(service);
    log.info(`Building OTP graph with ${image}`);
    const result = await buildOtpGraph({ rootDir, region, image });
    return {
      summary: `Built OTP graph → ${result.graphPath}`,
      warnings:
        result.gtfsFeeds.length === 0 ? ["No GTFS feeds found; built OTP graph with OSM only"] : [],
      artifact: { sourcePbf: result.sourcePbf, runtimeImages: { otp: image }, toolImages: {} },
    };
  },
  async pelias({ rootDir, region, registry, service }) {
    const elasticsearchImage = serviceImage(requireService(registry, "elasticsearch"));
    const placeholderImage = serviceImage(requireService(registry, "pelias-placeholder"));
    const toolImages = {
      schema: coreServices.serviceBuildImageReference(service.manifest, "schema"),
      whosonfirst: coreServices.serviceBuildImageReference(service.manifest, "whosonfirst"),
      openstreetmap: coreServices.serviceBuildImageReference(service.manifest, "openstreetmap"),
    };
    log.info(
      `Building Pelias data/index with ${elasticsearchImage}, ${Object.values(toolImages).join(", ")}, and ${placeholderImage}`,
    );
    const result = await buildPeliasData({
      rootDir,
      region,
      elasticsearchImage,
      placeholderImage,
      schemaImage: toolImages.schema,
      whosonfirstImage: toolImages.whosonfirst,
      openstreetmapImage: toolImages.openstreetmap,
    });
    return {
      summary: `Built Pelias data/index → ${result.peliasDir}`,
      artifact: {
        sourcePbf: result.sourcePbf,
        // The index is read by this Elasticsearch, the store by this placeholder.
        runtimeImages: {
          elasticsearch: elasticsearchImage,
          "pelias-placeholder": placeholderImage,
        },
        toolImages,
      },
    };
  },
  async tileserver({ rootDir, region, service }) {
    const image = coreServices.serviceBuildImageReference(service.manifest, "planetiler");
    log.info(`Building TileServer MBTiles with ${image}`);
    const result = await buildTileMbtiles({ rootDir, region, image });
    log.dim(`Planetiler heap ${result.javaToolOptions}, work dir ${result.workDir}`);
    return {
      summary: `Built TileServer MBTiles → ${result.mbtilesPath}`,
      artifact: {
        sourcePbf: result.sourcePbf,
        runtimeImages: {},
        toolImages: { planetiler: image },
      },
    };
  },
};

async function recordBuild(
  rootDir: string,
  serviceId: string,
  region: string | undefined,
  artifact: ServiceBuildArtifact,
): Promise<void> {
  const revision = await currentRevision(rootDir);
  writeBuildRecord(
    {
      schemaVersion: 1,
      service: serviceId,
      ...(region ? { region } : {}),
      sourcePbf: {
        name: basename(artifact.sourcePbf),
        sizeBytes: statSync(artifact.sourcePbf).size,
      },
      builtAt: new Date().toISOString(),
      ...(revision ? { revision } : {}),
      runtimeImages: artifact.runtimeImages,
      toolImages: artifact.toolImages,
    },
    rootDir,
  );
}

function getServiceBuildHandlers(
  overrides?: Record<string, ServiceBuildHandler>,
): Record<string, ServiceBuildHandler> {
  return {
    ...BUILT_IN_SERVICE_BUILD_HANDLERS,
    ...overrides,
  };
}

export function getManifestBuildTarget(buildCommand: string | undefined): string | undefined {
  if (!buildCommand) return undefined;
  const match = SERVICE_BUILD_COMMAND_RE.exec(buildCommand.trim());
  return match?.[1];
}

export function resolveDataBuildServiceId(kind: string): string | undefined {
  const normalized = kind.trim().toLowerCase();
  if (normalized in BUILT_IN_SERVICE_BUILD_HANDLERS) return normalized;
  return undefined;
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function compareBuildOrder(a: string, b: string): number {
  const aIndex = SERVICE_BUILD_ORDER.indexOf(a as (typeof SERVICE_BUILD_ORDER)[number]);
  const bIndex = SERVICE_BUILD_ORDER.indexOf(b as (typeof SERVICE_BUILD_ORDER)[number]);
  const aRank = aIndex === -1 ? Number.POSITIVE_INFINITY : aIndex;
  const bRank = bIndex === -1 ? Number.POSITIVE_INFINITY : bIndex;
  if (aRank !== bRank) return aRank - bRank;
  return a.localeCompare(b);
}

function validateBuildCommand(service: LoadedService): string {
  const buildCommand = service.manifest.buildCommand;
  if (!buildCommand) {
    throw new Error(`Service "${service.manifest.id}" does not declare a buildCommand`);
  }
  const target = getManifestBuildTarget(buildCommand);
  if (!target) {
    throw new Error(
      `Service "${service.manifest.id}" has unsupported buildCommand "${buildCommand}". Expected "openmapx services build <service-id>"`,
    );
  }
  if (target !== service.manifest.id) {
    throw new Error(
      `Service "${service.manifest.id}" declares buildCommand "${buildCommand}" but targets "${target}"`,
    );
  }
  return buildCommand;
}

async function loadRegistry(rootDir?: string): Promise<{
  registry: coreServices.ServiceRegistry;
  rootDir: string;
}> {
  const paths = repoPaths(rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  return { registry, rootDir: paths.root };
}

function planServiceBuildsWithRegistry(
  registry: coreServices.ServiceRegistry,
  handlers: Record<string, ServiceBuildHandler>,
  opts: PlanServiceBuildsOptions,
): PlannedServiceBuild[] {
  const ids =
    opts.mode === "all"
      ? registry
          .list()
          .filter((service) => service.manifest.buildCommand)
          .map((service) => service.manifest.id)
          .sort(compareBuildOrder)
      : dedupe(opts.serviceIds ?? []);

  return ids.map((id) => {
    const service = requireService(registry, id);
    const buildCommand = validateBuildCommand(service);
    const handler = handlers[id];
    if (!handler) {
      throw new Error(
        `Service "${id}" declares buildCommand "${buildCommand}" but no build handler is implemented`,
      );
    }
    return { id, buildCommand, service, handler };
  });
}

export async function planServiceBuilds(
  opts: PlanServiceBuildsOptions,
): Promise<PlannedServiceBuild[]> {
  const { registry } = await loadRegistry(opts.rootDir);
  return planServiceBuildsWithRegistry(registry, getServiceBuildHandlers(opts.handlers), opts);
}

export async function buildServices(
  opts: BuildServicesOptions,
): Promise<ServiceBuildExecutionResult> {
  const { registry, rootDir } = await loadRegistry(opts.rootDir);
  const plan = planServiceBuildsWithRegistry(
    registry,
    getServiceBuildHandlers(opts.handlers),
    opts,
  );
  const plannedIds = plan.map((item) => item.id);
  const completedIds: string[] = [];
  const failures: ServiceBuildFailure[] = [];

  if (plan.length === 0) {
    log.warn("No buildable services matched the request.");
    return { plannedIds, completedIds, failures };
  }

  log.info(`Build plan: ${plannedIds.join(", ")}`);

  const running = await runningComposeServices(consumersBlockingBuild(plannedIds));
  if (running.length > 0) {
    throw new Error(
      `Refusing to build: ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running. ` +
        `Stop first with \`openmapx services stop ${running.join(" ")}\` — live rebuilds ` +
        `leave the consumer reading stale data until it's restarted.`,
    );
  }

  for (const item of plan) {
    log.dim(`Manifest command → ${item.buildCommand}`);
    try {
      const resolvedRegion = resolveBuildRegion(item.id, opts.region);
      if (resolvedRegion.sourceEnv) {
        log.dim(
          `${item.id}: using region "${resolvedRegion.value}" from $${resolvedRegion.sourceEnv}`,
        );
      }
      const result = await item.handler({
        rootDir,
        region: resolvedRegion.value,
        registry,
        service: item.service,
        motisImport: opts.motisImport,
      });
      for (const warning of result.warnings ?? []) {
        log.warn(`${item.id}: ${warning}`);
      }
      if (result.artifact) {
        await recordBuild(rootDir, item.id, resolvedRegion.value, result.artifact);
      }
      log.ok(result.summary);
      completedIds.push(item.id);
    } catch (error) {
      const failure = {
        id: item.id,
        message: (error as Error).message,
      };
      failures.push(failure);
      if (!opts.continueOnError) {
        throw new Error(`${item.id} build failed: ${failure.message}`);
      }
      log.err(`${item.id} build failed: ${failure.message}`);
    }
  }

  return { plannedIds, completedIds, failures };
}
