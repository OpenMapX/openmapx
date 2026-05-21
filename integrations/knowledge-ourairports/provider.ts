import type { AirportInfo, KnowledgeResult, KnowledgeSource, LngLat } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import { lookupAirport, lookupNearestAerodrome } from "./data.js";

/**
 * Aeroway values that represent the airport entity itself. These get matched
 * by code only — IATA/ICAO from the OSM tags. No spatial fallback, because the
 * tags are typically present and the entity *is* the thing we'd be matching.
 */
const AIRPORT_ENTITY_AEROWAYS = new Set(["aerodrome", "heliport"]);

/**
 * Aeroway values that represent airport *infrastructure* — physically part of
 * an airport but distinct OSM features. Restaurants, shops, and other tenants
 * never carry `aeroway=...` so this gate never matches them, while terminals
 * and runways are reliably enriched with their parent airport's data.
 *
 * Excluded on purpose: `navigationaid`, `windsock`, `fuel`, `beacon`. These
 * can be standalone (a VOR or NDB unrelated to any airport) and the spatial
 * fallback could attach the wrong airport.
 */
const AIRPORT_INFRA_AEROWAYS = new Set([
  "terminal",
  "runway",
  "taxiway",
  "apron",
  "gate",
  "hangar",
  "tower",
  "control_tower",
  "control_center",
  "jet_bridge",
  "helipad",
  "holding_position",
  "parking_position",
  "stopway",
]);

/** Max distance from an infra feature to its parent aerodrome (km). */
const SPATIAL_FALLBACK_MAX_KM = 10;

export function createOurAirportsSource(log: Logger): KnowledgeSource {
  return {
    name: "ourairports",
    async lookup(osmTags, _lang, context) {
      const aeroway = osmTags.aeroway;
      if (!aeroway) return null;

      const isEntity = AIRPORT_ENTITY_AEROWAYS.has(aeroway);
      const isInfra = AIRPORT_INFRA_AEROWAYS.has(aeroway);
      if (!isEntity && !isInfra) return null;

      // Try code-based lookup first — works when the OSM feature carries
      // IATA/ICAO tags, which is the common case for aerodromes and is
      // sometimes the case for terminals/runways too.
      let info = await lookupAirport(log, {
        iata: osmTags.iata ?? osmTags["ref:iata"],
        icao: osmTags.icao ?? osmTags["ref:icao"],
        ident: osmTags.ident ?? osmTags.ref,
        gpsCode: osmTags.gps_code,
        localCode: osmTags.faa ?? osmTags["ref:faa"],
      });

      // Spatial fallback — only for infrastructure features without code tags.
      // We do NOT fall back spatially for `aeroway=aerodrome` features that
      // failed code lookup; the absence of a code on the airport entity itself
      // implies low data quality and matching anything nearby would be misleading.
      if (!info && isInfra && context?.coordinates) {
        info = await lookupNearestAerodrome(
          log,
          context.coordinates as LngLat,
          SPATIAL_FALLBACK_MAX_KM,
        );
      }

      if (!info) return null;
      return { airport: pickRelevantFields(info, aeroway) };
    },
  };
}

/**
 * Heliports never have runway tables. For all other airport features we
 * surface the parent airport's full record so the user sees runways +
 * frequencies + navaids regardless of which infra feature they clicked.
 */
function pickRelevantFields(info: AirportInfo, aeroway: string): AirportInfo {
  if (aeroway === "heliport" || (info.type === "heliport" && aeroway === "helipad")) {
    return { ...info, runways: undefined };
  }
  return info;
}

export type { KnowledgeResult };
