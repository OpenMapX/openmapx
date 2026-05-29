import { fetchJson, type PlacePhoto } from "@openmapx/core";
import type { PhotoProvider, PhotoQuery } from "@openmapx/integration-photos/types";

/**
 * Flickr license IDs that allow commercial use:
 * 4 = CC BY 2.0, 5 = CC BY-SA 2.0, 6 = CC BY-ND 2.0,
 * 7 = No known copyright, 8 = US Gov, 9 = CC0 1.0, 10 = Public Domain Mark
 */
const COMMERCIAL_LICENSES = "4,5,6,7,8,9,10";

const LICENSE_NAMES: Record<string, string> = {
  "4": "CC BY 2.0",
  "5": "CC BY-SA 2.0",
  "6": "CC BY-ND 2.0",
  "7": "No known copyright restrictions",
  "8": "United States Government Work",
  "9": "CC0 1.0",
  "10": "Public Domain",
};

const LICENSE_URLS: Record<string, string> = {
  "4": "https://creativecommons.org/licenses/by/2.0",
  "5": "https://creativecommons.org/licenses/by-sa/2.0",
  "6": "https://creativecommons.org/licenses/by-nd/2.0",
  "9": "https://creativecommons.org/publicdomain/zero/1.0",
  "10": "https://creativecommons.org/publicdomain/mark/1.0",
};

interface FlickrPhoto {
  id: string;
  owner: string;
  secret: string;
  server: string;
  title: string;
  license: string;
  ownername?: string;
  datetaken?: string;
  url_m?: string;
  url_z?: string;
  url_l?: string;
  url_sq?: string;
}

interface FlickrResponse {
  photos?: {
    photo?: FlickrPhoto[];
  };
}

function buildFlickrUrl(photo: FlickrPhoto, size: string): string {
  return `https://live.staticflickr.com/${photo.server}/${photo.id}_${photo.secret}_${size}.jpg`;
}

// Populated by setup(ctx) from the resolved integration config (default →
// database → vault → env cascade). Read lazily at request time so a late
// secret rotation shows up without re-registering the provider.
let apiKey: string | undefined;
export function setFlickrApiKey(key: string | undefined): void {
  apiKey = key && key.length > 0 ? key : undefined;
}

export const flickrPhotoProvider: PhotoProvider = {
  id: "flickr",
  name: "Flickr",

  async search(query: PhotoQuery): Promise<PlacePhoto[]> {
    if (!apiKey) return [];

    const limit = query.limit ?? 6;

    const url = new URL("https://api.flickr.com/services/rest/");
    url.searchParams.set("method", "flickr.photos.search");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("lat", String(query.lat));
    url.searchParams.set("lon", String(query.lng));
    url.searchParams.set("radius", "0.5");
    url.searchParams.set("radius_units", "km");
    url.searchParams.set("license", COMMERCIAL_LICENSES);
    url.searchParams.set("sort", "interestingness-desc");
    url.searchParams.set("extras", "url_sq,url_m,url_z,url_l,owner_name,license,date_taken");
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("format", "json");
    url.searchParams.set("nojsoncallback", "1");
    url.searchParams.set("content_types", "0");
    url.searchParams.set("media", "photos");

    const data = await fetchJson<FlickrResponse>(url.toString(), {
      timeoutMs: 5000,
      userAgent: null,
      nullOnError: true,
    });
    if (!data) return [];
    const photos = data.photos?.photo;
    if (!photos?.length) return [];

    return photos.map((photo): PlacePhoto => {
      const imageUrl = photo.url_l ?? photo.url_z ?? photo.url_m ?? buildFlickrUrl(photo, "b");
      const thumbUrl = photo.url_sq ?? buildFlickrUrl(photo, "q");
      const license = LICENSE_NAMES[photo.license] ?? `License ${photo.license}`;
      const author = photo.ownername ?? photo.owner;

      // Flickr datetaken: "2023-04-15 14:30:00"
      const capturedAt = photo.datetaken
        ? new Date(photo.datetaken.replace(" ", "T")).toISOString()
        : undefined;

      return {
        url: imageUrl,
        thumbnailUrl: thumbUrl,
        attribution: `${author} / Flickr (${license})`,
        source: "flickr",
        author,
        authorUrl: `https://www.flickr.com/photos/${photo.owner}`,
        license,
        licenseUrl: LICENSE_URLS[photo.license],
        pageUrl: `https://www.flickr.com/photos/${photo.owner}/${photo.id}`,
        capturedAt,
      };
    });
  },
};
