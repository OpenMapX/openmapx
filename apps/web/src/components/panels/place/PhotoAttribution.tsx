"use client";

import Link from "@mui/material/Link";
import { buildLicensingHtml, type PlacePhoto, safeHref } from "@openmapx/core";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { AttributionText } from "@/components/ui/AttributionText";

interface Props {
  photo: PlacePhoto;
  color?: string;
}

export function PhotoAttribution({ photo, color = "#fff" }: Props) {
  const captured =
    photo.contributors?.find((receipt) => receipt.sourceId === photo.source) ??
    photo.contributors?.[0];

  const sourceName = captured?.name ?? photo.source;
  const sourceUrl = photo.pageUrl ?? captured?.url;

  const fileBindings =
    photo.licensing?.bindings.filter((binding) => binding.scope !== "service") ?? [];
  const services = (photo.contributors ?? []).filter((receipt) =>
    receipt.licensing?.bindings.some((binding) => binding.scope === "service"),
  );
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
      {photo.licensing && fileBindings.length > 0 && (
        <>
          {" "}
          /{" "}
          <AttributionText
            html={buildLicensingHtml({ ...photo.licensing, bindings: fileBindings })}
          />
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
      <AttributionStrip
        attributions={services}
        variant="plain"
        surface="image"
        maxVisible={0}
        color={color}
      />
    </>
  );
}
