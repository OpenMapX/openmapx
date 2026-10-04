import { proxyImageUrl } from "@openmapx/core";
import type { Map as MaplibreMap } from "maplibre-gl";
import { createBrandMarkerSvg } from "./markerSvg";

export function dataSourceBrandImageId(url: string): string {
  return `ds-brand-${encodeURIComponent(url)}`;
}

/** Provider-supplied identities use the same white logo disc and proxy as POI brands. */
export async function loadDataSourceBrandMarker(
  map: MaplibreMap,
  url: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const id = dataSourceBrandImageId(url);
  try {
    if (!isCurrent()) return false;
    if (map.hasImage(id)) return true;
    const response = await fetch(proxyImageUrl(url));
    if (!response.ok || !isCurrent()) return false;
    const blob = await response.blob();
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("logo read failed"));
      reader.readAsDataURL(blob);
    });
    return await new Promise<boolean>((resolve) => {
      const image = new Image(64, 64);
      image.onload = () => {
        if (!isCurrent()) return resolve(false);
        try {
          if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      image.onerror = () => resolve(false);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createBrandMarkerSvg(dataUri))}`;
    });
  } catch {
    return false;
  }
}
