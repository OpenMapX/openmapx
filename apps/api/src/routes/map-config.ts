import type { MapConfig } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { serviceUrl } from "../services/service-registry";
import { tileserverDatasets } from "../services/tileserver-datasets";
import { loadMapSettings } from "../utils/map-settings";
import { declareRouteAuth } from "../utils/route-auth";

export const mapConfigRoute: FastifyPluginAsync = async (app) => {
  declareRouteAuth(app, "public");
  app.get("/map-config", async (_request, reply) => {
    const tileserver = Boolean(serviceUrl("tileserver"));
    // Advertise what the tileserver serves. While it cannot be asked, keep the
    // self-hosted basemap and leave street detail out.
    const datasets = tileserver ? await tileserverDatasets() : null;
    const local = tileserver && (datasets?.basemap ?? true);
    // Hosted settings cannot affect local vectors. Keep discovery independent of DB health.
    const settings = local
      ? { hostedBasemapProvider: "auto" as const, maptilerApiKey: "" }
      : await loadMapSettings();
    const config: MapConfig = {
      hostedBasemapProvider: settings.hostedBasemapProvider,
      maptilerConfigured: Boolean(settings.maptilerApiKey),
      selfHostedTilesUrl: local ? "/tiles/data/openmapx.json" : "",
      selfHostedGlyphsUrl: local ? "/tiles" : "",
      streetDetailTilesUrl: datasets?.streetDetail ? "/tiles/data/street_detail.json" : "",
    };
    return reply.header("Cache-Control", "no-store").send(config);
  });
};
