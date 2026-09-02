const EARTH_RADIUS_METRES = 6_378_137;
const MAX_MERCATOR_LATITUDE = 85.051_129;

/** WGS84 to spherical Web Mercator metres. Latitude is clamped to the projection limit. */
export function toWebMercator(lng: number, lat: number): [number, number] {
  const x = (lng * Math.PI * EARTH_RADIUS_METRES) / 180;
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat));
  const y = EARTH_RADIUS_METRES * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
  return [x, y];
}

/** Spherical Web Mercator metres back to WGS84. */
export function fromWebMercator(x: number, y: number): [number, number] {
  const lng = (x * 180) / (Math.PI * EARTH_RADIUS_METRES);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METRES)) - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}
