/**
 * Mapillary street-level imagery service client (Phase 7).
 */

const MAPILLARY_TOKEN = process.env.MAPILLARY_TOKEN ?? "";

export const mapillaryService = {
  async getImages(lng: number, lat: number, _radiusMetres = 100) {
    const url = new URL("https://graph.mapillary.com/images");
    url.searchParams.set("access_token", MAPILLARY_TOKEN);
    url.searchParams.set("fields", "id,thumb_256_url,geometry");
    url.searchParams.set("bbox", `${lng - 0.001},${lat - 0.001},${lng + 0.001},${lat + 0.001}`);
    url.searchParams.set("limit", "20");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Mapillary error ${res.status}`);
    return res.json();
  },
};
