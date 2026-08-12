import type { IntegrationContext } from "@openmapx/integration-framework";
import { type FirmsDayRange, type FirmsSource, loadFirms } from "./firms.js";

export { csvToGeoJSON, parseAcqDateTime } from "./firms.js";

const DAY_RANGES: FirmsDayRange[] = [1, 2, 3];
const SOURCES: FirmsSource[] = ["VIIRS_SNPP_NRT", "MODIS_NRT"];

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/wildfires", async (req, reply) => {
    const dayRange = Number.parseInt(req.query.dayRange ?? "1", 10);
    const source = req.query.source ?? "VIIRS_SNPP_NRT";

    if (!DAY_RANGES.includes(dayRange as FirmsDayRange)) {
      reply.status(400).send({ message: "Invalid dayRange (1-3)" });
      return;
    }
    if (!SOURCES.includes(source as FirmsSource)) {
      reply.status(400).send({ message: "Invalid source" });
      return;
    }

    if (!ctx.config.firmsApiKey) {
      ctx.log.warn("FIRMS map key not configured");
      reply.status(503).send({ message: "Wildfire data not configured" });
      return;
    }

    try {
      const data = await loadFirms(ctx, {
        dayRange: dayRange as FirmsDayRange,
        source: source as FirmsSource,
      });
      reply.send(data);
    } catch (error) {
      ctx.log.error("Failed to fetch FIRMS data", error);
      reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
    }
  });
}
