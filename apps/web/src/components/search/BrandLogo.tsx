"use client";

import type { BrandSummary } from "@openmapx/core";
import { commonsLogoUrl, proxyImageUrl } from "@openmapx/core";
import { PresetIcon } from "./PresetIcon";

interface BrandLogoProps {
  brand: BrandSummary;
  size?: number;
  /** iD preset icon key used when the brand has no Commons logo. */
  presetIconKey?: string;
}

/**
 * A brand's mark, proxied so the viewer's IP never reaches Wikimedia.
 * Roughly two thirds of catalogued brands have no Commons logo; those fall back
 * to the ordinary preset icon so branded and unbranded rows stay one list.
 */
export function BrandLogo({ brand, size = 20, presetIconKey }: BrandLogoProps) {
  if (!brand.logoFile) {
    return <PresetIcon iconKey={presetIconKey} size={size} />;
  }

  return (
    <img
      src={proxyImageUrl(commonsLogoUrl(brand.logoFile, size * 2))}
      alt={brand.name}
      width={size}
      height={size}
      loading="lazy"
      style={{ objectFit: "contain", borderRadius: 2 }}
    />
  );
}
