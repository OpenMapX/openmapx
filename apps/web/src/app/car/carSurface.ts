import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
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
export function applyCarCamera(map: LibreMap | null, message: CarCamera) {
  const store = useNavigationStore.getState();
  if (message.action === "recenter") {
    store.setCameraMode("follow");
    return;
  }
  if (!map) return;
  if (message.action === "zoom") {
    const around =
      message.x !== undefined && message.y !== undefined
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
      const projection = projectionOf(model, "full");
      useNavigationStore.getState().applyNativeFullSnapshot({
        ...projection,
        revision: message.payload.revision,
        status: "idle",
      });
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
    const projection = projectionOf(outcome.model, envelope.type);
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
