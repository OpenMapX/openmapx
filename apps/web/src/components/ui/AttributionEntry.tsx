"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { safeHref } from "@openmapx/core";
import {
  type AttributionDetail,
  buildRuntimeAttributionHtml,
  parseAttributionHtml,
  sanitizeAttributionHtml,
} from "@openmapx/core/attribution";
import { licensingLinks, licensingReferenceUrls } from "@openmapx/mobility-core/licensing";
import { useTranslations } from "next-intl";
import { AttributionText } from "./AttributionText";

/** Readable source/rights hierarchy; captured policy and acquisition metadata are not credit copy. */
export function AttributionEntry({ entry }: { entry: AttributionDetail }) {
  const t = useTranslations("footer");
  const attr = entry.attribution;
  const readable = (html: string) => sanitizeAttributionHtml(html, { urlLabel: t("sourceLink") });
  if (!attr) return <AttributionText html={readable(entry.html)} />;
  const licensing = attr.licensing;
  // Repeated subjects can have different descriptors; preserve their exact positions.
  const bindings = licensing
    ? licensingLinks(licensing).map((binding, index) => ({
        ...binding,
        descriptor: licensing.bindings[index]?.license,
      }))
    : [];
  const primary = bindings.filter(
    (binding) =>
      binding.scope !== "software" &&
      binding.scope !== "service" &&
      binding.descriptor?.kind !== "per-item",
  );
  const secondary = bindings.filter((binding) => !primary.includes(binding));
  const credit = attr.attributionText ? readable(attr.attributionText) : undefined;
  const identity = buildRuntimeAttributionHtml({
    sourceId: attr.sourceId,
    name: attr.name,
    url: attr.url,
  });
  const identityParts = parseAttributionHtml(identity);
  const creditParts = credit ? parseAttributionHtml(credit) : { text: "", links: [] };
  const covers = (html: typeof identityParts, name: string, url?: string) =>
    url ? html.links.some((link) => link.label === name && link.url === url) : html.text === name;
  const publisher =
    attr.publisher &&
    !covers(identityParts, attr.publisher.name, attr.publisher.url) &&
    !covers(creditParts, attr.publisher.name, attr.publisher.url)
      ? buildRuntimeAttributionHtml({ sourceId: attr.sourceId, ...attr.publisher })
      : undefined;
  // A supplied credit already linking the canonical source can be the heading.
  // Otherwise retain both: identical labels can still lead to distinct required URLs.
  const creditIsHeading = Boolean(
    credit && attr.url && creditParts.links.some((link) => link.url === attr.url),
  );
  const distinctCredit =
    credit &&
    !creditIsHeading &&
    (creditParts.text !== identityParts.text ||
      creditParts.links.some(
        (link) =>
          !identityParts.links.some(
            (other) => other.label === link.label && other.url === link.url,
          ),
      ));
  const representedUrls = new Set([
    ...identityParts.links.map((link) => link.url),
    ...creditParts.links.map((link) => link.url),
    attr.publisher?.url,
    ...(entry.links?.map((link) => link.url) ?? []),
  ]);
  const referenceUrls = attr.licensing
    ? licensingReferenceUrls(attr.licensing).filter((url) => !representedUrls.has(url))
    : [];
  const licenceLabel = (binding: (typeof bindings)[number]) => {
    const descriptor = binding.descriptor;
    if (
      descriptor?.kind === "per-item" &&
      (!descriptor.raw ||
        descriptor.raw === "Per-item licence" ||
        descriptor.raw === "Determined by each contributing item or operator")
    )
      return t("licenceVariesByItem");
    if (
      descriptor?.kind === "unknown" &&
      (!descriptor.raw || descriptor.raw === "Licence not specified")
    )
      return t("licenceNotSpecified");
    return binding.label;
  };
  const grant = (binding: (typeof bindings)[number], showSubject: boolean) => (
    <Box key={JSON.stringify(binding)} sx={{ minWidth: 0 }}>
      {showSubject && (
        <Typography component="span" sx={{ font: "inherit", color: "text.secondary", mr: 0.75 }}>
          {binding.subject}
        </Typography>
      )}
      <Link
        href={safeHref(binding.url)}
        target="_blank"
        rel="noopener noreferrer"
        underline="hover"
        color="inherit"
      >
        {binding.scope === "service" && binding.url ? t("termsOfUse") : licenceLabel(binding)}
      </Link>
      {binding.licenses && binding.licenses.length > 1 && (
        <Box component="span" sx={{ ml: 0.75 }}>
          {binding.licenses.map((license, index) => (
            <Box component="span" key={`${license.label}:${license.url}`}>
              {index > 0 && " | "}
              <Link
                href={safeHref(license.url)}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                color="inherit"
              >
                {license.label}
              </Link>
            </Box>
          ))}
        </Box>
      )}
      {binding.notice && (
        <Typography sx={{ font: "inherit", mt: 0.5 }}>{binding.notice}</Typography>
      )}
      {binding.conditions?.map((condition) => (
        <Typography key={condition} sx={{ font: "inherit", mt: 0.5 }}>
          {condition}
        </Typography>
      ))}
    </Box>
  );
  return (
    <Box component="section" sx={{ minWidth: 0 }}>
      <Typography
        component="h3"
        sx={{ m: 0, fontSize: "0.9375rem", fontWeight: 600, lineHeight: 1.5 }}
      >
        <AttributionText html={creditIsHeading ? (credit ?? identity) : identity} />
      </Typography>
      {publisher && (
        <Box sx={{ mt: 0.5, color: "text.secondary" }}>
          <AttributionText html={publisher} />
        </Box>
      )}
      {primary.length > 0 && (
        <Box sx={{ mt: 0.5, display: "grid", gap: 0.75, color: "text.secondary" }}>
          {primary.map((binding) => grant(binding, primary.length > 1))}
        </Box>
      )}
      {distinctCredit && (
        <Box sx={{ mt: 1 }}>
          <AttributionText html={credit ?? ""} />
        </Box>
      )}
      {secondary.length > 0 && (
        <Box
          sx={{
            mt: 1,
            color: "text.secondary",
            fontSize: "0.75rem",
            "& > div + div": { mt: 0.5 },
          }}
        >
          {secondary.map((binding) => grant(binding, binding.scope === "software"))}
        </Box>
      )}
      {referenceUrls.length > 0 && (
        <Box sx={{ mt: 0.5, display: "flex", flexWrap: "wrap", gap: 1, color: "text.secondary" }}>
          {referenceUrls.map((url) => (
            <Link
              key={url}
              href={safeHref(url)}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              {t("termsOfUse")}
            </Link>
          ))}
        </Box>
      )}
      {entry.links && (
        <Box sx={{ mt: 1, display: "flex", flexWrap: "wrap", gap: 1 }}>
          {entry.links.map((link) => (
            <Link
              key={`${link.url}:${link.label}`}
              href={safeHref(link.url)}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              {/^https?:\/\//.test(link.label) ? t("additionalSource") : link.label}
            </Link>
          ))}
        </Box>
      )}
      {attr.notes && (
        <Typography sx={{ mt: 1, fontSize: "inherit", color: "text.secondary" }}>
          {attr.notes}
        </Typography>
      )}
    </Box>
  );
}
