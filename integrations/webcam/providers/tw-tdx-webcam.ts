import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";
import { credential } from "./webcam-config.js";

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/CCTV";
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

interface TdxCctv {
  CCTVID?: string;
  VideoStreamURL?: string;
  VideoImageURL?: string;
  LookingViews?: Array<{ Bearing?: string; Image?: string }>;
  PositionLat?: number | string;
  PositionLon?: number | string;
  SurveillanceDescription?: string;
  RoadName?: string;
  RoadDirection?: string;
  LocationMile?: string;
}

interface TdxCctvResponse {
  CCTVs?: TdxCctv[];
  Count?: number;
}

let token: { value: string; expiresAt: number; credentialKey: string } | undefined;
let inflightToken: Promise<string | undefined> | undefined;

async function accessToken(): Promise<string | undefined> {
  const clientId = credential("tw-tdx-webcam-client-id");
  const clientSecret = credential("tw-tdx-webcam-client-secret");
  if (!clientId || !clientSecret) return undefined;
  const credentialKey = `${clientId}\0${clientSecret}`;
  if (token && token.credentialKey === credentialKey && token.expiresAt > Date.now())
    return token.value;
  if (inflightToken) return inflightToken;

  inflightToken = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const response = await fetchJson<{ access_token?: string; expires_in?: number }>(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      init: { method: "POST", body: body.toString() },
      timeoutMs: 20_000,
      nullOnError: true,
    });
    if (!response?.access_token) return undefined;
    token = {
      value: response.access_token,
      expiresAt: Date.now() + Math.max((response.expires_in ?? 3600) * 1000 - 60_000, 30_000),
      credentialKey,
    };
    return token.value;
  })().finally(() => {
    inflightToken = undefined;
  });
  return inflightToken;
}

async function fetchTdxNetwork(kind: "Freeway" | "Highway", bearer: string): Promise<TdxCctv[]> {
  const cameras: TdxCctv[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      $top: String(PAGE_SIZE),
      $skip: String(page * PAGE_SIZE),
      $format: "JSON",
    });
    const payload = await fetchJson<TdxCctvResponse>(`${API_BASE}/${kind}?${params}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      timeoutMs: 20_000,
      nullOnError: true,
    });
    const pageCameras = payload?.CCTVs ?? [];
    cameras.push(...pageCameras);
    if (
      pageCameras.length < PAGE_SIZE ||
      (typeof payload?.Count === "number" && cameras.length >= payload.Count)
    )
      break;
  }
  return cameras;
}

export function parseTdxCameras(items: TdxCctv[], network: "freeway" | "highway") {
  return items.flatMap((item) => {
    const id = item.CCTVID ?? "";
    const lat = Number(item.PositionLat);
    const lng = Number(item.PositionLon);
    const image = item.VideoImageURL || item.LookingViews?.find((view) => view.Image)?.Image;
    const stream = item.VideoStreamURL || undefined;
    if (!id || (!image && !stream) || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const description = item.SurveillanceDescription || item.LocationMile;
    return [
      trafficCamera(
        "tw-tdx-webcam",
        `${network}:${id}`,
        description || item.RoadName || `Traffic camera ${id}`,
        [lng, lat],
        "TW",
        {
          thumbnailUrl: image,
          streamUrl: stream,
          direction: item.RoadDirection,
          road: item.RoadName,
        },
      ),
    ];
  });
}

export const twTdxWebcam: CameraSource = {
  sourceId: "tw-tdx-webcam",
  label: "Taiwan TDX",
  coverage: { west: 119, south: 21.5, east: 123, north: 26.5 },
  isEnabled: () =>
    !!credential("tw-tdx-webcam-client-id") && !!credential("tw-tdx-webcam-client-secret"),
  async fetchAll() {
    const bearer = await accessToken();
    if (!bearer) return [];
    const [freeway, highway] = await Promise.all([
      fetchTdxNetwork("Freeway", bearer),
      fetchTdxNetwork("Highway", bearer),
    ]);
    return [...parseTdxCameras(freeway, "freeway"), ...parseTdxCameras(highway, "highway")];
  },
};
