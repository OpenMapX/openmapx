"use client";

export function getTrafficMinZoom(): number {
  const parsed = Number(process.env.NEXT_PUBLIC_TRAFFIC_MIN_ZOOM ?? "10");
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 22) {
    return parsed;
  }
  return 10;
}

export const TRAFFIC_MIN_ZOOM = getTrafficMinZoom();

export function getTrafficTileTemplate(): string {
  const configured = process.env.NEXT_PUBLIC_TRAFFIC_TILE_URL_TEMPLATE;
  if (configured) return configured;

  const apiBase = process.env.NEXT_PUBLIC_API_URL;
  if (apiBase) {
    const normalized = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
    return `${normalized}/api/traffic/flow/{z}/{x}/{y}.png`;
  }

  return "/api/traffic/flow/{z}/{x}/{y}.png";
}
