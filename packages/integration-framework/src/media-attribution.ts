import { type PlacePhoto, type StreetLevelImage, withPhotoContributors } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import type { IntegrationContext } from "./context";
import type { PhotoProvider } from "./contracts/photo-provider";
import type { StreetLevelProvider } from "./contracts/street-level-imagery-provider";
import { resolveIntegrationContributors } from "./contributors";
import { dataSourceToAttribution } from "./manifest";

type CaptureContext = Pick<IntegrationContext, "manifest" | "attributionIndex">;

function serviceReceipts(receipts: readonly Attribution[]): Attribution[] {
  return receipts.flatMap((receipt) => {
    const licensing = parseLicensing(receipt.licensing);
    const bindings = licensing?.bindings.filter((binding) => binding.scope === "service") ?? [];
    return bindings.length
      ? [{ ...receipt, licensing: { ...licensing, version: 1 as const, bindings } }]
      : [];
  });
}

/** Add proven API actors; a platform's manifest never supplies the file's data grant. */
function stampPhoto(
  photo: PlacePhoto,
  sourceName: string,
  services: readonly Attribution[],
): PlacePhoto {
  const captured = readCapturedContributors(photo.contributors);
  if (captured !== undefined && captured.length === 0) return { ...photo, contributors: [] };
  // A retained provider cache already owns its acquisition's API terms. Do
  // not add the current catalogue to that historical snapshot on display.
  if (
    captured?.some((receipt) =>
      receipt.licensing?.bindings.some((binding) => binding.scope === "service"),
    )
  )
    return { ...photo, contributors: captured };
  const file = withPhotoContributors(photo, sourceName);
  const licensing = parseLicensing(file.licensing);
  const bindings = [
    ...(licensing?.bindings ?? []),
    ...services.flatMap((receipt) => receipt.licensing?.bindings ?? []),
  ];
  return {
    ...file,
    ...(bindings.length ? { licensing: { ...licensing, version: 1 as const, bindings } } : {}),
    contributors: snapshotContributors(file.contributors ?? [], services),
  };
}

/** Capture metadata before each provider acquisition, and stamp before caller caches. */
export function capturePhotoProviderContributors(
  ctx: CaptureContext,
  provider: PhotoProvider,
): PhotoProvider {
  const run = async (load: () => Promise<PlacePhoto[]>): Promise<PlacePhoto[]> => {
    const catalogue = snapshotContributors(
      (ctx.manifest.dataSources ?? []).map(dataSourceToAttribution),
    );
    const photos = await load();
    return photos.map((photo) => {
      const source = catalogue.filter((receipt) => receipt.sourceId === photo.source);
      return stampPhoto(photo, source[0]?.name ?? photo.source, serviceReceipts(source));
    });
  };
  return {
    id: provider.id,
    name: provider.name,
    search: (query) => run(() => provider.search(query)),
    ...(provider.searchByTags
      ? {
          searchByTags: (
            tags: Record<string, string>,
            limit?: number,
            options?: { strict?: boolean; signal?: AbortSignal },
          ) => run(() => provider.searchByTags?.(tags, limit, options) ?? Promise.resolve([])),
        }
      : {}),
  };
}

/** Explicit sourceId certifies the built-in adapter relationship; never derive it from a prefix. */
export function captureStreetLevelProviderContributors(
  ctx: CaptureContext,
  provider: StreetLevelProvider,
  sourceId: string,
): StreetLevelProvider {
  const run = async <T>(
    load: () => Promise<T>,
    project: (result: T, sources: readonly Attribution[]) => T,
  ): Promise<T> => {
    const captured = resolveIntegrationContributors(ctx, [sourceId]);
    return project(await load(), captured);
  };
  const stamp = (image: StreetLevelImage, sources: readonly Attribution[]): StreetLevelImage => {
    const photo = stampPhoto(
      {
        url: image.assets.hd ?? image.assets.sd ?? image.assets.thumb ?? "",
        source: sourceId,
        pageUrl: image.pageUrl,
        author: image.author,
        licensing: image.licensing,
        contributors: image.contributors,
      },
      sources[0]?.name ?? provider.name,
      serviceReceipts(sources),
    );
    return { ...image, licensing: photo.licensing, contributors: photo.contributors };
  };
  return {
    id: provider.id,
    name: provider.name,
    capabilities: () => provider.capabilities(),
    getLinks: (id) => provider.getLinks(id),
    getImage: (id) =>
      run(
        () => provider.getImage(id),
        (image, sources) => (image ? stamp(image, sources) : null),
      ),
    findNearest: (point, radius) =>
      run(
        () => provider.findNearest(point, radius),
        (image, sources) => (image ? stamp(image, sources) : null),
      ),
    searchImages: (query) =>
      run(
        () => provider.searchImages(query),
        (images, sources) => images.map((image) => stamp(image, sources)),
      ),
  };
}
