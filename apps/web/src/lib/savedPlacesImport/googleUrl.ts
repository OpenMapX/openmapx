import { validCoordinates } from "./types";

export function decodeUrl(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isGoogleMapsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname;
  if (host === "maps.app.goo.gl") return url.pathname.length > 1;
  if (host === "goo.gl") return /^\/maps\//i.test(url.pathname);
  if (!/^(?:www\.|maps\.)?google\.(?:[a-z]{2,}|(?:com|co)\.[a-z]{2})$/i.test(host)) return false;
  return (
    /^\/maps(?:\/|$)/i.test(url.pathname) ||
    (url.pathname === "/" &&
      (host.startsWith("maps.") ||
        ["q", "query", "cid", "ftid"].some((key) => url.searchParams.has(key))))
  );
}

/** Google feature IDs carry a Hilbert-ordered S2 cell, not an exact POI coordinate. */
export function s2CellCenter(hex: string): { lat: number; lng: number } | undefined {
  if (!/^0x[0-9a-f]{1,16}$/i.test(hex)) return;
  const id = BigInt(hex);
  const face = Number(id >> BigInt(61));
  if (!id || face > 5) return;
  let trailing = 0;
  while (trailing < 64 && ((id >> BigInt(trailing)) & BigInt(1)) === BigInt(0)) trailing++;
  if (trailing > 60 || trailing % 2 !== 0) return;
  const level = 30 - trailing / 2;
  const positions = [
    [0, 1, 3, 2],
    [0, 2, 3, 1],
    [3, 2, 0, 1],
    [3, 1, 0, 2],
  ];
  const orientations = [1, 0, 0, 3];
  let orientation = face & 1;
  let i = 0;
  let j = 0;
  for (let depth = 0; depth < level; depth++) {
    const position = Number((id >> BigInt(59 - 2 * depth)) & BigInt(3));
    const ij = positions[orientation][position];
    i = 2 * i + (ij >> 1);
    j = 2 * j + (ij & 1);
    orientation ^= orientations[position];
  }
  const uv = (s: number) => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) ** 2) / 3);
  const u = uv((i + 0.5) / 2 ** level);
  const v = uv((j + 0.5) / 2 ** level);
  const [x, y, z] = [
    [1, u, v],
    [-u, 1, v],
    [-u, -v, 1],
    [-1, -v, -u],
    [v, -1, -u],
    [v, u, -1],
  ][face];
  return {
    lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
    lng: (Math.atan2(y, x) * 180) / Math.PI,
  };
}

export function coordinatesFromGoogleUrl(url: string): {
  lat?: number;
  lng?: number;
  status: "exact" | "approximate" | "needsLookup";
} {
  const decoded = decodeUrl(url);
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /\/maps\/search\/(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*\+?(-?\d+(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(decoded);
    if (match && validCoordinates(Number(match[1]), Number(match[2])))
      return { lat: Number(match[1]), lng: Number(match[2]), status: "exact" };
  }
  const fid = /(?:!1s|[?&]ftid=)(0x[0-9a-f]+):0x[0-9a-f]+/i.exec(decoded);
  const hint = fid && s2CellCenter(fid[1]);
  if (hint && validCoordinates(hint.lat, hint.lng)) return { ...hint, status: "approximate" };
  return { status: "needsLookup" };
}
export function nameFromGoogleUrl(url: string): string {
  const match = /\/maps\/place\/([^/?#]+)/.exec(url);
  return match ? decodeUrl(match[1].replace(/\+/g, " ")) : "";
}
export function addressFromGoogleUrl(url: string): string {
  const match = /[?&](?:q|query)=([^&#]+)/i.exec(url);
  const query = match ? decodeUrl(match[1].replace(/\+/g, " ")) : "";
  return /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(query) ? "" : query;
}
