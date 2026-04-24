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

export const trafficPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#dce4e8" />
    {/* map background blocks */}
    <rect x="0" y="0" width="29" height="28" rx="3" fill="#e8eef2" />
    <rect x="51" y="0" width="29" height="28" rx="3" fill="#e8eef2" />
    <rect x="0" y="50" width="29" height="30" rx="3" fill="#e8eef2" />
    <rect x="51" y="50" width="29" height="30" rx="3" fill="#e8eef2" />
    {/* road base - gray */}
    <line x1="40" y1="0" x2="40" y2="80" stroke="#c8cdd2" strokeWidth="8" />
    <line x1="0" y1="39" x2="80" y2="39" stroke="#c8cdd2" strokeWidth="8" />
    {/* intersection */}
    <rect x="36" y="35" width="8" height="8" fill="#c8cdd2" />
    {/* traffic colors on vertical road */}
    <line x1="40" y1="0" x2="40" y2="34" stroke="#34a853" strokeWidth="4" />
    <line x1="40" y1="44" x2="40" y2="62" stroke="#ea4335" strokeWidth="4" />
    <line x1="40" y1="62" x2="40" y2="80" stroke="#7f1d1d" strokeWidth="4" />
    {/* traffic colors on horizontal road */}
    <line x1="0" y1="39" x2="20" y2="39" stroke="#34a853" strokeWidth="4" />
    <line x1="20" y1="39" x2="35" y2="39" stroke="#fbbc04" strokeWidth="4" />
    <line x1="45" y1="39" x2="62" y2="39" stroke="#ea4335" strokeWidth="4" />
    <line x1="62" y1="39" x2="80" y2="39" stroke="#fbbc04" strokeWidth="4" />
  </svg>
);

export const transitPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e4ecf6" />
    {/* background streets */}
    <line x1="0" y1="40" x2="80" y2="40" stroke="#d5dce6" strokeWidth="3" />
    <line x1="40" y1="0" x2="40" y2="80" stroke="#d5dce6" strokeWidth="3" />
    {/* transit line blue */}
    <path
      d="M0 24 Q22 22 40 34 Q58 44 80 42"
      stroke="#1a73e8"
      strokeWidth="3"
      fill="none"
      strokeLinecap="round"
    />
    {/* transit line red */}
    <path
      d="M12 0 Q16 24 22 40 Q28 56 34 80"
      stroke="#ea4335"
      strokeWidth="2.5"
      fill="none"
      strokeLinecap="round"
    />
    {/* transit line green */}
    <path
      d="M54 0 Q56 22 62 40 Q68 58 72 80"
      stroke="#34a853"
      strokeWidth="2"
      fill="none"
      strokeLinecap="round"
    />
    {/* station markers */}
    <circle cx="40" cy="34" r="4" fill="#fff" stroke="#1a73e8" strokeWidth="2" />
    <circle cx="22" cy="40" r="3.5" fill="#fff" stroke="#ea4335" strokeWidth="1.8" />
    {/* M label */}
    <rect x="34" y="28" width="12" height="12" rx="2" fill="#1a73e8" />
    <text
      x="40"
      y="37"
      fontSize="8"
      fill="#fff"
      textAnchor="middle"
      fontWeight="bold"
      fontFamily="sans-serif"
    >
      M
    </text>
  </svg>
);

export const hikingPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#c5d9a8" />
    {/* hills */}
    <ellipse cx="22" cy="58" rx="26" ry="20" fill="#a8c48a" />
    <ellipse cx="60" cy="52" rx="24" ry="22" fill="#96b87a" />
    {/* trees on left hill */}
    <polygon points="10,44 7,52 13,52" fill="#5a8a48" />
    <polygon points="10,47 8,52 12,52" fill="#4a7a3a" />
    <polygon points="20,42 17,50 23,50" fill="#5a8a48" />
    <polygon points="20,45 18,50 22,50" fill="#4a7a3a" />
    <polygon points="30,44 27,52 33,52" fill="#5a8a48" />
    <polygon points="14,54 11,62 17,62" fill="#5a8a48" />
    <polygon points="14,57 12,62 16,62" fill="#4a7a3a" />
    <polygon points="26,52 23,60 29,60" fill="#5a8a48" />
    {/* trees on right hill */}
    <polygon points="52,36 49,44 55,44" fill="#5a8a48" />
    <polygon points="52,39 50,44 54,44" fill="#4a7a3a" />
    <polygon points="64,34 61,42 67,42" fill="#5a8a48" />
    <polygon points="64,37 62,42 66,42" fill="#4a7a3a" />
    <polygon points="58,44 55,52 61,52" fill="#5a8a48" />
    <polygon points="70,42 67,50 73,50" fill="#5a8a48" />
    <polygon points="70,45 68,50 72,50" fill="#4a7a3a" />
    <polygon points="46,48 43,56 49,56" fill="#5a8a48" />
    <polygon points="46,51 44,56 48,56" fill="#4a7a3a" />
    {/* trail path - red dashed */}
    <path
      d="M4 70 Q18 50 32 44 Q44 40 56 30 Q64 24 76 14"
      stroke="#c0392b"
      strokeWidth="2"
      fill="none"
      strokeDasharray="4,2.5"
      strokeLinecap="round"
    />
    {/* trail blaze (red-white-red) */}
    <rect x="53" y="26" width="7" height="9" rx="1" fill="#c0392b" />
    <rect x="53" y="29" width="7" height="3" fill="#fff" />
  </svg>
);

export const streetViewPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#d4e5eb" />
    {/* streets */}
    <line x1="0" y1="40" x2="80" y2="40" stroke="#c0d4db" strokeWidth="4" />
    <line x1="40" y1="0" x2="40" y2="80" stroke="#c0d4db" strokeWidth="4" />
    <line x1="0" y1="22" x2="80" y2="22" stroke="#c0d4db" strokeWidth="2" />
    <line x1="0" y1="60" x2="80" y2="60" stroke="#c0d4db" strokeWidth="2" />
    {/* street view coverage lines - blue */}
    <line x1="0" y1="40" x2="80" y2="40" stroke="#4285f4" strokeWidth="2.5" opacity="0.6" />
    <line x1="40" y1="0" x2="40" y2="80" stroke="#4285f4" strokeWidth="2.5" opacity="0.6" />
    {/* pegman figure */}
    <circle cx="40" cy="25" r="5" fill="#f6a623" />
    <path d="M40 30 L40 41" stroke="#f6a623" strokeWidth="4" strokeLinecap="round" />
    <path
      d="M32 35 L40 32 L48 35"
      stroke="#f6a623"
      strokeWidth="3.5"
      strokeLinecap="round"
      fill="none"
    />
    <path
      d="M36 49 L40 41 L44 49"
      stroke="#f6a623"
      strokeWidth="3.5"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
);

export const wildfirePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#c6e7d8" />
    {/* land areas */}
    <rect x="0" y="0" width="80" height="44" fill="#c7efd8" />
    <rect x="0" y="44" width="80" height="36" fill="#bde2cd" />
    {/* large flame */}
    <g transform="translate(18,12) scale(1.5)">
      <path
        d="M8 22 C3 20 0 15 1 10 C2 12 4 12 5 10 C4 6 7 0 10 0 C9 4 11 6 12 5 C13 3 15 2 17 4 C15 7 16 10 15 12 C16 12 18 12 19 10 C20 15 17 20 12 22Z"
        fill="#ef4444"
      />
      <path d="M7 22 C5 19 6 15 8 13 C8 16 10 15 10 13 C10 16 12 18 13 22Z" fill="#ff8c00" />
    </g>
    {/* medium flame */}
    <g transform="translate(48,36) scale(1.0)">
      <path
        d="M8 22 C3 20 0 15 1 10 C2 12 4 12 5 10 C4 6 7 0 10 0 C9 4 11 6 12 5 C13 3 15 2 17 4 C15 7 16 10 15 12 C16 12 18 12 19 10 C20 15 17 20 12 22Z"
        fill="#f97316"
      />
      <path d="M7 22 C5 19 6 15 8 13 C8 16 10 15 10 13 C10 16 12 18 13 22Z" fill="#fbbf24" />
    </g>
    {/* small flame */}
    <g transform="translate(10,50) scale(0.75)">
      <path
        d="M8 22 C3 20 0 15 1 10 C2 12 4 12 5 10 C4 6 7 0 10 0 C9 4 11 6 12 5 C13 3 15 2 17 4 C15 7 16 10 15 12 C16 12 18 12 19 10 C20 15 17 20 12 22Z"
        fill="#ef4444"
      />
      <path d="M7 22 C5 19 6 15 8 13 C8 16 10 15 10 13 C10 16 12 18 13 22Z" fill="#ff8c00" />
    </g>
  </svg>
);

export const airQualityPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="aqi-heatmap" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#009966" stopOpacity="0.45" />
        <stop offset="35%" stopColor="#ffde33" stopOpacity="0.45" />
        <stop offset="65%" stopColor="#ff9933" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#cc0033" stopOpacity="0.45" />
      </linearGradient>
    </defs>
    <rect width="80" height="80" fill="#e4eef2" />
    {/* subtle roads */}
    <line x1="0" y1="36" x2="80" y2="36" stroke="#d5dce6" strokeWidth="3" />
    <line x1="54" y1="0" x2="54" y2="80" stroke="#d5dce6" strokeWidth="2" />
    <line x1="22" y1="0" x2="22" y2="80" stroke="#d5dce6" strokeWidth="2" />
    {/* AQI heatmap overlay */}
    <rect x="0" y="0" width="80" height="80" fill="url(#aqi-heatmap)" />
    {/* station dots with AQI values */}
    <circle cx="16" cy="22" r="7" fill="#009966" opacity="0.8" />
    <text
      x="16"
      y="24.5"
      fontSize="7"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      32
    </text>
    <circle cx="44" cy="40" r="7" fill="#ffde33" opacity="0.9" />
    <text
      x="44"
      y="42.5"
      fontSize="7"
      fill="#666"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      78
    </text>
    <circle cx="66" cy="58" r="7" fill="#ff9933" opacity="0.85" />
    <text
      x="66"
      y="60.5"
      fontSize="7"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      124
    </text>
    <circle cx="30" cy="64" r="5.5" fill="#009966" opacity="0.75" />
    <text
      x="30"
      y="66.2"
      fontSize="5.5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      41
    </text>
  </svg>
);

export const winterSportsPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e3f2fd" />
    {/* mountain */}
    <polygon points="40,8 10,60 70,60" fill="#bbdefb" />
    <polygon points="40,8 30,26 50,26" fill="#e8f4fd" />
    {/* snow cap */}
    <polygon points="40,8 32,22 48,22" fill="#fff" />
    {/* blue piste */}
    <path
      d="M36 22 Q32 34 30 44 Q28 52 24 60"
      stroke="#2196F3"
      strokeWidth="2.5"
      fill="none"
      strokeLinecap="round"
    />
    {/* red piste */}
    <path
      d="M44 22 Q48 34 52 44 Q54 50 58 60"
      stroke="#F44336"
      strokeWidth="2.5"
      fill="none"
      strokeLinecap="round"
    />
    {/* black piste */}
    <path
      d="M40 24 Q40 36 40 48 Q40 54 40 60"
      stroke="#333"
      strokeWidth="1.8"
      fill="none"
      strokeLinecap="round"
    />
    {/* lift line */}
    <line x1="18" y1="56" x2="34" y2="18" stroke="#666" strokeWidth="1" strokeDasharray="3,2" />
    {/* lift tower */}
    <line x1="26" y1="36" x2="26" y2="40" stroke="#666" strokeWidth="1.5" />
    {/* snow base */}
    <rect x="0" y="60" width="80" height="20" fill="#f0f7ff" />
  </svg>
);

export const earthquakesPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8eef4" />
    {/* map background */}
    <path d="M0 26 Q22 22 44 28 Q66 34 80 26 L80 80 L0 80Z" fill="#dde5ec" opacity="0.5" />
    {/* seismograph zigzag line */}
    <polyline
      points="0,42 8,42 14,42 16,24 19,54 22,30 25,48 28,36 31,44 34,34 37,50 40,28 43,56 46,32 49,46 52,40 56,42 62,42 80,42"
      fill="none"
      stroke="#ef4444"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    {/* epicenter marker */}
    <circle cx="42" cy="42" r="10" fill="#ef4444" opacity="0.12" />
    <circle cx="42" cy="42" r="6" fill="#ef4444" opacity="0.2" />
    {/* concentric shockwave rings */}
    <circle cx="42" cy="42" r="18" fill="none" stroke="#ef4444" strokeWidth="0.8" opacity="0.3" />
    <circle cx="42" cy="42" r="28" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.15" />
    {/* magnitude label */}
    <text x="56" y="66" fontSize="7" fill="#dc2626" fontFamily="sans-serif" fontWeight="700">
      M 5.2
    </text>
  </svg>
);

export const naturalEventsPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e4eef2" />
    {/* simplified land masses */}
    <path
      d="M4 18 Q16 12 28 18 Q36 22 38 16 L52 14 Q58 18 64 16 L72 18 Q76 22 80 20 L80 36 Q68 32 56 36 L42 34 Q30 38 18 34 L0 36Z"
      fill="#c7ddc2"
      opacity="0.5"
    />
    <path
      d="M0 48 Q12 44 24 50 Q40 56 56 48 Q68 42 80 48 L80 80 L0 80Z"
      fill="#c7ddc2"
      opacity="0.4"
    />
    {/* volcano marker (red) */}
    <circle cx="20" cy="26" r="7" fill="#e53935" opacity="0.18" />
    <circle cx="20" cy="26" r="4.5" fill="#e53935" opacity="0.85" />
    <circle cx="20" cy="26" r="2" fill="#fff" opacity="0.3" />
    {/* storm marker (purple) */}
    <circle cx="56" cy="22" r="7" fill="#7b1fa2" opacity="0.18" />
    <circle cx="56" cy="22" r="4.5" fill="#7b1fa2" opacity="0.85" />
    <circle cx="56" cy="22" r="2" fill="#fff" opacity="0.3" />
    {/* flood marker (blue) */}
    <circle cx="36" cy="54" r="7" fill="#1565c0" opacity="0.18" />
    <circle cx="36" cy="54" r="4.5" fill="#1565c0" opacity="0.85" />
    <circle cx="36" cy="54" r="2" fill="#fff" opacity="0.3" />
    {/* drought marker (yellow) */}
    <circle cx="62" cy="58" r="5.5" fill="#f9a825" opacity="0.15" />
    <circle cx="62" cy="58" r="3.5" fill="#f9a825" opacity="0.85" />
    <circle cx="62" cy="58" r="1.5" fill="#fff" opacity="0.3" />
    {/* small ice marker (cyan) */}
    <circle cx="42" cy="16" r="3" fill="#4dd0e1" opacity="0.85" />
    <circle cx="42" cy="16" r="1.2" fill="#fff" opacity="0.3" />
    {/* warning triangle accent */}
    <path d="M10 66 L15 58 L20 66Z" fill="#ff6f00" opacity="0.6" />
    <text
      x="13"
      y="64.5"
      fontSize="5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      !
    </text>
  </svg>
);

export const travelTimePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#bee0ef" />
    {/* land */}
    <path d="M0 18 Q22 14 44 20 Q66 26 80 20 L80 80 L0 80Z" fill="#c7e9d8" opacity="0.5" />
    {/* isochrone rings */}
    <ellipse
      cx="36"
      cy="40"
      rx="30"
      ry="28"
      fill="none"
      stroke="#4f83f1"
      strokeWidth="1"
      strokeDasharray="4,3"
      opacity="0.4"
    />
    <ellipse
      cx="36"
      cy="40"
      rx="20"
      ry="18"
      fill="none"
      stroke="#4f83f1"
      strokeWidth="1.2"
      strokeDasharray="4,3"
      opacity="0.6"
    />
    <ellipse
      cx="36"
      cy="40"
      rx="10"
      ry="9"
      fill="none"
      stroke="#4f83f1"
      strokeWidth="1.5"
      strokeDasharray="3,2"
      opacity="0.8"
    />
    {/* center pin */}
    <path d="M36 44 C32 38 28 34 28 31 A8 8 0 1 1 44 31 C44 34 40 38 36 44Z" fill="#4f83f1" />
    <circle cx="36" cy="31" r="2.5" fill="#fff" />
    {/* time labels */}
    <text x="62" y="26" fontSize="6" fill="#4f83f1" fontFamily="sans-serif" fontWeight="600">
      5m
    </text>
    <text x="66" y="44" fontSize="6" fill="#4f83f1" fontFamily="sans-serif" opacity="0.7">
      15m
    </text>
  </svg>
);

export const measurePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#bee0ef" />
    {/* land */}
    <path d="M0 22 Q22 18 44 24 Q66 30 80 22 L80 80 L0 80Z" fill="#c7e9d8" opacity="0.5" />
    {/* measurement line */}
    <line x1="16" y1="60" x2="64" y2="22" stroke="#111827" strokeWidth="2" strokeLinecap="round" />
    {/* endpoints */}
    <circle cx="16" cy="60" r="4" fill="#fff" stroke="#111827" strokeWidth="2" />
    <circle cx="64" cy="22" r="4" fill="#fff" stroke="#111827" strokeWidth="2" />
    {/* ruler ticks */}
    <line x1="23" y1="54" x2="25.5" y2="56" stroke="#111827" strokeWidth="1.2" />
    <line x1="30" y1="48" x2="32.5" y2="50" stroke="#111827" strokeWidth="1.2" />
    <line x1="40" y1="40" x2="42.5" y2="42" stroke="#111827" strokeWidth="1.5" />
    <line x1="48" y1="34" x2="50.5" y2="36" stroke="#111827" strokeWidth="1.2" />
    <line x1="55" y1="28" x2="57.5" y2="30" stroke="#111827" strokeWidth="1.2" />
    {/* distance label */}
    <rect x="29" y="34" width="22" height="10" rx="2" fill="#fff" opacity="0.9" />
    <text
      x="40"
      y="41.5"
      fontSize="7"
      fill="#111827"
      textAnchor="middle"
      fontFamily="sans-serif"
      fontWeight="600"
    >
      2.4 km
    </text>
  </svg>
);

export const standardMapPreview: ReactNode = defaultMapPreview;

export const buildingsPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e0e3e8" />
    {/* ground plane */}
    <path d="M0 62 L80 58 L80 80 L0 80Z" fill="#d0d4da" />
    {/* tall building back */}
    <path d="M20 18 L34 14 L34 52 L20 56Z" fill="#a8a6a8" />
    <path d="M34 14 L48 18 L48 56 L34 52Z" fill="#c8c4c0" />
    <path d="M20 18 L34 14 L48 18 L34 22Z" fill="#d4d0cc" />
    {/* short building front */}
    <path d="M44 38 L56 35 L56 58 L44 60Z" fill="#b8b4b2" />
    <path d="M56 35 L68 38 L68 60 L56 58Z" fill="#d4d0cc" />
    <path d="M44 38 L56 35 L68 38 L56 41Z" fill="#e0dcd8" />
    {/* small building left */}
    <path d="M6 44 L14 42 L14 58 L6 60Z" fill="#b8b4b2" />
    <path d="M14 42 L22 44 L22 60 L14 58Z" fill="#d4d0cc" />
    <path d="M6 44 L14 42 L22 44 L14 46Z" fill="#e0dcd8" />
  </svg>
);

export const liveTransitPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8eef4" />
    {/* railway tracks */}
    <line x1="10" y1="60" x2="70" y2="20" stroke="#999" strokeWidth="1.5" strokeDasharray="4,3" />
    <line x1="5" y1="40" x2="75" y2="45" stroke="#999" strokeWidth="1.5" strokeDasharray="4,3" />
    <line x1="30" y1="10" x2="50" y2="70" stroke="#999" strokeWidth="1" strokeDasharray="4,3" />
    {/* train dots */}
    <circle cx="28" cy="46" r="5" fill="#EC0016" />
    <circle cx="52" cy="32" r="5" fill="#FF6600" />
    <circle cx="60" cy="44" r="4" fill="#15A3DB" />
    <circle cx="38" cy="22" r="3.5" fill="#059500" />
    {/* labels */}
    <text x="28" y="58" fontSize="6" fill="#333" fontFamily="sans-serif" textAnchor="middle">
      ICE
    </text>
    <text x="52" y="27" fontSize="6" fill="#333" fontFamily="sans-serif" textAnchor="middle">
      IC
    </text>
  </svg>
);

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

export const weatherPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="weather-radar" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#43A047" stopOpacity="0.15" />
        <stop offset="40%" stopColor="#FDD835" stopOpacity="0.35" />
        <stop offset="70%" stopColor="#FF9800" stopOpacity="0.4" />
        <stop offset="100%" stopColor="#E53935" stopOpacity="0.35" />
      </linearGradient>
    </defs>
    <rect width="80" height="80" fill="#e4eef2" />
    {/* subtle roads */}
    <line x1="0" y1="40" x2="80" y2="40" stroke="#d5dce6" strokeWidth="2.5" />
    <line x1="32" y1="0" x2="32" y2="80" stroke="#d5dce6" strokeWidth="2" />
    {/* radar sweep overlay */}
    <ellipse cx="45" cy="35" rx="30" ry="25" fill="url(#weather-radar)" />
    <ellipse cx="20" cy="55" rx="18" ry="14" fill="#43A047" opacity="0.2" />
    {/* cloud */}
    <path
      d="M22 28 Q22 20 30 20 Q34 14 42 18 Q48 16 50 22 Q56 22 56 28 Q56 34 50 34 L26 34 Q20 34 22 28Z"
      fill="#90A4AE"
      opacity="0.75"
    />
    {/* rain drops */}
    <line
      x1="28"
      y1="36"
      x2="26"
      y2="42"
      stroke="#42A5F5"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="36"
      y1="37"
      x2="34"
      y2="43"
      stroke="#42A5F5"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="44"
      y1="36"
      x2="42"
      y2="42"
      stroke="#42A5F5"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    {/* sun peeking */}
    <circle cx="62" cy="18" r="8" fill="#FFB74D" opacity="0.7" />
    <g stroke="#FFB74D" strokeWidth="1.2" strokeLinecap="round" opacity="0.5">
      <line x1="62" y1="7" x2="62" y2="9" />
      <line x1="71" y1="18" x2="73" y2="18" />
      <line x1="69" y1="11" x2="70.5" y2="9.5" />
    </g>
    {/* temperature label */}
    <text x="60" y="62" fontSize="11" fill="#E53935" fontFamily="sans-serif" fontWeight="700">
      18°
    </text>
  </svg>
);

export const environmentPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e4eef2" />
    {/* subtle roads */}
    <line x1="0" y1="32" x2="80" y2="32" stroke="#d5dce6" strokeWidth="2.5" />
    <line x1="50" y1="0" x2="50" y2="80" stroke="#d5dce6" strokeWidth="2" />
    <line x1="20" y1="0" x2="20" y2="80" stroke="#d5dce6" strokeWidth="1.5" />
    {/* sensor stations — colored circles with value labels */}
    <circle cx="14" cy="20" r="6" fill="#42A5F5" opacity="0.8" />
    <text
      x="14"
      y="22.5"
      fontSize="5.5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      8°
    </text>
    <circle cx="38" cy="16" r="6" fill="#66BB6A" opacity="0.8" />
    <text
      x="38"
      y="18.5"
      fontSize="5.5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      15°
    </text>
    <circle cx="62" cy="24" r="6" fill="#FFA726" opacity="0.85" />
    <text
      x="62"
      y="26.5"
      fontSize="5.5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      24°
    </text>
    <circle cx="26" cy="50" r="7" fill="#E53935" opacity="0.8" />
    <text
      x="26"
      y="52.5"
      fontSize="6"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      32°
    </text>
    <circle cx="56" cy="54" r="5.5" fill="#66BB6A" opacity="0.75" />
    <text
      x="56"
      y="56.2"
      fontSize="5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      17°
    </text>
    <circle cx="42" cy="68" r="5" fill="#4FC3F7" opacity="0.75" />
    <text
      x="42"
      y="70.2"
      fontSize="5"
      fill="#fff"
      fontFamily="sans-serif"
      fontWeight="700"
      textAnchor="middle"
    >
      11°
    </text>
    {/* wifi-like sensor icon in corner */}
    <g transform="translate(66, 62)" opacity="0.4">
      <circle cx="4" cy="8" r="1.5" fill="#546E7A" />
      <path d="M0 4 Q4 0 8 4" fill="none" stroke="#546E7A" strokeWidth="1.2" />
      <path d="M-2 1 Q4 -4 10 1" fill="none" stroke="#546E7A" strokeWidth="1" />
    </g>
  </svg>
);

export const satelliteImageryPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    {/* dark space/ocean background */}
    <rect width="80" height="80" fill="#1a2744" />
    {/* Earth-like land masses in satellite green/brown tones */}
    <path
      d="M8 16 Q18 10 30 18 Q38 24 46 18 L56 14 Q64 20 72 16 L80 22 L80 38 Q66 34 52 38 L38 36 Q26 40 14 34 L0 38Z"
      fill="#3a6b35"
      opacity="0.7"
    />
    <path
      d="M0 50 Q14 44 28 52 Q42 58 58 50 Q70 44 80 52 L80 80 L0 80Z"
      fill="#3a6b35"
      opacity="0.6"
    />
    {/* desert/arid region */}
    <ellipse cx="52" cy="30" rx="10" ry="6" fill="#a67c52" opacity="0.5" />
    {/* snow/ice caps */}
    <path d="M0 0 L80 0 L80 8 Q60 12 40 8 Q20 4 0 10Z" fill="#dce8f0" opacity="0.5" />
    {/* cloud wisps */}
    <ellipse cx="22" cy="38" rx="12" ry="3" fill="#fff" opacity="0.35" />
    <ellipse cx="60" cy="54" rx="10" ry="2.5" fill="#fff" opacity="0.3" />
    <ellipse cx="44" cy="68" rx="14" ry="3" fill="#fff" opacity="0.25" />
    {/* satellite icon accent */}
    <g transform="translate(62, 8)" opacity="0.7">
      <rect x="0" y="2" width="8" height="4" rx="1" fill="#90caf9" />
      <rect x="-4" y="3" width="4" height="2" rx="0.5" fill="#64b5f6" />
      <rect x="8" y="3" width="4" height="2" rx="0.5" fill="#64b5f6" />
    </g>
  </svg>
);

export const weatherAlertsPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8edf2" />
    {/* map background */}
    <path d="M0 30 Q20 24 40 30 Q60 36 80 28 L80 80 L0 80Z" fill="#dde5ec" opacity="0.4" />
    {/* extreme severity polygon */}
    <polygon
      points="12,18 32,14 36,30 18,34"
      fill="#991b1b"
      opacity="0.3"
      stroke="#991b1b"
      strokeWidth="1.2"
    />
    {/* severe severity polygon */}
    <polygon
      points="38,22 62,16 66,40 42,44"
      fill="#ea580c"
      opacity="0.3"
      stroke="#ea580c"
      strokeWidth="1.2"
    />
    {/* moderate severity polygon */}
    <polygon
      points="8,42 28,38 32,58 14,60"
      fill="#d97706"
      opacity="0.3"
      stroke="#d97706"
      strokeWidth="1.2"
    />
    {/* minor severity point alert */}
    <circle cx="58" cy="56" r="5" fill="#ca8a04" opacity="0.85" stroke="#fff" strokeWidth="1.2" />
    {/* warning icon */}
    <g transform="translate(32,50) scale(0.5)" opacity="0.7">
      <path d="M12 2L1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z" fill="#991b1b" />
    </g>
  </svg>
);
