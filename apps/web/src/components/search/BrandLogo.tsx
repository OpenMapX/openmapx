"use client";

import type { BrandSummary } from "@openmapx/core";
import { commonsLogoUrl, proxyImageUrl } from "@openmapx/core";
import { useState } from "react";
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
  const url = brand.logoFile ? proxyImageUrl(commonsLogoUrl(brand.logoFile, size * 2)) : null;

  if (!url || failedUrl === url) {
    return <PresetIcon iconKey={undefined} size={size} />;
  }

  return (
    <img
      src={url}
      alt={brand.name}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailedUrl(url)}
      style={{ objectFit: "contain", borderRadius: 2 }}
    />
  );
}
