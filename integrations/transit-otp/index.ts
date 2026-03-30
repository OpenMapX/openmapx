import type { IntegrationContext } from "@openmapx/core";
import * as otp from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  // Only register if OTP is available
  otp.isOtpAvailable().then((available) => {
    if (!available) return;
    ctx.registerProvider("transit", {
      id: "transit-otp",
      prefix: "otp:",
      coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
      priority: 6,
      async planTrip(params: {
        from: { lat: number; lng: number };
        to: { lat: number; lng: number };
        departureTime?: string;
      }) {
        const now = new Date();
        return otp.plan({
          fromLat: params.from.lat,
          fromLng: params.from.lng,
          toLat: params.to.lat,
          toLng: params.to.lng,
          time: params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19),
          date: params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10),
        });
      },
    });
  });
}
