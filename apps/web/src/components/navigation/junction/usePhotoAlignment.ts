import type {
  JunctionDecisionPoint,
  LngLat,
  PhotoRoutePath,
  StreetLevelImage,
} from "@openmapx/core";
import { projectRoutePath } from "@openmapx/core/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PhotoAlignmentRequest } from "./photoAlignment.worker";

export function usePhotoAlignment(
  geometry: LngLat[],
  point: JunctionDecisionPoint,
  image: StreetLevelImage,
  objectUrl: string,
  laneCount: number | undefined,
  activeLanesKey: string | undefined,
) {
  const job = useMemo(
    () => ({ geometry, point, image, objectUrl, laneCount, activeLanesKey }),
    [geometry, point, image, objectUrl, laneCount, activeLanesKey],
  );
  const [loaded, setLoaded] = useState<{
    objectUrl: string;
    element: HTMLImageElement;
    aspectRatio: number;
  } | null>(null);
  const [result, setResult] = useState<{ job: typeof job; path: PhotoRoutePath | null } | null>(
    null,
  );
  const rememberImage = useCallback(
    (element: HTMLImageElement) => {
      if (
        (element.currentSrc || element.src) ===
          new URL(objectUrl, element.ownerDocument.baseURI).href &&
        element.naturalWidth > 0 &&
        element.naturalHeight > 0
      )
        setLoaded({
          objectUrl,
          element,
          aspectRatio: element.naturalWidth / element.naturalHeight,
        });
    },
    [objectUrl],
  );
  const imageRef = useCallback(
    (element: HTMLImageElement | null) => {
      if (element?.complete) rememberImage(element);
    },
    [rememberImage],
  );
  useEffect(() => {
    if (
      loaded?.objectUrl !== objectUrl ||
      laneCount === undefined ||
      !activeLanesKey ||
      typeof Worker === "undefined"
    )
      return;
    let worker: Worker | undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      cancelled = true;
      worker?.terminate();
      if (timeout) clearTimeout(timeout);
    };
    try {
      const { naturalWidth, naturalHeight } = loaded.element;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1024 / naturalWidth, 1024 / naturalHeight);
      canvas.width = Math.max(1, Math.round(naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(loaded.element, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      worker = new Worker(new URL("../../../generated/photoAlignment.worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<PhotoRoutePath | null>) => {
        if (!cancelled) setResult({ job, path: event.data });
        stop();
      };
      worker.onerror = stop;
      timeout = setTimeout(stop, 5000);
      const request: PhotoAlignmentRequest = {
        geometry,
        point,
        image,
        pixels,
        exitLanes: { laneCount, activeLanes: activeLanesKey.split(",").map(Number) },
      };
      worker.postMessage(request, [pixels.data.buffer]);
    } catch {
      stop();
    }
    return stop;
  }, [job, loaded, objectUrl, laneCount, activeLanesKey, geometry, point, image]);
  const bare = useMemo(() => projectRoutePath([], point, image), [point, image]);
  return {
    path:
      result?.job === job && loaded?.objectUrl === objectUrl && result.path ? result.path : bare,
    aspectRatio:
      loaded?.objectUrl === objectUrl ? loaded.aspectRatio : (image.aspectRatio ?? 4 / 3),
    imageRef,
    onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => rememberImage(event.currentTarget),
  };
}
