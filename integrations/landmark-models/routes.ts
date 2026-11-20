import type {
  IntegrationContext,
  LandmarkModelProvider,
  RouteHandler,
} from "@openmapx/integration-framework";
import {
  type MergedIndex,
  mergeProviders,
  type ProviderSnapshot,
  parseHiddenAssets,
  toCellResponse,
} from "./merge";
import { CELL_ZOOM, type CoverageResponse } from "./wire";

const DOMAIN = "landmark-models";
const MAX_CELL = 2 ** CELL_ZOOM - 1;

/**
 * The placements and footprints republished here come from the providers'
 * own ODbL databases, derived from OpenStreetMap.
 */
const LICENCE: CoverageResponse["licence"] = {
  name: "ODbL-1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  notice:
    "Landmark placements and footprints from Landmarks (Barrelman) and Open Landmarks, © OpenStreetMap contributors, ODbL 1.0. The source data stays available from each provider's published catalogue. Filtered by OpenMapX's overlap rule and this instance's hidden-asset list.",
};

export interface LandmarkIndexSource {
  /** The merged index for the current provider catalogues and policy. */
  current(): Promise<MergedIndex>;
}

/** Enabled `landmark-models` providers, looked up per request. */
export function landmarkProviders(ctx: IntegrationContext): LandmarkModelProvider[] {
  return ctx
    .getIntegrationsByDomain(DOMAIN)
    .flatMap((integration) => (integration.providers.get(DOMAIN) ?? []) as LandmarkModelProvider[]);
}

export function createLandmarkIndexSource(ctx: IntegrationContext): LandmarkIndexSource {
  const hidden = parseHiddenAssets(ctx.config.hiddenAssets);
  let cached: { key: string; index: MergedIndex } | null = null;
  return {
    async current() {
      const input: ProviderSnapshot[] = landmarkProviders(ctx).map((provider) => ({
        providerId: provider.id,
        snapshot: provider.snapshot(),
      }));
      const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
      const key = JSON.stringify([
        input.map((p) => [p.providerId, p.snapshot?.release ?? null, p.snapshot?.assets.length]),
        [...disallowed].sort(),
      ]);
      if (cached?.key !== key) {
        cached = { key, index: mergeProviders(input, hidden, disallowed) };
      }
      return cached.index;
    },
  };
}

function noStoreError(
  reply: Parameters<RouteHandler>[1],
  status: number,
  error: string,
  code: string,
): void {
  reply.header("Cache-Control", "no-store");
  reply.status(status).send({ error, code });
}

function parseCell(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,4}$/.test(value)) return null;
  const n = Number(value);
  return n <= MAX_CELL ? n : null;
}

export function createRoutes(source: LandmarkIndexSource): {
  coverage: RouteHandler;
  cell: RouteHandler;
} {
  return {
    async coverage(_req, reply) {
      const index = await source.current();
      const body: CoverageResponse = {
        revision: index.revision,
        complete: index.complete,
        cellZoom: CELL_ZOOM,
        occupied: [...index.cells.keys()].sort(),
        providers: index.providers,
        licence: LICENCE,
      };
      reply.header("Cache-Control", index.complete ? "public, max-age=300" : "no-store");
      reply.send(body);
    },
    async cell(req, reply) {
      const x = parseCell(req.params.x);
      const y = parseCell(req.params.y);
      if (x === null || y === null) {
        noStoreError(reply, 400, "Cell coordinates must be z12 tile integers", "INVALID_CELL");
        return;
      }
      const index = await source.current();
      const requested = typeof req.query.r === "string" ? req.query.r : undefined;
      const cacheable = index.complete && requested === index.revision;
      reply.header("Cache-Control", cacheable ? "public, max-age=86400" : "no-store");
      reply.send(toCellResponse(index, `${x}/${y}`));
    },
  };
}
