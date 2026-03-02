/**
 * OpenTripPlanner public transit routing service client (Phase 8).
 */

const OTP_URL = process.env.OTP_URL ?? "http://localhost:8090";

export const otpService = {
  async plan(origin: [number, number], destination: [number, number], date: string, time: string) {
    const params = new URLSearchParams({
      fromPlace: `${origin[1]},${origin[0]}`,
      toPlace: `${destination[1]},${destination[0]}`,
      date,
      time,
      mode: "TRANSIT,WALK",
    });
    const res = await fetch(`${OTP_URL}/otp/routers/default/plan?${params}`);
    if (!res.ok) throw new Error(`OTP error ${res.status}`);
    // TODO Phase 8: transform OTP response to OpenMapX DirectionsResult shape
    return res.json();
  },
};
