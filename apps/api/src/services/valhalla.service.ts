/**
 * Valhalla multi-modal routing service client (walking, cycling, Phase 5).
 */

const VALHALLA_URL = process.env.VALHALLA_URL ?? "http://localhost:8002";

const COSTING_MAP: Record<string, string> = {
  walking: "pedestrian",
  cycling: "bicycle",
};

export const valhallaService = {
  async route(
    origin: [number, number],
    destination: [number, number],
    mode: "walking" | "cycling",
  ) {
    const body = {
      locations: [
        { lon: origin[0], lat: origin[1] },
        { lon: destination[0], lat: destination[1] },
      ],
      costing: COSTING_MAP[mode],
      directions_options: { units: "km" },
    };
    const res = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Valhalla error ${res.status}`);
    // TODO Phase 5: transform Valhalla response to OpenMapX DirectionsResult shape
    return res.json();
  },
};
