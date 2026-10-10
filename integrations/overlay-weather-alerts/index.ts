import type { BBox } from "@openmapx/core";
import {
  createHazardsOrchestrator,
  type IntegrationContext,
  scalarQueries,
} from "@openmapx/integration-framework";
import type { HazardAlert } from "@openmapx/mobility-core/hazards";

const CACHE_TTL_S = 60;
const WORLD: BBox = [-180, -90, 180, 90];
/** Polygons are simplified to about a kilometre: the layer is drawn for the whole world at once. */
const SIMPLIFY_DEG = 0.01;

export interface NormalizedFeature {
  type: "Feature";
  geometry: GeoJSON.Geometry;
  properties: {
    id: string;
    title: string;
    severity: string;
    urgency: string;
    certainty: string;
    event: string;
    description: string | null;
    instruction: string | null;
    onset: string | null;
    expires: string | null;
    areaDesc: string;
    /** The feed id of the alert's first source. */
    source: string;
    sourceUrl: string | null;
    geometryType: "polygon" | "point";
    sent: string;
    senderName: string | null;
    notices: string[];
    sources: string[];
  };
}

export interface AlertFeatureCollection {
  type: "FeatureCollection";
  features: NormalizedFeature[];
  /** The feed ids behind the features, for the map credits. */
  sources: string[];
}

function geometryType(geometry: GeoJSON.Geometry): "polygon" | "point" {
  return geometry.type === "Point" || geometry.type === "MultiPoint" ? "point" : "polygon";
}

export function alertToFeature(alert: HazardAlert): NormalizedFeature {
  return {
    type: "Feature",
    geometry: alert.geometry,
    properties: {
      id: alert.id,
      title: alert.headline ?? alert.event,
      severity: alert.severity,
      urgency: alert.urgency,
      certainty: alert.certainty,
      event: alert.event,
      description: alert.description ?? null,
      instruction: alert.instruction ?? null,
      onset: alert.onset ?? alert.effective ?? alert.sent,
      expires: alert.expires ?? null,
      areaDesc: alert.areaDescription ?? "",
      source: alert.sources[0] ?? "",
      sourceUrl: alert.web ?? null,
      geometryType: geometryType(alert.geometry),
      sent: alert.sent,
      senderName: alert.senderName ?? null,
      notices: alert.notices,
      sources: alert.sources,
    },
  };
}

export function alertsToFeatureCollection(alerts: readonly HazardAlert[]): AlertFeatureCollection {
  const sources = new Set<string>();
  for (const alert of alerts) for (const id of alert.sources) sources.add(id);
  return {
    type: "FeatureCollection",
    features: alerts.map(alertToFeature),
    sources: [...sources].sort(),
  };
}

/** The language a text is asked for: one of the app's locales, English otherwise. */
function parseLang(raw: string | undefined): "en" | "de" {
  return raw?.toLowerCase().split("-")[0] === "de" ? "de" : "en";
}

export function setup(ctx: IntegrationContext): void {
  const hazards = createHazardsOrchestrator(ctx);

  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const lang = parseLang(scalarQueries(req.query).lang);
    // Namespaced by the response shape: an entry cached in an older shape must not be served
    // against the new one.
    const key = `weather-alerts:events-v2:${lang}`;

    try {
      const fc = await ctx.cache.withCache(key, CACHE_TTL_S, async () => {
        const { alerts, partial } = await hazards.alerts(WORLD, {
          simplifyDeg: SIMPLIFY_DEG,
          lang,
        });
        // Nothing back from a failed read is not "no alerts": caching it would hide warnings.
        if (partial === "unavailable" && alerts.length === 0) {
          throw new Error("every hazards provider failed");
        }
        return alertsToFeatureCollection(alerts);
      });
      // The route's own cache is the only reuse: MeteoAlarm allows ten minutes behind its
      // site, OC spends five, this cache one and the layer the rest, so no browser cache.
      reply.header("Cache-Control", "no-cache");
      return reply.send(fc);
    } catch (err) {
      ctx.log.error("Failed to read weather alerts", err);
      reply.header("Cache-Control", "no-store");
      return reply.status(503).send({ message: "Weather alert data temporarily unavailable" });
    }
  });
}
