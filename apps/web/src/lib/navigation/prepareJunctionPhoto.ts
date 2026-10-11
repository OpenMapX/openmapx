import type {
  GantryModel,
  JunctionDecisionPoint,
  LngLat,
  PhotoRoutePath,
  StreetLevelImage,
} from "@openmapx/core";
import {
  PHOTO_REGISTRATION_VERSION,
  type PhotoRegistrationResult,
} from "@openmapx/core/navigation/photo";
import type {
  PhotoAlignmentRequest,
  PhotoAlignmentResponse,
} from "@/components/navigation/junction/photoAlignment.worker";

export interface PhotoPreparationDiagnostic {
  stage: "decode" | "scene" | "registration" | "worker";
  reason: string;
  registration?: PhotoRegistrationResult;
}

export interface PreparedJunctionPhoto {
  key: string;
  width: number;
  height: number;
  aspectRatio: number;
  path: PhotoRoutePath;
  registration: PhotoRegistrationResult;
  preparationMs: number;
}

/** Identity includes occurrence, layout and projection inputs, never just the image ID. */
export function photoPreparationKey(
  generation: number,
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  model?: GantryModel,
): string {
  return JSON.stringify([
    PHOTO_REGISTRATION_VERSION,
    generation,
    point.stepIndex,
    point.point,
    point.approachTrace,
    point.departureTrace,
    image.id,
    image.heading,
    image.fovDeg,
    model?.approachWay,
    model?.approachWays,
    model?.source,
    model?.laneCount,
    model?.laneGuidance,
    model?.laneSelectionReliable,
  ]);
}

/** Decode and register offscreen before committing a stable image/crop to navigation. */
export async function prepareJunctionPhoto(
  objectUrl: string,
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  model: GantryModel | undefined,
  key: string,
  signal: AbortSignal,
  report?: (diagnostic: PhotoPreparationDiagnostic) => void,
): Promise<PreparedJunctionPhoto | null> {
  const started = performance.now();
  const element = new Image();
  let rejectDecode: (() => void) | undefined;
  const cancelDecode = () => {
    element.src = "";
    rejectDecode?.();
  };
  signal.addEventListener("abort", cancelDecode, { once: true });
  const timeout = setTimeout(cancelDecode, 5000);
  try {
    if (signal.aborted) return null;
    element.src = objectUrl;
    await Promise.race([
      element.decode(),
      new Promise<never>((_, reject) => {
        rejectDecode = () => reject(new Error("decode-cancelled"));
      }),
    ]);
    clearTimeout(timeout);
    if (signal.aborted || !element.naturalWidth || !element.naturalHeight) return null;
    const width = element.naturalWidth,
      height = element.naturalHeight;
    // An equirectangular asset must contain the full sphere, not a provider thumbnail crop.
    if (image.isPano && Math.abs(width / height - 2) > 0.05) {
      report?.({ stage: "decode", reason: "incomplete-sphere" });
      return null;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1024 / width, 1024 / height);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || typeof Worker === "undefined") {
      report?.({ stage: "worker", reason: "unavailable" });
      return null;
    }
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const lanes =
      model?.laneSelectionReliable && model.laneGuidance?.preferredLanes.length
        ? { laneCount: model.laneCount, activeLanes: model.laneGuidance.preferredLanes }
        : undefined;
    const response = await new Promise<PhotoAlignmentResponse | null>((resolve) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: PhotoAlignmentResponse | null) => {
        if (settled) return;
        settled = true;
        worker?.terminate();
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => finish(null);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return finish(null);
      try {
        worker = new Worker(new URL("../../generated/photoAlignment.worker.js", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<PhotoAlignmentResponse>) =>
          finish(
            event.data?.registration?.version === PHOTO_REGISTRATION_VERSION ? event.data : null,
          );
        worker.onerror = () => {
          report?.({ stage: "worker", reason: "worker-error" });
          finish(null);
        };
        timer = setTimeout(() => {
          report?.({ stage: "worker", reason: "timeout" });
          finish(null);
        }, 5000);
        const request: PhotoAlignmentRequest = {
          geometry,
          point,
          image,
          pixels,
          exitLanes: lanes,
          layoutLaneCount:
            model?.source === "osm" && model.approachWay?.tags.lanes === model.laneCount
              ? model.laneCount
              : undefined,
          approachWay: model?.approachWay,
          approachWays: model?.approachWays,
        };
        worker.postMessage(request, [pixels.data.buffer]);
      } catch {
        report?.({ stage: "worker", reason: "worker-construction" });
        finish(null);
      }
    });
    if (signal.aborted || !response) return null;
    report?.({
      stage: response.registration.scene === "relevant" ? "registration" : "scene",
      reason: response.registration.reason ?? "registered",
      registration: response.registration,
    });
    if (response.registration.scene !== "relevant") return null;
    return {
      key,
      width,
      height,
      aspectRatio: width / height,
      path: response.path,
      registration: response.registration,
      preparationMs: performance.now() - started,
    };
  } catch {
    report?.({ stage: "decode", reason: signal.aborted ? "cancelled" : "decode-failure" });
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancelDecode);
    element.src = "";
  }
}
