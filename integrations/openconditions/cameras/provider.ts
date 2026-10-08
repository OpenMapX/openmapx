import type { CameraProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import type { SiteEvidenceReader } from "../evidence/read.js";
import { createFeatureReader, excludedBy } from "../features/read.js";
import type { MediaSources } from "../sources.js";
import { recordToCamera } from "./map.js";

const PROVIDER_ID = "cameras-openconditions";
/** Cameras per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 500;
/** The largest feature page read, in bytes: a camera with its views and stills is small. */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CAMERAS = 2000;
/** How many searched cameras the provider remembers the position of. */
const REMEMBERED = 10_000;
const EXPAND = "components,latest";

export interface CameraProviderOptions {
  /** How many searched cameras to remember; 10,000 by default. */
  remembered?: number;
  /** The clock readings are judged stale by. */
  now?: () => Date;
  /** The coverage evidence reader, shared with the place providers; without it the provider has no operational evidence. */
  evidence?: SiteEvidenceReader;
}

/**
 * A `cameras` provider backed by the OpenConditions feature API: canonical
 * `camera` features (read by kind; their records sit in the roads domain)
 * with their views and current stills. A camera OpenConditions linked across
 * sources lists every member's views. On-demand sources (OpenStreetMap,
 * Windy) are fetched by OpenConditions as the read asks for them, and their
 * records expire, so a searched camera is opened from a fresh read of the box
 * around it.
 *
 * It fails closed on the live source list (`sources`), as the other place
 * providers do: until the first list arrives it serves no camera, and after
 * it a source that is not listed is taken out of every camera as an excluded
 * source is. The list's media hosts decide which stills are kept (see
 * `recordToCamera`). A search keeps up to 2000 cameras; a `types` filter is
 * applied to them. Its operational evidence is OpenConditions' account of
 * the camera feeds.
 */
export function createCameraProvider(
  client: OpenConditionsClient,
  sources: MediaSources,
  options: CameraProviderOptions = {},
): CameraProvider {
  const now = options.now ?? (() => new Date());
  const evidence = options.evidence;
  const reader = createFeatureReader(client, {
    kind: "camera",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_CAMERAS,
    remembered: options.remembered ?? REMEMBERED,
    map: (record, latest, _offers, excluded) =>
      recordToCamera(record, latest, excluded, sources, now()),
  });

  return {
    id: PROVIDER_ID,
    async searchCameras(bbox, q) {
      // No list yet: every camera is missing until it arrives, whatever the view.
      if (!sources.ready) return { cameras: [], partial: "unavailable" };
      const { items, partArea } = await reader.search(
        bbox,
        excludedBy(sources, q?.excludedSourceIds),
      );
      const types = q?.types && q.types.length > 0 ? new Set(q.types) : undefined;
      const cameras = types ? items.filter((camera) => types.has(camera.type)) : items;
      return partArea ? { cameras, partial: "area" } : { cameras };
    },
    async getCamera(id, q) {
      if (!sources.ready) return null;
      return reader.open(id, excludedBy(sources, q?.excludedSourceIds));
    },
    ...(evidence ? { getOperationalEvidence: () => evidence.read("cameras") } : {}),
  };
}
