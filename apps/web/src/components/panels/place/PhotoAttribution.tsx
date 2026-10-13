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

  const ds = photo.contributors === undefined ? registry.findDataSource(photo.source) : undefined;
  const captured =
    photo.contributors?.find((receipt) => receipt.sourceId === photo.source) ??
    photo.contributors?.[0];

  const sourceName = captured?.name ?? ds?.name ?? photo.source;
  const sourceUrl = photo.pageUrl ?? captured?.url ?? ds?.url;

  const linkSx = {
    color,
    textDecoration: "underline",
    textDecorationColor: `color-mix(in srgb, ${color} 40%, transparent)`,
    "&:hover": { textDecorationColor: color },
  } as const;

  return (
    <>
      {photo.author && !photo.attributionOverride && (
        <>
          {photo.authorUrl ? (
            <Link
              onClick={(event) => event.stopPropagation()}
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
        <Link
          onClick={(event) => event.stopPropagation()}
          href={safeHref(sourceUrl)}
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
            <Link
              onClick={(event) => event.stopPropagation()}
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
      {photo.attributionText && (
        <>
          {" / "}
          {photo.attributionText}
        </>
      )}
      {photo.attributionLinks?.map((link) => (
        <span key={link.url}>
          {" / "}
          <Link
            onClick={(event) => event.stopPropagation()}
            href={safeHref(link.url)}
            target="_blank"
            rel="noopener noreferrer"
            sx={linkSx}
          >
            {link.label}
          </Link>
        </span>
      ))}
    </>
  );
}
