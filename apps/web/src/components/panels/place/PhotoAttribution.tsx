"use client";

import Link from "@mui/material/Link";
import { type PlacePhoto, safeHref } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";

interface Props {
  photo: PlacePhoto;
  color?: string;
}

export function PhotoAttribution({ photo, color = "#fff" }: Props) {
  const registry = useIntegrationRegistry();

  const ds = registry.findDataSource(photo.source);

  const sourceName = ds?.name ?? photo.source;
  const sourceUrl = photo.pageUrl ?? ds?.url;

  const linkSx = {
    color,
    textDecoration: "underline",
    textDecorationColor: `color-mix(in srgb, ${color} 40%, transparent)`,
    "&:hover": { textDecorationColor: color },
  } as const;

  return (
    <>
      {photo.author && (
        <>
          {photo.authorUrl ? (
            <Link
              href={safeHref(photo.authorUrl)}
              target="_blank"
              rel="noopener noreferrer"
              sx={linkSx}
            >
              {photo.author}
            </Link>
          ) : (
            photo.author
          )}
          {" / "}
        </>
      )}
      {sourceUrl ? (
        <Link href={safeHref(sourceUrl)} target="_blank" rel="noopener noreferrer" sx={linkSx}>
          {sourceName}
        </Link>
      ) : (
        sourceName
      )}
      {photo.license && (
        <>
          {" / "}
          {photo.licenseUrl ? (
            <Link
              href={safeHref(photo.licenseUrl)}
              target="_blank"
              rel="noopener noreferrer"
              sx={linkSx}
            >
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
