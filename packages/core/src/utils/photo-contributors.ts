import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import type { PlacePhoto } from "../types/place";
import { buildRuntimeAttributionHtml } from "./attribution";

/** Capture file-specific grants and creator notices at acquisition, before caching. */
export function withPhotoContributors(photo: PlacePhoto, sourceName: string): PlacePhoto {
  if (photo.contributors !== undefined)
    return {
      ...photo,
      licensing: parseLicensing(photo.licensing),
      contributors: snapshotContributors(photo.contributors),
    };
  const link = (name: string, url?: string) =>
    buildRuntimeAttributionHtml({ sourceId: photo.source, name, url });
  const receipt: Attribution = {
    sourceId: photo.source,
    name: sourceName,
    url: photo.pageUrl,
    licensing: photo.licensing,
    publisher: photo.author ? { name: photo.author, url: photo.authorUrl } : undefined,
    attributionText: [
      photo.author && !photo.attributionOverride
        ? link(photo.author, photo.authorUrl ?? photo.pageUrl)
        : undefined,
      link(sourceName, photo.pageUrl),
      photo.attributionText ? link(photo.attributionText) : undefined,
      ...(photo.attributionLinks ?? []).map(({ label, url }) => link(label, url)),
    ]
      .filter(Boolean)
      .join(" / "),
  };
  const contributors = snapshotContributors([receipt]);
  return { ...photo, licensing: parseLicensing(photo.licensing), contributors };
}
