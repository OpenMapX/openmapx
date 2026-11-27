import type {
  IsochroneContour,
  IsochroneGeometry,
  IsochroneResult,
  IsochroneTravelMode,
} from "@openmapx/provider-kit/routing";

/** POSTs JSON to the generation's Valhalla instance, as the routing provider does. */
export interface ValhallaPoster {
  post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<T>;
}

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

/** Valhalla's own limit on contours in one request. */
const MAX_CONTOURS = 4;

const ISOCHRONE_TIMEOUT_MS = 15_000;

/** Coarser outlines for larger areas, in metres, so big contours stay small on the wire. */
function generalizeFor(maxMinutes: number): number {
  if (maxMinutes <= 15) return 50;
  if (maxMinutes <= 30) return 100;
  return 200;
}

/**
 * Time contours around `origin` from Valhalla's `/isochrone`, in ascending
 * time. Credits are left to the caller, which knows the answering endpoint's
 * declared sources.
 */
export async function requestValhallaIsochrone(
  client: ValhallaPoster,
  costing: string,
  origin: [number, number],
  mode: IsochroneTravelMode,
  contourMinutes: number[],
): Promise<IsochroneResult> {
  if (contourMinutes.length === 0) return { origin, mode, contours: [] };
  if (contourMinutes.length > MAX_CONTOURS) {
    throw new Error(`Valhalla supports a maximum of ${MAX_CONTOURS} contours per request`);
  }

  const sorted = [...contourMinutes].sort((a, b) => a - b);
  const data = await client.post<ValhallaIsochroneResponse>(
    "/isochrone",
    {
      locations: [{ lon: origin[0], lat: origin[1] }],
      costing,
      contours: sorted.map((time) => ({ time })),
      polygons: true,
      denoise: 1,
      generalize: generalizeFor(Math.max(...sorted)),
    },
    ISOCHRONE_TIMEOUT_MS,
    "Valhalla isochrone error",
  );

  const contours: IsochroneContour[] = data.features
    .filter((feature) => feature.properties.metric === "time")
    .map((feature) => ({ time: feature.properties.contour, geometry: feature.geometry }))
    .sort((a, b) => a.time - b.time);
  return { origin, mode, contours };
}
