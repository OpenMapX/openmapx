import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import { isOtpAvailable, motisModesToOtp, plan, setOtpUrl } from "./provider.js";

const { attribution, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  // Resolve OTP URL from the service registry if available.
  const resolved = ctx.getRequiredService("otp");
  const url =
    resolved?.url ?? (ctx.config.endpoint as string | undefined) ?? "http://localhost:8090";
  setOtpUrl(url);

  // Only register if OTP is available
  void isOtpAvailable()
    .then((available) => {
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
          // OTP groups all heavy rail under RAIL, so it can't exclude
          // long-distance trains — it can't honour the Deutschlandticket filter.
          // Defer to a provider that can (MOTIS/db-vendo) rather than leak ICE/IC
          // into a D-Ticket result.
          if (params.deutschlandticketOnly) return wrapRT([]);
          const now = new Date();
          const arriveBy = params.arrivalTime != null;
          const when = arriveBy ? params.arrivalTime : params.departureTime;
          const result = await plan({
            fromLat: params.from.lat,
            fromLng: params.from.lng,
            toLat: params.to.lat,
            toLng: params.to.lng,
            time: when?.slice(11, 19) ?? now.toISOString().slice(11, 19),
            date: when?.slice(0, 10) ?? now.toISOString().slice(0, 10),
            modes: motisModesToOtp(params.modes),
            numItineraries: params.numItineraries,
            arriveBy,
          });
          return wrapRT(result ? [result] : []);
        },
      });
    })
    .catch(() => undefined);
}
