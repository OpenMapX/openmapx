/** Encode [lng, lat] coordinate pairs into a Google-encoded polyline string. */
export function encodePolyline(coords: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLng = 0;
  let encoded = "";
  for (const [lng, lat] of coords) {
    const roundedLat = Math.round(lat * factor);
    const roundedLng = Math.round(lng * factor);
    encoded += encodeSignedValue(roundedLat - previousLat);
    encoded += encodeSignedValue(roundedLng - previousLng);
    previousLat = roundedLat;
    previousLng = roundedLng;
  }
  return encoded;
}

function encodeSignedValue(value: number): string {
  let remaining = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";
  while (remaining >= 0x20) {
    encoded += String.fromCharCode((0x20 | (remaining & 0x1f)) + 63);
    remaining >>= 5;
  }
  return encoded + String.fromCharCode(remaining + 63);
}

/** Decode a Google-encoded polyline into [lng, lat] coordinate pairs. */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let value = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += value & 1 ? ~(value >> 1) : value >> 1;

    shift = 0;
    value = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += value & 1 ? ~(value >> 1) : value >> 1;

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}
