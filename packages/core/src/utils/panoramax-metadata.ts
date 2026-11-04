/** Creator fields in a Panoramax STAC Feature, shared by photo adapters. */
export interface PanoramaxCreatorMetadata {
  readonly providers?: readonly {
    readonly name?: string;
    readonly roles?: readonly string[];
  }[];
  readonly properties?: {
    readonly "geovisio:producer"?: string;
  };
}

/** Credit the producing account, never a host or distributor entry. */
export function panoramaxAuthor(item: PanoramaxCreatorMetadata): string | undefined {
  const producer = item.providers?.find((provider) => provider.roles?.includes("producer"));
  return producer?.name?.trim() || item.properties?.["geovisio:producer"]?.trim() || undefined;
}

/** The image sizes every Panoramax instance serves for a picture. */
export type PanoramaxAssetSize = "thumb" | "sd" | "hd";

const PANORAMAX_PICTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A picture's image as the catalogue that listed it serves it.
 *
 * Panoramax is a federation: the catalogue lists pictures from many instances,
 * and each item's asset links point at whichever instance or storage bucket
 * holds the file. The catalogue's own per-picture endpoint redirects there, so
 * the image proxy only needs to trust the catalogue and the redirects it sends,
 * not every instance in the federation.
 *
 * `apiBase` is the catalogue's API root, such as `https://api.panoramax.xyz/api`.
 * Returns undefined for an id that is not a Panoramax picture UUID.
 */
export function panoramaxPictureAssetUrl(
  apiBase: string,
  pictureId: string | undefined,
  size: PanoramaxAssetSize,
): string | undefined {
  if (!pictureId || !PANORAMAX_PICTURE_ID.test(pictureId)) return undefined;
  return `${apiBase.replace(/\/+$/, "")}/pictures/${pictureId.toLowerCase()}/${size}.jpg`;
}
