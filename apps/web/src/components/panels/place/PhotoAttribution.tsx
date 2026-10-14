"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import {
  buildAttributionPresentation,
  buildLicensingHtml,
  buildRuntimeAttributionHtml,
  type PlacePhoto,
  projectAttributionPresentations,
  safeHref,
} from "@openmapx/core";
import { resolveBindingPlacement } from "@openmapx/mobility-core/attribution-placement";
import { useTranslations } from "next-intl";
import { AttributionDetails } from "@/components/ui/AttributionDetails";
import { AttributionNotices } from "@/components/ui/AttributionNotices";
import { AttributionText } from "@/components/ui/AttributionText";

interface Props {
  photo: PlacePhoto;
  color?: string;
  /** Thumbnails keep creator/licence visible without repeating the provider label. */
  compact?: boolean;
}

/** One caption across hero, selected image and thumbnails, with lossless photo details. */
export function PhotoAttribution({ photo, color = "#fff", compact = false }: Props) {
  const t = useTranslations("photoGallery");
  const captured =
    photo.contributors?.find((receipt) => receipt.sourceId === photo.source) ??
    photo.contributors?.[0];
  const sourceName = captured?.name ?? photo.source;
  const sourceUrl = photo.pageUrl ?? captured?.url;
  const fileBindings =
    photo.licensing?.bindings.filter((binding) => binding.scope !== "service") ?? [];
  // Earlier unported CC grants allow a reasonable credit line, with authors at
  // equal prominence (2.x §4c / 3.0 §4c). Keep creator, file and licence linked
  // beside EVERY image; source/acquisition prose stays in its associated details.
  // This is not permission to collapse authors or general map/data attribution.
  // https://creativecommons.org/licenses/by-sa/3.0/legalcode#section4
  // https://creativecommons.org/licenses/by-sa/2.0/legalcode#section4
  const placementBindings = [
    ...fileBindings,
    ...(captured?.licensing?.bindings.filter((binding) => binding.scope !== "service") ?? []),
  ];
  const detailsAllowed =
    placementBindings.length > 0 &&
    placementBindings.every(
      (binding) =>
        resolveBindingPlacement(binding, "image").placement === "details" ||
        (binding.attribution === undefined &&
          binding.license.kind === "spdx" &&
          /^CC-BY(?:-SA)?-(?:2\.0|2\.5|3\.0)$/.test(binding.license.expression)),
    );
  const customLink = photo.attributionLinks?.find(
    (link) => link.label === photo.attributionOverride,
  );
  const captionNotice =
    !photo.attributionOverride && !detailsAllowed ? photo.attributionText : undefined;
  const captionLinks = (photo.attributionLinks ?? []).filter(
    (link) =>
      link !== customLink &&
      (!detailsAllowed || (photo.attributionOverride?.includes(link.label) ?? false)),
  );
  const linkHtml = (name: string, url?: string) =>
    buildRuntimeAttributionHtml({ sourceId: photo.source, name, url });
  const fallbackCredit = [
    photo.author && !photo.attributionOverride
      ? linkHtml(photo.author, photo.authorUrl ?? sourceUrl)
      : undefined,
    linkHtml(sourceName, sourceUrl),
    photo.attributionText ? linkHtml(photo.attributionText) : undefined,
    ...(photo.attributionLinks ?? []).map(({ label, url }) => linkHtml(label, url)),
  ]
    .filter(Boolean)
    .join(" / ");
  const filePresentation = buildAttributionPresentation(
    {
      sourceId: photo.source,
      name: sourceName,
      url: sourceUrl,
      licensing: photo.licensing,
      attributionText: fallbackCredit,
    },
    "image",
  );
  // Never rewrite a captured source URL/licence to the file-page fields. Both
  // receipts survive when they carry different information or requirements.
  const capturedPresentations = (photo.contributors ?? []).map((receipt) => {
    const presentation = buildAttributionPresentation(receipt, "image");
    const hasOwnRequirements = receipt.licensing?.bindings.some(
      (binding) => binding.scope === "service" || binding.attribution !== undefined,
    );
    return receipt === captured && detailsAllowed && !hasOwnRequirements
      ? { ...presentation, visibleHtml: "" }
      : presentation;
  });
  const group = projectAttributionPresentations([
    {
      ...filePresentation,
      visibleHtml: fileBindings.some((binding) => binding.attribution !== undefined)
        ? filePresentation.visibleHtml
        : "",
    },
    ...capturedPresentations,
  ]);
  const notices = group.visible;
  const detailsHtml = group.fullHtml;
  const linkSx = {
    color: "inherit",
    textDecoration: "none",
    "&:hover": { textDecoration: "underline" },
  } as const;
  const linked = (text: string, url?: string) =>
    safeHref(url) ? (
      <Link
        href={safeHref(url)}
        target="_blank"
        rel="noopener noreferrer"
        sx={linkSx}
        onClick={(event) => event.stopPropagation()}
      >
        {text}
      </Link>
    ) : (
      text
    );
  const credits = [
    {
      key: "creator",
      content: photo.attributionOverride
        ? linked(photo.attributionOverride, customLink?.url)
        : photo.author
          ? linked(photo.author, photo.authorUrl ?? sourceUrl)
          : undefined,
    },
    {
      key: "source",
      content:
        !compact || (!photo.author && !photo.attributionOverride)
          ? linked(sourceName, sourceUrl)
          : undefined,
    },
    {
      key: "licence",
      content:
        photo.licensing && fileBindings.length > 0 ? (
          <AttributionText
            html={buildLicensingHtml({ ...photo.licensing, bindings: fileBindings })}
          />
        ) : undefined,
    },
    { key: "notice", content: captionNotice },
    ...captionLinks.map(({ label, url }) => ({
      key: `link:${url}:${label}`,
      content: linked(label, url),
    })),
  ].filter(({ content }) => Boolean(content));

  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        flexWrap: compact ? "nowrap" : "wrap",
        alignItems: "center",
        columnGap: 0.5,
        rowGap: 0,
        color,
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        lineHeight: 1.5,
      }}
    >
      <Box
        component="span"
        sx={{
          display: compact ? "flex" : "contents",
          flexDirection: "column",
          flex: compact ? 1 : undefined,
          minWidth: 0,
        }}
      >
        {credits.map(({ key, content }, index) => (
          <Box component="span" key={key} sx={{ minWidth: 0 }}>
            {index > 0 && !compact && (
              <Box component="span" aria-hidden sx={{ mr: 0.5, opacity: 0.6 }}>
                ·
              </Box>
            )}
            {content}
          </Box>
        ))}
        <AttributionNotices notices={notices} />
      </Box>
      <AttributionDetails
        html={detailsHtml}
        label={t("credits")}
        logos={notices.flatMap((notice) => notice.logos)}
        iconOnly
      />
    </Box>
  );
}
