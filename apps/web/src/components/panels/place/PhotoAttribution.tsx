"use client";

import Link from "@mui/material/Link";
import type { PlacePhoto } from "@openmapx/core";

const SOURCE_LABELS: Record<string, string> = {
  wikimedia: "Wikimedia Commons",
  wikipedia: "Wikipedia",
  mapillary: "Mapillary",
  flickr: "Flickr",
  panoramax: "Panoramax",
};

const SOURCE_URLS: Record<string, string> = {
  wikimedia: "https://commons.wikimedia.org/wiki/Wikimedia_Commons",
  wikipedia: "https://en.wikipedia.org",
  mapillary: "https://www.mapillary.com",
  flickr: "https://www.flickr.com",
  panoramax: "https://panoramax.xyz",
};

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
