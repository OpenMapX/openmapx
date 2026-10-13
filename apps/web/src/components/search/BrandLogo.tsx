"use client";

import type { BrandSummary } from "@openmapx/core";
import { isDisplayablePhoto, proxyImageUrl, useBrandLogoAttribution } from "@openmapx/core";
import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { PhotoAttribution } from "../panels/place/PhotoAttribution";
import { PresetIcon } from "./PresetIcon";

interface BrandLogoProps {
  brand: BrandSummary;
  size?: number;
}

/**
 * A brand's mark, proxied so the viewer's IP never reaches Wikimedia.
 * Roughly two thirds of catalogued brands have no Commons logo; those fall back
 * to the ordinary preset icon so branded and unbranded rows stay one list.
 * NSI-derived Commons filenames can go stale (renamed or deleted on Commons, or
 * a proxy 404), so a failed load also falls back — keyed on the failed URL
 * itself rather than a boolean, so switching to a different brand with a fresh
 * logo tries again instead of staying stuck on the fallback.
 */
export function BrandLogo({ brand, size = 20 }: BrandLogoProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const { data: photo } = useBrandLogoAttribution(brand.qid, Boolean(brand.logoFile));
  const validPhoto =
    photo && photo.logoFile === brand.logoFile && isDisplayablePhoto(photo) ? photo : undefined;
  const url = validPhoto ? proxyImageUrl(validPhoto.thumbnailUrl ?? validPhoto.url) : null;

  if (!url || failedUrl === url) {
    return <PresetIcon iconKey={undefined} size={size} />;
  }

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
      {/* biome-ignore lint/performance/noImgElement: the logo is a Commons file fetched through the API image proxy at runtime, not an app image the Next.js loader can optimize */}
      <img
        src={url}
        alt={brand.name}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailedUrl(url)}
        style={{ objectFit: "contain", borderRadius: 2 }}
      />
      {validPhoto && (
        <span style={{ fontSize: 9, whiteSpace: "normal", maxWidth: 180 }}>
          <PhotoAttribution photo={validPhoto} color="currentColor" />
        </span>
      )}
      {contributorsForField(brand, "logoFile").length > 0 && (
        <AttributionStrip attributions={contributorsForField(brand, "logoFile")} variant="plain" />
      )}
    </div>
  );
}
