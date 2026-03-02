/**
 * OSRM routing service client (car routing, Phase 5).
 */

const OSRM_URL = process.env.OSRM_URL ?? "http://localhost:5000";

export const osrmService = {
  async route(origin: [number, number], destination: [number, number]) {
    const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;
    const url = `${OSRM_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM error ${res.status}`);
    // TODO Phase 5: transform OSRM response to OpenMapX DirectionsResult shape
    return res.json();
  },
};
