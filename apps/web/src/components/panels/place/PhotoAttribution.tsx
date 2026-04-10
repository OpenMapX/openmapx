"use client";

import Link from "@mui/material/Link";
import type { PlacePhoto } from "@openmapx/core";

/** Photo source metadata keyed by source identifier. */
const PHOTO_SOURCES: Record<string, { name: string; url: string }> = {
  wikimedia: {
    name: "Wikimedia Commons",
    url: "https://commons.wikimedia.org/wiki/Wikimedia_Commons",
  },
  wikipedia: { name: "Wikipedia", url: "https://en.wikipedia.org" },
  mapillary: { name: "Mapillary", url: "https://www.mapillary.com" },
  flickr: { name: "Flickr", url: "https://www.flickr.com" },
  panoramax: { name: "Panoramax", url: "https://panoramax.xyz" },
  osm: { name: "OpenStreetMap", url: "https://www.openstreetmap.org" },
  "google-photos": { name: "Google Photos", url: "" },
};

/** Display name for a photo source (fallback: raw source key). */
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(PHOTO_SOURCES).map(([k, v]) => [k, v.name]),
);

/** Homepage URL for a photo source (only entries with a URL). */
const SOURCE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(PHOTO_SOURCES)
    .filter(([, v]) => v.url)
    .map(([k, v]) => [k, v.url]),
);

interface Props {
  photo: PlacePhoto;
  /** Link color — defaults to white (for dark backgrounds). */
  color?: string;
}

/** Renders attribution with linked author, source, and license. */
export function PhotoAttribution({ photo, color = "#fff" }: Props) {
  const linkSx = {
    color,
    textDecoration: "underline",
    textDecorationColor: `color-mix(in srgb, ${color} 40%, transparent)`,
    "&:hover": { textDecorationColor: color },
  } as const;
  const sourceName = SOURCE_LABELS[photo.source] ?? photo.source;

  return (
    <>
      {photo.author && (
        <>
          {photo.authorUrl ? (
            <Link href={photo.authorUrl} target="_blank" rel="noopener noreferrer" sx={linkSx}>
              {photo.author}
            </Link>
          ) : (
            photo.author
          )}
          {" / "}
        </>
      )}
      {SOURCE_URLS[photo.source] ? (
        <Link
          href={SOURCE_URLS[photo.source]}
          target="_blank"
          rel="noopener noreferrer"
          sx={linkSx}
        >
          {sourceName}
        </Link>
      ) : (
        sourceName
      )}
      {photo.license && (
        <>
          {" / "}
          {photo.licenseUrl ? (
            <Link href={photo.licenseUrl} target="_blank" rel="noopener noreferrer" sx={linkSx}>
              {photo.license}
            </Link>
          ) : (
            photo.license
          )}
        </>
      )}
    </>
  );
}

export { SOURCE_LABELS, SOURCE_URLS };
