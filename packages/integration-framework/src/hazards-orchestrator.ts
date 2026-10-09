import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import {
  type CollectionOrchestrator,
  coversBbox,
  createCollectionOrchestrator,
} from "./collection-orchestrator";
import type { IntegrationContext } from "./context";
import type {
  FireDensityCell,
  FirePixel,
  HazardAlert,
  HazardsProvider,
  NaturalHazard,
} from "./contracts/hazards-provider.js";

type AlertQuery = Parameters<HazardsProvider["getAlerts"]>[1];
type NaturalHazardQuery = Parameters<HazardsProvider["getNaturalHazards"]>[1];
type FirePixelQuery = Parameters<HazardsProvider["getFirePixels"]>[1];
type FireDensityQuery = Parameters<HazardsProvider["getFireDensity"]>[1];

interface WithPartial {
  partial?: DataSourcePartialReason;
}

/** A density cell with the sources its provider built the cells from. */
type SourcedCell = FireDensityCell & { sources: readonly string[] };

export interface HazardsOrchestrator {
  /** The current alerts of every provider, geometry simplified when `simplifyDeg` is set. */
  alerts(bbox: BBox, query?: AlertQuery): Promise<{ alerts: HazardAlert[] } & WithPartial>;
  naturalHazards(
    bbox: BBox,
    query: NaturalHazardQuery,
  ): Promise<{ hazards: NaturalHazard[] } & WithPartial>;
  firePixels(bbox: BBox, query: FirePixelQuery): Promise<{ pixels: FirePixel[] } & WithPartial>;
  fireDensity(
    bbox: BBox,
    query: FireDensityQuery,
  ): Promise<{ cells: FireDensityCell[]; sources: string[] } & WithPartial>;
}

/** A bbox across the antimeridian as the two boxes either side of it. */
function splitAntimeridian(bbox: BBox): BBox[] {
  const [west, south, east, north] = bbox;
  if (west <= east) return [bbox];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

function mergePartial(
  reasons: readonly (DataSourcePartialReason | undefined)[],
): DataSourcePartialReason | undefined {
  if (reasons.includes("area")) return "area";
  if (reasons.includes("unavailable")) return "unavailable";
  return undefined;
}

/**
 * A read of one box, or "unavailable" when no hazards provider covers it: a
 * map with no source of hazards must not read as one with no hazards.
 */
function coveredRead<TItem, TQuery>(
  orchestrator: CollectionOrchestrator<HazardsProvider, TItem, TQuery>,
  query: TQuery | undefined,
): (half: BBox) => Promise<{ items: TItem[]; partial?: DataSourcePartialReason }> {
  return async (half) =>
    orchestrator.providers().some((p) => coversBbox(p.coverage, half))
      ? orchestrator.read(half, query)
      : { items: [], partial: "unavailable" };
}

/** Runs a read over each half of the bbox and merges the answers; the first copy of an id wins. */
async function readHalves<T extends { id: string }>(
  bbox: BBox,
  read: (half: BBox) => Promise<{ items: T[]; partial?: DataSourcePartialReason }>,
): Promise<{ items: T[]; partial?: DataSourcePartialReason }> {
  const answers = await Promise.all(splitAntimeridian(bbox).map(read));
  const byId = new Map<string, T>();
  for (const answer of answers) {
    for (const item of answer.items) if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const partial = mergePartial(answers.map((a) => a.partial));
  return partial ? { items: [...byId.values()], partial } : { items: [...byId.values()] };
}

/**
 * Merges every hazards provider behind four whole-area reads. A view that
 * crosses the antimeridian is read as two boxes, because providers take
 * `west <= east`. Stateless: the providers are read from the context at each
 * call.
 */
export function createHazardsOrchestrator(ctx: IntegrationContext): HazardsOrchestrator {
  const alerts = createCollectionOrchestrator<
    HazardsProvider,
    HazardAlert,
    NonNullable<AlertQuery>
  >(ctx, {
    domain: "hazards",
    logPrefix: "hazards",
    name: "getAlerts",
    run: async (provider, bbox, query) => {
      const { alerts: items, partial } = await provider.getAlerts(bbox, query);
      return partial ? { items, partial } : { items };
    },
    sourcesOf: (alert) => alert.sources,
  });
  const naturalHazards = createCollectionOrchestrator<
    HazardsProvider,
    NaturalHazard,
    NaturalHazardQuery
  >(ctx, {
    domain: "hazards",
    logPrefix: "hazards",
    name: "getNaturalHazards",
    run: async (provider, bbox, query) => {
      const { hazards: items, partial } = await provider.getNaturalHazards(
        bbox,
        query as NaturalHazardQuery,
      );
      return partial ? { items, partial } : { items };
    },
    sourcesOf: (hazard) => hazard.sources,
  });
  const firePixels = createCollectionOrchestrator<HazardsProvider, FirePixel, FirePixelQuery>(ctx, {
    domain: "hazards",
    logPrefix: "hazards",
    name: "getFirePixels",
    run: async (provider, bbox, query) => {
      const { pixels: items, partial } = await provider.getFirePixels(
        bbox,
        query as FirePixelQuery,
      );
      return partial ? { items, partial } : { items };
    },
    sourcesOf: (pixel) => pixel.sources,
  });
  const fireDensity = createCollectionOrchestrator<HazardsProvider, SourcedCell, FireDensityQuery>(
    ctx,
    {
      domain: "hazards",
      logPrefix: "hazards",
      name: "getFireDensity",
      run: async (provider, bbox, query) => {
        const { cells, sources, partial } = await provider.getFireDensity(
          bbox,
          query as FireDensityQuery,
        );
        const items = cells.map((cell) => ({ ...cell, sources }));
        return partial ? { items, partial } : { items };
      },
      sourcesOf: (cell) => cell.sources,
    },
  );

  return {
    async alerts(bbox, query) {
      const { items, partial } = await readHalves(bbox, coveredRead(alerts, query));
      return partial ? { alerts: items, partial } : { alerts: items };
    },

    async naturalHazards(bbox, query) {
      const { items, partial } = await readHalves(bbox, coveredRead(naturalHazards, query));
      return partial ? { hazards: items, partial } : { hazards: items };
    },

    async firePixels(bbox, query) {
      const { items, partial } = await readHalves(bbox, coveredRead(firePixels, query));
      return partial ? { pixels: items, partial } : { pixels: items };
    },

    async fireDensity(bbox, query) {
      const answers = await Promise.all(
        splitAntimeridian(bbox).map(coveredRead(fireDensity, query)),
      );
      const cells: FireDensityCell[] = [];
      const sources = new Set<string>();
      for (const answer of answers) {
        for (const { sources: cellSources, ...cell } of answer.items) {
          cells.push(cell);
          for (const id of cellSources) sources.add(id);
        }
      }
      const partial = mergePartial(answers.map((a) => a.partial));
      return partial ? { cells, sources: [...sources], partial } : { cells, sources: [...sources] };
    },
  };
}
