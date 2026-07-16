"use client";

import { type ReactNode, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

/** Generic fallback preview for integrations without a usable custom preview. */
export const genericPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8edf2" rx="4" />
    <circle cx="40" cy="32" r="14" fill="#b0c4d8" opacity="0.5" />
    <rect x="20" y="52" width="40" height="4" rx="2" fill="#b0c4d8" opacity="0.4" />
    <rect x="26" y="60" width="28" height="3" rx="1.5" fill="#b0c4d8" opacity="0.3" />
  </svg>
);

export function IntegrationLayerPreview({ integrationId }: { integrationId: string }) {
  const { apiUrl } = useEnv();
  const apiBase = apiUrl.replace(/\/$/, "");
  const src = `${apiBase}/api/integrations/${encodeURIComponent(integrationId)}/preview`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) return genericPreview;
  // biome-ignore lint/performance/noImgElement: integration SVGs are dynamic external assets, not optimizable app images
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />;
}
