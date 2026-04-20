import { services as coreServices } from "@openmapx/core/server";
import { resolveBuildRegion } from "./env-defaults";
import { buildMotisData } from "./motis-data";
import { buildOsrmGraph } from "./osrm-graph";
import { buildOtpGraph } from "./otp-graph";
import { log } from "./output";
import { repoPaths } from "./paths";
import {
  buildPeliasData,
  DEFAULT_PELIAS_OPENSTREETMAP_IMAGE,
  DEFAULT_PELIAS_SCHEMA_IMAGE,
  DEFAULT_PELIAS_WHOSONFIRST_IMAGE,
} from "./pelias-data";
import { buildTileMbtiles, DEFAULT_PLANETILER_IMAGE } from "./tile-mbtiles";

const { ServiceRegistry } = coreServices;
type LoadedService = coreServices.LoadedService;

const SERVICE_BUILD_COMMAND_RE = /^openmapx\s+services\s+build\s+([a-z0-9-]+)$/;

export const SERVICE_BUILD_ORDER = ["osrm", "otp", "motis", "pelias", "tileserver"] as const;

export interface ServiceBuildContext {
  rootDir: string;
  region?: string;
  registry: coreServices.ServiceRegistry;
  service: LoadedService;
}

export interface ServiceBuildHandlerResult {
  summary: string;
  warnings?: string[];
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
}

function serviceImage(service: LoadedService): string {
  return `${service.manifest.container.image}:${service.manifest.container.tag}`;
}

function requireService(registry: coreServices.ServiceRegistry, id: string): LoadedService {
  const service = registry.get(id);
  if (!service) throw new Error(`Service manifest not found: ${id}`);
  return service;
}

const BUILT_IN_SERVICE_BUILD_HANDLERS: Record<string, ServiceBuildHandler> = {
  async motis({ rootDir, region }) {
    log.info("Building MOTIS prepared data with Transitous tools");
    const result = await buildMotisData({ rootDir, region });
    return {
      summary: `Built MOTIS prepared data → ${result.motisDir}`,
      warnings:
        result.gtfsFeeds.length === 0
          ? ["No GTFS feeds found; staged MOTIS data with OSM only"]
          : [],
    };
  },
  async osrm({ rootDir, region, service }) {
    const image = serviceImage(service);
    log.info(`Building OSRM graph with ${image}`);
    const result = await buildOsrmGraph({ rootDir, region, image });
    return { summary: `Built OSRM graph → ${result.graphPath}` };
  },
  async otp({ rootDir, region, service }) {
    const image = serviceImage(service);
    log.info(`Building OTP graph with ${image}`);
    const result = await buildOtpGraph({ rootDir, region, image });
    return {
      summary: `Built OTP graph → ${result.graphPath}`,
      warnings:
        result.gtfsFeeds.length === 0 ? ["No GTFS feeds found; built OTP graph with OSM only"] : [],
    };
  },
  async pelias({ rootDir, region, registry }) {
    const elasticsearch = requireService(registry, "elasticsearch");
    const placeholder = requireService(registry, "pelias-placeholder");
    const elasticsearchImage = serviceImage(elasticsearch);
    const placeholderImage = serviceImage(placeholder);
    log.info(
      `Building Pelias data/index with ${elasticsearchImage}, ${DEFAULT_PELIAS_SCHEMA_IMAGE}, ${DEFAULT_PELIAS_WHOSONFIRST_IMAGE}, ${DEFAULT_PELIAS_OPENSTREETMAP_IMAGE}, and ${placeholderImage}`,
    );
    const result = await buildPeliasData({
      rootDir,
      region,
      elasticsearchImage,
      placeholderImage,
    });
    return { summary: `Built Pelias data/index → ${result.peliasDir}` };
  },
  async tileserver({ rootDir, region }) {
    log.info(`Building TileServer MBTiles with ${DEFAULT_PLANETILER_IMAGE}`);
    const result = await buildTileMbtiles({ rootDir, region });
    return { summary: `Built TileServer MBTiles → ${result.mbtilesPath}` };
  },
};

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
  if (normalized === "tiles") return "tileserver";
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
      });
      for (const warning of result.warnings ?? []) {
        log.warn(`${item.id}: ${warning}`);
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
