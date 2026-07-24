"use client";

import { type ReactNode, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

/** Generic fallback preview for integrations without a usable custom preview. */
export const genericPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect x="-2" y="-2" width="84" height="84" fill="#f0eee8" />
    <path d="M63 0H80v15q-9 3-14-4-5-6-3-11Z" fill="#cfe9c6" />
    <path d="M0 55q12 5 18 13 3 5 3 12H0Z" fill="#a9d6f0" />
    <g fill="#eae6df">
      <rect x="4" y="4" width="17" height="12" rx="1.5" />
      <rect x="35" y="4" width="14" height="12" rx="1.5" />
      <rect x="4" y="26" width="9" height="14" rx="1.5" />
      <rect x="62" y="50" width="14" height="12" rx="1.5" />
    </g>
    <g fill="none" stroke="#e2e5e9" strokeLinecap="round">
      <path d="M0 20.5H80" strokeWidth="3.2" />
      <path d="M22 68H80" strokeWidth="3.2" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="6.4" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="5.4" />
    </g>
    <g fill="none" stroke="#fff" strokeLinecap="round">
      <path d="M0 20.5H80" strokeWidth="2" />
      <path d="M22 68H80" strokeWidth="2" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="4.6" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="3.6" />
    </g>
    <g fill="#5f6368" opacity="0.75">
      <path d="M40 28 58 38 40 48 22 38Z" />
      <path d="M40 55 24.6 46.5 22 48l18 10 18-10-2.6-1.5Z" opacity="0.55" />
    </g>
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
