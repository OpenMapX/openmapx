import { type PlacePhoto, withPhotoContributors } from "@openmapx/core";
import type { HttpClient } from "@openmapx/integration-framework";
import { licenceLink, licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { PhotoProvider, PhotoQuery } from "@openmapx/provider-kit/photos";

/**
 * Flickr license IDs that allow commercial use:
 * 4 = CC BY 2.0, 5 = CC BY-SA 2.0, 6 = CC BY-ND 2.0,
 * 7 = No known copyright, 8 = US Gov, 9 = CC0 1.0, 10 = Public Domain Mark
 */
const COMMERCIAL_LICENSES = "4,5,6,7,8,9,10";

const LICENSE_NAMES: Record<string, string> = {
  "4": "CC-BY-2.0",
  "5": "CC-BY-SA-2.0",
  "6": "CC-BY-ND-2.0",
  "7": "No known copyright restrictions",
  "8": "United States Government Work",
  "9": "CC0-1.0",
  "10": "CC-PDM-1.0",
};

/** The shared licence page, so a photo credit links where every other credit naming it does. */
function licenseUrl(code: string): string | undefined {
  if (code === "10") return "https://creativecommons.org/publicdomain/mark/1.0/";
  const name = LICENSE_NAMES[code];
  return name ? licenceLink(name) : undefined;
}

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

/**
 * Flickr photos near a place. `apiKey` reads the current generation's key at
 * request time; without one the provider answers nothing. Any upstream failure
 * leaves Flickr out of the answer.
 */
export function createFlickrPhotoProvider(options: {
  http: HttpClient;
  apiKey: () => string | undefined;
}): PhotoProvider {
  return {
    id: "flickr",
    name: "Flickr",

    async search(query: PhotoQuery): Promise<PlacePhoto[]> {
      const apiKey = options.apiKey();
      if (!apiKey) return [];

      const limit = query.limit ?? 6;

      let data: FlickrResponse;
      try {
        data = await options.http.get<FlickrResponse>("https://api.flickr.com/services/rest/", {
          params: {
            method: "flickr.photos.search",
            api_key: apiKey,
            lat: String(query.lat),
            lon: String(query.lng),
            radius: "0.5",
            radius_units: "km",
            license: COMMERCIAL_LICENSES,
            sort: "interestingness-desc",
            extras: "url_sq,url_m,url_z,url_l,owner_name,license,date_taken",
            per_page: String(limit),
            format: "json",
            nojsoncallback: "1",
            content_types: "0",
            media: "photos",
          },
          timeoutMs: 5000,
        });
      } catch {
        return [];
      }
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

        return withPhotoContributors(
          {
            url: imageUrl,
            thumbnailUrl: thumbUrl,
            source: "flickr",
            author,
            authorUrl: `https://www.flickr.com/photos/${photo.owner}`,
            licensing: licensingFromDeclaration(
              license,
              licenseUrl(photo.license),
              "Flickr photo",
              "imagery",
            ),
            pageUrl: `https://www.flickr.com/photos/${photo.owner}/${photo.id}`,
            capturedAt,
          },
          "Flickr",
        );
      });
    },
  };
}
