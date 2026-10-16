"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import {
  buildAttributionPresentation,
  buildLicensingHtml,
  buildRuntimeAttributionHtml,
  dedupeAttributionHtml,
  mergeAttributionDetails,
  type PlacePhoto,
  parseAttributionHtml,
  projectAttributionPresentations,
  safeHref,
  withPhotoContributors,
} from "@openmapx/core";
import { resolveBindingPlacement } from "@openmapx/mobility-core/attribution-placement";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import { licensingLinks } from "@openmapx/mobility-core/licensing";
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
  const generated = withPhotoContributors(
    { ...photo, pageUrl: sourceUrl, contributors: undefined },
    sourceName,
  ).contributors?.[0];
  const fallbackCredit = generated?.attributionText;
  const filePresentation = buildAttributionPresentation(
    generated ?? {
      sourceId: photo.source,
      name: sourceName,
      url: sourceUrl,
      licensing: photo.licensing,
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
  const completeCaption = generated ? buildRuntimeAttributionHtml(generated) : undefined;
  // A strict notice can already contain the complete creator/source/grant caption.
  // Only replace that caption when the retained notice covers every link as well.
  const useRequiredCaption =
    !photo.attributionOverride &&
    completeCaption !== undefined &&
    notices.some((notice) => {
      const retained = dedupeAttributionHtml([notice.html, completeCaption]);
      return retained.length === 1 && retained[0] === notice.html;
    });
  // A Commons Credit field may describe acquisition ("Own work", archive
  // download instructions), not required display wording. Keep that evidence
  // in the immutable photo, while presenting creator, file and grant separately.
  // Only simplify the source/credit composition our acquisition helper generated. Distinct
  // provider notices, custom file credits and strict policies remain unchanged.
  const seenDetails = new Set<string>();
  const details = group.details.flatMap((entry) => {
    const receipt = entry.attribution;
    const ownPolicy = receipt?.licensing?.bindings.some(
      (binding) => binding.attribution !== undefined || binding.scope === "service",
    );
    const generatedNotice =
      receipt?.attributionText === fallbackCredit ||
      (generated !== undefined &&
        receipt?.attributionText === generated.attributionText &&
        receipt?.url === generated.url);
    const optionalSource =
      fileBindings.length > 0 &&
      fileBindings.every(
        (binding) =>
          binding.license.kind === "public-domain" ||
          binding.license.kind === "status" ||
          (binding.license.kind === "spdx" && binding.license.expression === "CC0-1.0"),
      );
    const preserveDescription =
      photo.attributionRequired ||
      (!optionalSource && !/^own work$/i.test(photo.sourceDescription?.trim() ?? ""));
    const cleaned =
      receipt && detailsAllowed && !ownPolicy && generatedNotice
        ? {
            ...receipt,
            attributionText:
              [
                photo.attributionOverride
                  ? linkHtml(photo.attributionOverride, customLink?.url)
                  : undefined,
                photo.attributionText ? linkHtml(photo.attributionText) : undefined,
                photo.sourceDescription && !photo.attributionOverride && preserveDescription
                  ? linkHtml(photo.sourceDescription)
                  : undefined,
              ]
                .filter(Boolean)
                .join(" / ") || undefined,
            publisher:
              receipt.publisher ??
              (photo.author
                ? { name: photo.author, url: photo.authorUrl ?? sourceUrl }
                : undefined),
          }
        : receipt;
    const key = cleaned ? contributorKey({ ...cleaned, sourceId: "" }) : entry.html;
    if (seenDetails.has(key)) return [];
    seenDetails.add(key);
    const displayedUrls = new Set([
      cleaned?.url,
      cleaned?.publisher?.url,
      ...(cleaned?.licensing
        ? licensingLinks(cleaned.licensing).flatMap((binding) => [
            binding.url,
            ...(binding.licenses?.map((license) => license.url) ?? []),
          ])
        : []),
    ]);
    const extraLinks = [
      ...(photo.attributionLinks ?? []),
      ...parseAttributionHtml(entry.html).links,
    ].filter((link) => {
      if (displayedUrls.has(link.url)) return false;
      displayedUrls.add(link.url);
      return true;
    });
    return [
      {
        ...entry,
        attribution: cleaned,
        ...(detailsAllowed && generatedNotice ? { links: extraLinks } : {}),
      },
    ];
  });
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
        display: "inline",
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
          minWidth: 0,
        }}
      >
        {!useRequiredCaption &&
          credits.map(({ key, content }, index) => (
            <Box component="span" key={key} sx={{ minWidth: 0 }}>
              {index > 0 && (
                <Box component="span" aria-hidden sx={{ mx: 0.5, opacity: 0.6 }}>
                  ·
                </Box>
              )}
              {content}
            </Box>
          ))}
        {!useRequiredCaption && credits.length > 0 && notices.length > 0 && (
          <Box component="span" aria-hidden sx={{ mx: 0.5, opacity: 0.6 }}>
            ·
          </Box>
        )}
        <AttributionNotices notices={notices} />
      </Box>
      <AttributionDetails
        entries={mergeAttributionDetails(details)}
        label={t("credits")}
        logos={notices.flatMap((notice) => notice.logos)}
        iconOnly
      />
    </Box>
  );
}
