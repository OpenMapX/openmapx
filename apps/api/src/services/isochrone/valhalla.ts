import type {
  IsochroneContour,
  IsochroneGeometry,
  IsochroneProvider,
  IsochroneResult,
  IsochroneTravelMode,
} from "./provider.js";

const VALHALLA_URL = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";

const COSTING_MAP: Record<IsochroneTravelMode, string> = {
  driving: "auto",
  walking: "pedestrian",
  cycling: "bicycle",
};

interface ValhallaIsochroneFeature {
  type: "Feature";
  geometry: IsochroneGeometry;
  properties: {
    metric: string;
    contour: number;
    color?: string;
    opacity?: number;
  };
}

interface ValhallaIsochroneResponse {
  type: "FeatureCollection";
  features: ValhallaIsochroneFeature[];
}

function computeGeneralize(maxMinutes: number): number {
  if (maxMinutes <= 15) return 50;
  if (maxMinutes <= 30) return 100;
  return 200;
}

export const valhallaIsochroneProvider: IsochroneProvider = {
  async isochrone(
    origin: [number, number],
    mode: IsochroneTravelMode,
    contourMinutes: number[],
  ): Promise<IsochroneResult> {
    if (contourMinutes.length === 0) {
      return { origin, mode, contours: [] };
    }

    if (contourMinutes.length > 4) {
      throw new Error("Valhalla supports a maximum of 4 contours per request");
    }

    const sorted = [...contourMinutes].sort((a, b) => a - b);
    const maxTime = Math.max(...sorted);

    const body = {
      locations: [{ lon: origin[0], lat: origin[1] }],
      costing: COSTING_MAP[mode],
      contours: sorted.map((time) => ({ time })),
      polygons: true,
      denoise: 1,
      generalize: computeGeneralize(maxTime),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(`${VALHALLA_URL}/isochrone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Valhalla isochrone error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as ValhallaIsochroneResponse;

      const contours: IsochroneContour[] = data.features
        .filter((f) => f.properties.metric === "time")
        .map((f) => ({
          time: f.properties.contour,
          geometry: f.geometry,
        }))
        .sort((a, b) => a.time - b.time);

      return { origin, mode, contours };
    } finally {
      clearTimeout(timeout);
    }
  },
};
