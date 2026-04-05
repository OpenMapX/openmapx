/** Encode [lng, lat] coordinate pairs into a Google-encoded polyline string. */
export function encodePolyline(coords: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let result = "";
  for (const [lng, lat] of coords) {
    const latRound = Math.round(lat * factor);
    const lngRound = Math.round(lng * factor);
    result += encodeSignedValue(latRound - prevLat);
    result += encodeSignedValue(lngRound - prevLng);
    prevLat = latRound;
    prevLng = lngRound;
  }
  return result;
}

function encodeSignedValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/** Decode a Google-encoded polyline into [lng, lat] coordinate pairs (GeoJSON order). */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}
