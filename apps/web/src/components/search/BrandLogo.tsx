"use client";

import type { BrandSummary } from "@openmapx/core";
import { isDisplayablePhoto, proxyImageUrl, useBrandLogoAttribution } from "@openmapx/core";
import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { type ReactNode, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { PhotoAttribution } from "../panels/place/PhotoAttribution";
import { PresetIcon } from "./PresetIcon";

interface BrandLogoProps {
  brand: BrandSummary;
  size?: number;
  /** Optional heading aligned with the mark; file credits use the full row below. */
  children?: ReactNode;
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
export function BrandLogo({ brand, size = 20, children }: BrandLogoProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const { data: photo } = useBrandLogoAttribution(brand.qid, Boolean(brand.logoFile));
  const validPhoto =
    photo && photo.logoFile === brand.logoFile && isDisplayablePhoto(photo) ? photo : undefined;
  const url = validPhoto ? proxyImageUrl(validPhoto.thumbnailUrl ?? validPhoto.url) : null;

  const showPhoto = url && failedUrl !== url;
  const visual = showPhoto ? (
    // biome-ignore lint/performance/noImgElement: the logo uses the API image proxy.
    <img
      src={url}
      alt={brand.name}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailedUrl(url)}
      style={{ objectFit: "contain", borderRadius: 2, flexShrink: 0 }}
    />
  ) : (
    <PresetIcon iconKey={undefined} size={size} />
  );
  if (!children && !showPhoto) return visual;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: children ? "stretch" : "center",
        minWidth: 0,
        width: children ? "100%" : undefined,
      }}
    >
      {children ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {visual}
          {children}
        </div>
      ) : (
        visual
      )}
      {showPhoto && validPhoto && (
        <span
          style={{
            fontSize: 9,
            whiteSpace: "normal",
            minWidth: 0,
            maxWidth: children ? "100%" : 180,
            overflowWrap: "anywhere",
          }}
        >
          <PhotoAttribution photo={validPhoto} color="currentColor" />
        </span>
      )}
      {showPhoto && contributorsForField(brand, "logoFile").length > 0 && (
        <AttributionStrip attributions={contributorsForField(brand, "logoFile")} variant="plain" />
      )}
    </div>
  );
}
