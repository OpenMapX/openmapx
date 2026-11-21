/**
 * The basemap source forests plant from: the vector source behind the style's
 * `landcover` layer, found by source layer as the building masking finds its
 * source (spec §6.3). Its live templates must be http(s) (page-relative counts),
 * which leaves out offline package and custom-protocol sources.
 */

interface StyleLike {
  layers?: readonly object[];
}
type LayerLike = { source?: unknown; "source-layer"?: unknown };

const DEFAULT_MAXZOOM = 14;

function isHttpTemplate(template: string): boolean {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(template)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https";
}

export function findForestSource(
  style: StyleLike | undefined,
  getSource: (id: string) => unknown,
): { templates: string[]; maxzoom: number } | null {
  const layer = (style?.layers as readonly LayerLike[] | undefined)?.find(
    (entry) => entry["source-layer"] === "landcover" && typeof entry.source === "string",
  );
  if (!layer) return null;
  const live = getSource(layer.source as string) as
    | { type?: unknown; tiles?: unknown; maxzoom?: unknown }
    | undefined;
  if (live?.type !== "vector" || !Array.isArray(live.tiles) || live.tiles.length === 0) return null;
  const templates = live.tiles.filter((tile): tile is string => typeof tile === "string");
  if (templates.length !== live.tiles.length || !templates.every(isHttpTemplate)) return null;
  return {
    templates,
    maxzoom: typeof live.maxzoom === "number" ? live.maxzoom : DEFAULT_MAXZOOM,
  };
}
