import type { MapConfig } from "@openmapx/core";
import type { FastifyPluginAsync } from "fastify";
import { serviceUrl } from "../services/service-registry";
import { loadMapSettings } from "../utils/map-settings";
import { declareRouteAuth } from "../utils/route-auth";

export const mapConfigRoute: FastifyPluginAsync = async (app) => {
  declareRouteAuth(app, "public");
  app.get("/map-config", async (_request, reply) => {
    const local = Boolean(serviceUrl("tileserver"));
    // Hosted settings cannot affect local vectors. Keep discovery independent of DB health.
    const settings = local
      ? { hostedBasemapProvider: "auto" as const, maptilerApiKey: "" }
      : await loadMapSettings();
    const config: MapConfig = {
      hostedBasemapProvider: settings.hostedBasemapProvider,
      maptilerConfigured: Boolean(settings.maptilerApiKey),
      selfHostedTilesUrl: local ? "/tiles/data/openmapx.json" : "",
      selfHostedGlyphsUrl: local ? "/tiles" : "",
    };
    return reply.header("Cache-Control", "no-store").send(config);
  });
};
