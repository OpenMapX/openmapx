"use client";

import type { ReactNode } from "react";

export const defaultMapPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8edf2" />
    {/* water body */}
    <path
      d="M0 56 Q14 48 26 54 Q38 60 50 52 Q62 44 72 50 L80 46 L80 80 L0 80Z"
      fill="#aecbeb"
      opacity="0.35"
    />
    {/* park area */}
    <rect x="8" y="10" width="20" height="16" rx="2" fill="#c8dfb8" opacity="0.6" />
    {/* main road horizontal */}
    <path d="M0 40 Q20 36 40 40 Q60 44 80 40" stroke="#fff" strokeWidth="4.5" fill="none" />
    <path d="M0 40 Q20 36 40 40 Q60 44 80 40" stroke="#f0d27a" strokeWidth="3" fill="none" />
    {/* main road vertical */}
    <path d="M44 0 Q40 20 44 40 Q48 60 44 80" stroke="#fff" strokeWidth="4.5" fill="none" />
    <path d="M44 0 Q40 20 44 40 Q48 60 44 80" stroke="#f0d27a" strokeWidth="3" fill="none" />
    {/* side streets */}
    <line x1="0" y1="20" x2="34" y2="22" stroke="#fff" strokeWidth="2" />
    <line x1="60" y1="24" x2="80" y2="22" stroke="#fff" strokeWidth="2" />
    <line x1="22" y1="0" x2="20" y2="34" stroke="#fff" strokeWidth="2" />
    <line x1="62" y1="46" x2="64" y2="80" stroke="#fff" strokeWidth="2" />
  </svg>
);

export const satellitePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#3a5230" />
    {/* dark field patches */}
    <rect x="0" y="0" width="30" height="28" fill="#4a6340" />
    <rect x="32" y="0" width="24" height="34" fill="#2d4428" />
    <rect x="58" y="0" width="22" height="24" fill="#3f5a35" />
    <rect x="0" y="30" width="22" height="26" fill="#354d2c" />
    <rect x="58" y="26" width="22" height="28" fill="#4a6340" />
    <rect x="24" y="36" width="32" height="24" fill="#2d4428" />
    <rect x="0" y="58" width="36" height="22" fill="#3f5a35" />
    <rect x="38" y="62" width="42" height="18" fill="#35502a" />
    {/* river */}
    <path
      d="M0 50 Q14 44 28 48 Q42 52 54 46 Q66 40 80 44"
      stroke="#2a4a5a"
      strokeWidth="4"
      fill="none"
    />
    <path
      d="M0 50 Q14 44 28 48 Q42 52 54 46 Q66 40 80 44"
      stroke="#3a6878"
      strokeWidth="2"
      fill="none"
    />
    {/* road lines */}
    <line x1="0" y1="32" x2="80" y2="26" stroke="#807a6f" strokeWidth="1.5" opacity="0.5" />
    <line x1="40" y1="0" x2="38" y2="80" stroke="#807a6f" strokeWidth="1.5" opacity="0.5" />
  </svg>
);

export const terrainPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e4dcc8" />
    {/* elevation shading */}
    <ellipse cx="34" cy="34" rx="30" ry="26" fill="#d4c9a8" opacity="0.5" />
    <ellipse cx="60" cy="56" rx="22" ry="18" fill="#c9bb94" opacity="0.4" />
    {/* contour lines */}
    <ellipse cx="34" cy="34" rx="28" ry="24" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    <ellipse cx="34" cy="34" rx="22" ry="18" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    <ellipse cx="34" cy="34" rx="16" ry="12" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    <ellipse cx="34" cy="34" rx="9" ry="6.5" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    <ellipse cx="60" cy="56" rx="18" ry="14" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    <ellipse cx="60" cy="56" rx="11" ry="8" fill="none" stroke="#b5a882" strokeWidth="0.8" />
    {/* peak marker */}
    <polygon points="34,28 32,32 36,32" fill="#8a7a5a" />
  </svg>
);

export const cyclingMapPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#d5e8dc" />
    {/* park/green area */}
    <ellipse cx="62" cy="18" rx="22" ry="18" fill="#c0dcc0" />
    <ellipse cx="12" cy="64" rx="18" ry="16" fill="#c0dcc0" />
    {/* road */}
    <path d="M0 44 Q22 38 40 42 Q58 46 80 40" stroke="#fff" strokeWidth="6" fill="none" />
    {/* cycling lane alongside road — green solid */}
    <path d="M0 50 Q22 44 40 48 Q58 52 80 46" stroke="#0D7C3D" strokeWidth="3" fill="none" />
    {/* second bike path through park */}
    <path
      d="M60 0 Q54 24 48 36 Q42 48 34 80"
      stroke="#0D7C3D"
      strokeWidth="2"
      fill="none"
      strokeDasharray="5,3"
    />
    {/* bike lane diamond marker */}
    <g transform="translate(36,44)">
      <polygon points="4,0 8,4 4,8 0,4" fill="#fff" stroke="#0D7C3D" strokeWidth="1" />
      <circle cx="4" cy="4" r="1.5" fill="#0D7C3D" />
    </g>
    {/* trees in park */}
    <circle cx="56" cy="14" r="4" fill="#7ab87a" />
    <circle cx="64" cy="12" r="3.5" fill="#6aaa6a" />
    <circle cx="68" cy="18" r="3" fill="#7ab87a" />
    <circle cx="10" cy="60" r="3.5" fill="#7ab87a" />
    <circle cx="16" cy="64" r="3" fill="#6aaa6a" />
  </svg>
);

export const standardMapPreview: ReactNode = defaultMapPreview;

export const globePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#0a1628" />
    <circle cx="40" cy="40" r="28" fill="#2a6ab5" />
    <ellipse
      cx="40"
      cy="40"
      rx="14"
      ry="28"
      fill="none"
      stroke="#4a90d9"
      strokeWidth="0.8"
      opacity="0.6"
    />
    <ellipse
      cx="40"
      cy="40"
      rx="28"
      ry="10"
      fill="none"
      stroke="#4a90d9"
      strokeWidth="0.8"
      opacity="0.6"
    />
    {/* land masses */}
    <path d="M28 24 Q32 20 38 22 Q42 24 40 28 Q36 30 30 28Z" fill="#3d8c5c" opacity="0.85" />
    <path d="M44 30 Q52 26 56 32 Q58 38 54 42 Q48 44 44 38Z" fill="#3d8c5c" opacity="0.85" />
    <path d="M26 38 Q30 36 34 40 Q36 46 30 48 Q24 46 26 38Z" fill="#3d8c5c" opacity="0.85" />
    <path d="M42 48 Q48 46 52 50 Q54 54 48 56 Q42 54 42 48Z" fill="#3d8c5c" opacity="0.85" />
    {/* atmosphere glow */}
    <circle cx="40" cy="40" r="28" fill="none" stroke="#88C6FC" strokeWidth="2" opacity="0.4" />
    <circle cx="40" cy="40" r="30" fill="none" stroke="#88C6FC" strokeWidth="1" opacity="0.2" />
  </svg>
);
