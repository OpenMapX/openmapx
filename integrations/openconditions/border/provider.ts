import type { BBox } from "@openmapx/core";
import type { BorderCrossing, BorderCrossingProvider } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import { boxAround, createFeatureReader, type Excluded, excludedBy } from "../features/read.js";
import { memberIdsOf, rec, str } from "../features/record.js";
import type { LiveSources } from "../sources.js";
import { recordToBorderCrossing } from "./map.js";

const PROVIDER_ID = "border-crossings-openconditions";
/** Crossings per feature page; a dense area takes more pages, not bigger ones. */
const PAGE = 500;
/** The largest feature page read, in bytes: a crossing carries a reading per queue. */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CROSSINGS = 1000;
/** The most member features read for their opening hours. */
const MAX_MEMBERS = 2000;
/** How many searched crossings the provider remembers the position and members of. */
const REMEMBERED = 2000;
const EXPAND = "components,latest";
/**
 * The farthest apart OpenConditions links two agencies' features of one
 * crossing, in metres: `linking.neverMetres` of `border_crossing` in its
 * model-border. A member stands at most this far from the crossing.
 */
const LINKING_NEVER_M = 2000;
const METRES_PER_DEGREE = 111_320;

/** `bbox` grown by `metres` on every side, clamped to the globe. */
function grown([west, south, east, north]: BBox, metres: number): BBox {
  const dLat = metres / METRES_PER_DEGREE;
  const widest = Math.max(Math.abs(south), Math.abs(north));
  const dLon = dLat / Math.max(Math.cos((Math.min(widest, 89) * Math.PI) / 180), 0.01);
  return [
    Math.max(west - dLon, -180),
    Math.max(south - dLat, -90),
    Math.min(east + dLon, 180),
    Math.min(north + dLat, 90),
  ];
}

export interface BorderCrossingProviderOptions {
  remembered?: number;
  /** The clock a wait's age is judged by. */
  now?: () => Date;
}

/** A member feature's opening hours and the source that states them. */
interface MemberHours {
  source: string;
  hours: string;
}

/**
 * A `border-crossings` provider backed by the OpenConditions feature API:
 * canonical `border_crossing` features, one per crossing whatever the number
 * of agencies publishing its queues, with the readings in effect of each
 * queue and of the crossing. It fails closed on the live source list, as the
 * other place providers do: until the first list arrives it serves no
 * crossing, and after it a source that is not listed is taken out as an
 * excluded source is.
 *
 * A canonical feature carries only its survivor's fields, and only some
 * agencies state a crossing's opening hours (CBP does, CBSA does not). A
 * crossing whose survivor states none takes them from another member that
 * does, read from the per-source features within the linking distance of
 * it, and only when such a crossing is found; a member of an excluded
 * source lends none.
 */
export function createBorderCrossingProvider(
  client: OpenConditionsClient,
  sources: LiveSources,
  options: BorderCrossingProviderOptions = {},
): BorderCrossingProvider {
  const now = options.now ?? (() => new Date());
  const remembered = options.remembered ?? REMEMBERED;
  /** Crossing id → the ids of the per-source features it was built from, oldest first. */
  const members = new Map<string, string[]>();
  const reader = createFeatureReader(client, {
    kind: "border_crossing",
    expand: EXPAND,
    pageSize: PAGE,
    maxBytes: PAGE_MAX_BYTES,
    max: MAX_CROSSINGS,
    remembered,
    map: (record, latest, _offers, excluded) => {
      const crossing = recordToBorderCrossing(record, latest, excluded, sources, now());
      if (crossing) {
        members.delete(crossing.id);
        members.set(crossing.id, memberIdsOf(record));
        if (members.size > remembered) members.delete(members.keys().next().value as string);
      }
      return crossing;
    },
  });

  /** The opening hours the per-source features of `bbox` state, by feature id. */
  async function memberHours(bbox: BBox): Promise<Map<string, MemberHours>> {
    const out = new Map<string, MemberHours>();
    let cursor: string | null = null;
    let read = 0;
    do {
      const page: { records?: unknown; next?: unknown } = await client.get(
        "/features",
        {
          bbox: bbox.join(","),
          kind: "border_crossing",
          canonical: 0,
          limit: PAGE,
          ...(cursor !== null ? { cursor } : {}),
        },
        { maxResponseBytes: PAGE_MAX_BYTES },
      );
      if (!Array.isArray(page.records) || page.records.length === 0) break;
      read += page.records.length;
      for (const entry of page.records) {
        const record = rec(entry);
        const id = str(record.id);
        const source = str(rec(record.provenance).sourceId);
        const hours = str(rec(record.openingHours).osm);
        if (id && source && hours) out.set(id, { source, hours });
      }
      cursor = typeof page.next === "string" ? page.next : null;
    } while (cursor !== null && read < MAX_MEMBERS);
    return out;
  }

  /** The crossing with the hours a member of an admitted source states, when it has none. */
  function withHours(
    crossing: BorderCrossing,
    hours: ReadonlyMap<string, MemberHours>,
    excluded: Excluded,
  ): BorderCrossing {
    if (crossing.openingHours) return crossing;
    const lent = (members.get(crossing.id) ?? [])
      .map((id) => hours.get(id))
      .find((h) => h !== undefined && !excluded(h.source));
    return lent ? { ...crossing, openingHours: lent.hours } : crossing;
  }

  /** The member hours of an area; none when the read fails, since hours are an extra. */
  const hoursIn = (bbox: BBox) => memberHours(bbox).catch(() => new Map<string, MemberHours>());

  /** Whether a crossing lacks hours another of its members may state: it has several. */
  const mayBorrowHours = (crossing: BorderCrossing) =>
    !crossing.openingHours && (members.get(crossing.id)?.length ?? 0) > 1;

  return {
    id: PROVIDER_ID,
    async searchCrossings(bbox, q) {
      // No list yet: every crossing is missing until it arrives, whatever the view.
      if (!sources.ready) return { crossings: [], partial: "unavailable" };
      const excluded = excludedBy(sources, q?.excludedSourceIds);
      const { items, partArea } = await reader.search(bbox, excluded);
      // A member stands at most the linking distance from its crossing, so it may lie just
      // outside the view; read the members only when a crossing could take hours from one.
      const hours = items.some(mayBorrowHours)
        ? await hoursIn(grown(bbox, LINKING_NEVER_M))
        : new Map<string, MemberHours>();
      const crossings = items.map((c) => withHours(c, hours, excluded));
      return partArea ? { crossings, partial: "area" } : { crossings };
    },
    async getCrossing(id, q) {
      if (!sources.ready) return null;
      const excluded = excludedBy(sources, q?.excludedSourceIds);
      const crossing = await reader.open(id, excluded);
      if (!crossing || !mayBorrowHours(crossing)) return crossing;
      const hours = await hoursIn(boxAround(crossing.coordinates, LINKING_NEVER_M));
      return withHours(crossing, hours, excluded);
    },
  };
}
