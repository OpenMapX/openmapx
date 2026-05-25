import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { isOtpAvailable, plan, setOtpUrl } from "./provider.js";

const attribution = createManifestAttribution();
const wrapRT = <T>(data: T) =>
  withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  // Resolve OTP URL from the service registry if available.
  const resolved = ctx.getRequiredService("otp");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8090";
  setOtpUrl(url);

  // Only register if OTP is available
  isOtpAvailable().then((available) => {
    if (!available) return;
    ctx.registerTransitProvider({
      id: "transit-otp",
      prefix: "otp:",
      coverage: { all: true },
      priority: 6,
      attribution: attribution.all(),
      capabilities: {
        stops: {
          lookup: false,
          nearby: false,
          bbox: false,
          search: false,
          infrastructure: false,
          platforms: false,
          timetable: false,
        },
        departures: false,
        arrivals: false,
        routes: { lookup: false, forStop: false, stops: false, geometry: false },
        planning: true,
        vehiclePositions: false,
        vehicleJourney: false,
        alerts: { byStop: false, byRoute: false, byBbox: false },
        facilities: false,
      },
      async planTrip(params) {
        const now = new Date();
        const result = await plan({
          fromLat: params.from.lat,
          fromLng: params.from.lng,
          toLat: params.to.lat,
          toLng: params.to.lng,
          time: params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19),
          date: params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10),
        });
        return wrapRT(result ? [result] : []);
      },
    });
  });
}
