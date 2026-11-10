import { type BBox, geoJsonBBox, setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import {
  type CarCamera,
  type CarNativeToWebMessage,
  type CarViewport,
  type CarWebToNativeMessage,
  groundStartPackageSchema,
  parseCarSurfaceMessage,
} from "@openmapx/core/navigation";
import type { Map as LibreMap } from "maplibre-gl";
import {
  applyNativeSnapshot,
  envelopeOf,
  type NativeReadModel,
  projectionOf,
} from "@/lib/mobile/nativeSnapshotReducer";

export interface CarHost {
  postMessage(data: string): void;
  onmessage?: ((event: { data: string }) => void) | null;
}
export function carLayout(viewport: CarViewport) {
  const { stable: s, width, height } = viewport;
  const safeWidth = width - s.left - s.right;
  const safeHeight = height - s.top - s.bottom;
  const compact = safeWidth < 500 || safeHeight < 300;
  const margin = Math.min(16, safeWidth / 16, safeHeight / 16);
  // Host insets are hard constraints; unlike phone chrome they must never be scaled away.
  const padding = {
    left: s.left + margin,
    right: s.right + margin,
    top: s.top + margin + Math.max(0, safeHeight - margin * 2) * (compact ? 0.12 : 0.4),
    bottom: s.bottom + margin,
  };
  return { padding, compact, maxPitch: compact ? 25 : 55 };
}
/**
 * Margin around framed content: generous on a full screen, small when the host leaves
 * only a narrow strip free (a split screen beside a list and a media panel), so the
 * content still fills what is visible.
 */
export function carFitMargin(
  size: { width: number; height: number },
  stable: CarViewport["stable"],
) {
  const free = Math.min(
    size.width - stable.left - stable.right,
    size.height - stable.top - stable.bottom,
  );
  return Math.max(8, Math.min(48, Math.round(free * 0.08)));
}

/**
 * Frames bounds inside the host's stable area. MapLibre adds fitBounds padding to the
 * camera's own padding, which follow mode leaves large, so that is cleared first.
 */
export function fitCarBounds(
  map: LibreMap,
  [west, south, east, north]: BBox,
  stable: CarViewport["stable"],
  duration: number,
) {
  map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 }, { programmatic: true });
  const canvas = map.getCanvas();
  const margin = carFitMargin({ width: canvas.clientWidth, height: canvas.clientHeight }, stable);
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      padding: {
        top: stable.top + margin,
        right: stable.right + margin,
        bottom: stable.bottom + margin,
        left: stable.left + margin,
      },
      pitch: 0,
      bearing: 0,
      duration,
      maxZoom: 16,
    },
    { programmatic: true },
  );
}
/** Car labels are read at arm's length: plain labels at 24 px. */
const CAR_LABEL_PX = 24;
/** Labels inside an image, such as road shields, grow with their image instead. */
const CAR_ICON_LABEL_SCALE = 1.6;

/**
 * Text and icon sizes for a symbol layer on the car map. Shield images have a fixed
 * width per reference length, so their text must scale with the image, not on its own.
 */
export function carLabelSize(layout: Record<string, unknown>): {
  textSize: number;
  iconSize?: number;
} {
  const text = layout["text-size"];
  const icon = layout["icon-size"];
  if (layout["icon-image"] !== undefined && typeof text === "number")
    return {
      textSize: text * CAR_ICON_LABEL_SCALE,
      iconSize: (typeof icon === "number" ? icon : 1) * CAR_ICON_LABEL_SCALE,
    };
  return { textSize: CAR_LABEL_PX };
}

/** Route letters shared by the car's route list and the map: A, B, C … */
export function routeLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

export function applyCarCamera(
  map: LibreMap | null,
  message: CarCamera,
  stable: CarViewport["stable"] = { top: 0, right: 0, bottom: 0, left: 0 },
) {
  const store = useNavigationStore.getState();
  if (message.action === "recenter") {
    store.setCameraMode("follow");
    return;
  }
  if (message.action === "overview") {
    // The rest of the trip, north-up and level, inside the area the host keeps free.
    const geometry = store.route?.geometry ?? [];
    const progress = store.progress;
    const remaining = progress
      ? [progress.snapped, ...geometry.slice(progress.segmentIndex + 1)]
      : geometry;
    const bounds = geoJsonBBox({ type: "MultiPoint", coordinates: remaining });
    if (!map || !bounds) return;
    store.setCameraMode("overview");
    fitCarBounds(map, bounds, stable, 600);
    return;
  }
  if (!map) return;
  if (message.action === "zoom") {
    // Following keeps the car in place; only a free map zooms around the gesture point.
    const around =
      store.cameraMode !== "follow" && message.x !== undefined && message.y !== undefined
        ? map.unproject([message.x, message.y])
        : undefined;
    map.zoomTo(map.getZoom() + Math.log2(message.factor), { around, duration: 150 });
  } else {
    store.setCameraMode("free");
    const offset: [number, number] =
      message.action === "pan"
        ? [message.dx, message.dy]
        : [
            Math.max(-1200, Math.min(1200, message.vx * 0.25)),
            Math.max(-1200, Math.min(1200, message.vy * 0.25)),
          ];
    map.panBy(offset, { duration: message.action === "fling" ? 400 : 0 });
  }
}
export function attachCarHost(
  host: CarHost | undefined,
  receive: (message: CarNativeToWebMessage) => void,
) {
  if (!host) return () => {};
  host.onmessage = ({ data }) => {
    const parsed = parseCarSurfaceMessage(data);
    if (parsed.ok && !["car-ready", "car-map-state", "car-error"].includes(parsed.message.type)) {
      receive(parsed.message as CarNativeToWebMessage);
    }
  };
  host.postMessage(JSON.stringify({ v: 1, type: "car-ready" } satisfies CarWebToNativeMessage));
  return () => {
    host.onmessage = null;
  };
}
export function createCarSnapshotReceiver(error: (code: string) => void) {
  let model: NativeReadModel | null = null;
  return (message: Extract<CarNativeToWebMessage, { type: "car-snapshot" }>["message"]) => {
    setNavigationAuthority("native");
    if (message.type === "session.stopped") {
      if (
        !model ||
        model.sessionId !== message.payload.sessionId ||
        message.payload.revision < model.revision
      )
        return;
      // Like the phone page: drop the trip's whole read model, route and puck included.
      // An idle full snapshot would keep drawing the route that just ended.
      useNavigationStore.getState().clearNativeReadModel();
      useNavigationStore.getState().setCameraMode("follow");
      model = null;
      return;
    }
    if (message.type !== "snapshot.update") return;
    const envelope = envelopeOf(message.payload.snapshot);
    if (envelope?.kind !== "ground") {
      error("invalid-snapshot");
      return;
    }
    const raw = envelope.data;
    if (
      envelope.type === "full" &&
      !groundStartPackageSchema.shape.route.safeParse(raw.route).success
    ) {
      error("invalid-snapshot");
      return;
    }
    if (raw.progress != null) {
      const p = raw.progress as Record<string, unknown>;
      if (
        !Array.isArray(p.snapped) ||
        p.snapped.length !== 2 ||
        !p.snapped.every((x) => typeof x === "number" && Number.isFinite(x)) ||
        !["alongMeters", "speedMps", "bearing", "segmentIndex"].every(
          (k) => typeof p[k] === "number" && Number.isFinite(p[k]),
        )
      ) {
        error("invalid-snapshot");
        return;
      }
    }
    const outcome = applyNativeSnapshot(model, envelope);
    if (!outcome.ok) {
      if (outcome.reason !== "stale") error("snapshot-gap");
      return;
    }
    const store = useNavigationStore.getState();
    const projection = projectionOf(outcome.model, envelope.type, outcome.baseRevision);
    const result =
      envelope.type === "full"
        ? store.applyNativeFullSnapshot(projection)
        : store.applyNativeDelta(projection);
    if (result === "needs-full-snapshot") {
      error("snapshot-gap");
      return;
    }
    model = outcome.model;
  };
}
