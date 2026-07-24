"use client";

import type { ReactNode } from "react";

export const defaultMapPreview: ReactNode = (
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
    <path d="M63 0H80v15q-9 3-14-4-5-6-3-11Z" fill="#c8e5be" />
    <path d="M0 55q12 5 18 13 3 5 3 12H0Z" fill="#a3d3ef" />
    <g fill="#e3ded4">
      <rect x="4" y="4" width="17" height="12" rx="1.5" />
      <rect x="35" y="4" width="14" height="12" rx="1.5" />
      <rect x="4" y="26" width="9" height="14" rx="1.5" />
      <rect x="17" y="26" width="8" height="14" rx="1.5" />
      <rect x="35" y="26" width="12" height="12" rx="1.5" />
      <rect x="62" y="50" width="14" height="12" rx="1.5" />
      <rect x="31" y="55" width="11" height="9" rx="1.5" />
    </g>
    <g fill="#d8d2c6">
      <rect x="6" y="6" width="7" height="5" rx="0.6" />
      <rect x="16" y="8" width="4" height="7" rx="0.6" />
      <rect x="37" y="7" width="9" height="5" rx="0.6" />
      <rect x="19" y="29" width="5" height="8" rx="0.6" />
      <rect x="64" y="53" width="9" height="6" rx="0.6" />
    </g>
    <g fill="none" stroke="#d0d5db" strokeLinecap="round">
      <path d="M0 20.5H80" strokeWidth="3.6" />
      <path d="M22 68H80" strokeWidth="3.6" />
      <path d="M14.5 21V56" strokeWidth="3.2" />
      <path d="M52 0V17" strokeWidth="2.8" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="7.6" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="6.4" />
    </g>
    <g fill="none" stroke="#fff" strokeLinecap="round">
      <path d="M0 20.5H80" strokeWidth="2.2" />
      <path d="M22 68H80" strokeWidth="2.2" />
      <path d="M14.5 21V56" strokeWidth="1.8" />
      <path d="M52 0V17" strokeWidth="1.6" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="5.6" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="4.4" />
    </g>
    <path
      d="M80 20Q60 26 52 40T47 80"
      fill="none"
      stroke="#e6c583"
      strokeWidth="6.6"
      strokeLinecap="round"
    />
    <path
      d="M80 20Q60 26 52 40T47 80"
      fill="none"
      stroke="#fbdf9e"
      strokeWidth="4.8"
      strokeLinecap="round"
    />
  </svg>
);

export const satellitePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    {/* aerial imagery of the same city fragment */}
    <defs>
      <linearGradient id="satelliteGround" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#85857d" />
        <stop offset="100%" stopColor="#696f6a" />
      </linearGradient>
      <linearGradient id="satelliteWater" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#4a788b" />
        <stop offset="100%" stopColor="#315d70" />
      </linearGradient>
    </defs>
    <rect x="-2" y="-2" width="84" height="84" fill="url(#satelliteGround)" />
    <path d="M58 0H80v20q-13 4-19-6-6-8-3-14Z" fill="#52775a" />
    <path d="M0 55q12 5 18 13 3 5 3 12H0Z" fill="url(#satelliteWater)" />
    {/* blocks of built-up ground */}
    <g fill="#8d8982">
      <rect x="2" y="2" width="21" height="16" />
      <rect x="33" y="2" width="18" height="16" />
      <rect x="2" y="24" width="11" height="18" />
      <rect x="16" y="24" width="10" height="18" />
      <rect x="33" y="24" width="14" height="15" />
      <rect x="60" y="48" width="18" height="16" />
      <rect x="30" y="53" width="13" height="12" />
    </g>
    {/* building shadows falling south-west */}
    <g fill="#414644" opacity="0.5">
      <rect x="3" y="5" width="8" height="6" />
      <rect x="14" y="7" width="6" height="9" />
      <rect x="35" y="6" width="11" height="7" />
      <rect x="17" y="30" width="6" height="10" />
      <rect x="62" y="52" width="12" height="8" />
      <rect x="31" y="57" width="8" height="6" />
    </g>
    {/* rooftops: pale concrete and red tile */}
    <g fill="#c5c0b5">
      <rect x="4" y="4" width="8" height="6" />
      <rect x="36" y="5" width="11" height="7" />
      <rect x="18" y="29" width="6" height="10" />
      <rect x="63" y="51" width="12" height="8" />
    </g>
    <g fill="#a36452">
      <rect x="15" y="6" width="6" height="9" />
      <rect x="5" y="27" width="6" height="7" />
      <rect x="36" y="27" width="8" height="6" />
      <rect x="32" y="56" width="8" height="6" />
    </g>
    <g fill="none" stroke="#5c615e" strokeLinecap="round">
      <path d="M0 20.5H80" strokeWidth="3.4" />
      <path d="M22 68H80" strokeWidth="3.4" />
      <path d="M14.5 21V56" strokeWidth="3" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="7" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="6" />
      <path d="M80 20Q60 26 52 40T47 80" strokeWidth="7" />
    </g>
    <g fill="none" stroke="#afb0aa" strokeLinecap="round" opacity="0.9">
      <path d="M0 20.5H80" strokeWidth="1.6" />
      <path d="M22 68H80" strokeWidth="1.6" />
      <path d="M0 46Q26 43 44 47T80 47" strokeWidth="4" />
      <path d="M28 0Q31 20 28 40T29 80" strokeWidth="3.2" />
      <path d="M80 20Q60 26 52 40T47 80" strokeWidth="4" />
    </g>
    {/* tree canopy in the park and along the avenue */}
    <g fill="#356744">
      <circle cx="66" cy="6" r="3.6" />
      <circle cx="73" cy="10" r="3" />
      <circle cx="63" cy="13" r="2.6" />
      <circle cx="71" cy="17" r="2.4" />
      <circle cx="9" cy="52" r="2.2" />
      <circle cx="17" cy="49" r="2" />
      <circle cx="52" cy="66" r="2.4" />
    </g>
  </svg>
);

export const terrainPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="terrainRelief" x1="0.15" y1="0" x2="0.85" y2="1">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.4" />
        <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="100%" stopColor="#7a6a44" stopOpacity="0.28" />
      </linearGradient>
    </defs>
    <rect x="-2" y="-2" width="84" height="84" fill="#eee7d3" />
    {/* wooded valley floor either side of the ridge */}
    <g fill="#c2d5a6">
      <path d="M-2-2h26q4 12-8 20T-2 30Z" />
      <path d="M56 82q-6-14 6-22t22-6v28Z" />
    </g>
    {/* a ridge running north-east, contoured: each band is a closed loop */}
    <g stroke="#a89568" strokeWidth="0.5">
      <path
        d="M78.2 28.1Q74.2 36.7 74.7 45.1Q75.3 53.5 63.5 58.7Q51.7 63.9 40.9 70.2Q30.2 76.5 25 70Q19.9 63.6 6.8 65.1Q-6.3 66.6-1.5 57.2Q3.3 47.7 5.6 39.6Q7.8 31.5 18.7 27Q29.6 22.5 39.8 14.7Q50 6.9 58.5 9.9Q67 13 74.6 16.3Q82.2 19.5 78.2 28.1Z"
        fill="#e7dfc7"
      />
      <path
        d="M72.3 29.4Q69.1 36.3 69.5 43.1Q70 49.9 60.5 54.1Q51 58.2 42.3 63.3Q33.7 68.3 29.6 63.2Q25.4 58 14.9 59.2Q4.4 60.4 8.2 52.8Q12.1 45.2 13.9 38.7Q15.7 32.1 24.5 28.5Q33.3 24.9 41.5 18.6Q49.6 12.4 56.5 14.8Q63.3 17.2 69.4 19.9Q75.6 22.5 72.3 29.4Z"
        fill="#e0d6b9"
      />
      <path
        d="M67.3 30.4Q64.7 35.8 65.1 41.2Q65.5 46.5 58 49.8Q50.6 53 43.8 57Q37 60.9 33.8 56.9Q30.5 52.8 22.3 53.8Q14 54.7 17.1 48.8Q20.1 42.8 21.5 37.7Q22.9 32.6 29.8 29.7Q36.7 26.9 43.1 22Q49.5 17.1 54.9 19Q60.2 20.9 65 23Q69.8 25 67.3 30.4Z"
        fill="#d8ccaa"
      />
      <path
        d="M62.2 31.5Q60.4 35.4 60.7 39.2Q60.9 43.1 55.5 45.4Q50.1 47.8 45.2 50.7Q40.3 53.5 38 50.6Q35.6 47.7 29.6 48.4Q23.7 49 25.9 44.7Q28.1 40.4 29.1 36.7Q30.1 33 35.1 31Q40.1 28.9 44.7 25.3Q49.4 21.8 53.2 23.2Q57.1 24.5 60.6 26Q64.1 27.5 62.2 31.5Z"
        fill="#d0c199"
      />
      <path
        d="M57.2 32.5Q56.1 34.9 56.2 37.3Q56.4 39.7 53 41.1Q49.7 42.6 46.7 44.4Q43.6 46.1 42.2 44.3Q40.7 42.5 37 42.9Q33.3 43.4 34.7 40.7Q36 38 36.7 35.7Q37.3 33.4 40.4 32.2Q43.5 30.9 46.3 28.7Q49.2 26.5 51.6 27.3Q54 28.2 56.2 29.1Q58.3 30.1 57.2 32.5Z"
        fill="#c7b688"
      />
      <path
        d="M53.8 32.9Q53.2 34.2 53.3 35.5Q53.4 36.8 51.6 37.5Q49.8 38.3 48.1 39.3Q46.5 40.2 45.7 39.3Q44.9 38.3 42.9 38.5Q41 38.7 41.7 37.3Q42.4 35.9 42.8 34.6Q43.1 33.4 44.8 32.7Q46.4 32 48 30.8Q49.5 29.7 50.8 30.1Q52.1 30.6 53.3 31.1Q54.4 31.6 53.8 32.9Z"
        fill="#bfab78"
      />
    </g>
    {/* hillshade: lit from the north-west */}
    <rect x="-2" y="-2" width="84" height="84" fill="url(#terrainRelief)" />
    {/* stream in the re-entrant, draining south-west */}
    <path
      d="M31 46q-5 5-12 6t-14 10-3 20"
      fill="none"
      stroke="#8fc7e0"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <path d="M4 66q6-1 7 3t-5 6-6-3Z" fill="#8fc7e0" opacity="0.85" />
    {/* summit */}
    <path d="M47.6 31.4l3.2 5.4h-6.4Z" fill="#7b6a45" />
    <path d="M47.6 31.4l3.2 5.4h-3.2Z" fill="#5f5134" />
    {/* woodland climbing the lower slopes */}
    <g fill="#6f9152" opacity="0.72">
      <circle cx="14" cy="61" r="2.6" />
      <circle cx="9" cy="56" r="2" />
      <circle cx="20" cy="65" r="1.9" />
      <circle cx="63" cy="60" r="2.4" />
      <circle cx="70" cy="57" r="1.9" />
      <circle cx="17" cy="12" r="2.2" />
      <circle cx="23" cy="8" r="1.8" />
    </g>
  </svg>
);

export const cyclingMapPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    {/* A compact CyclOSM-like city map, sharing the standard map's geography. */}
    <rect x="-2" y="-2" width="84" height="84" fill="#f3f1e8" />
    <path d="M61 0h19v19q-11 4-16-3T61 0Z" fill="#c9dfc7" />
    <path d="M0 55q12 5 18 13 3 5 3 12H0Z" fill="#a8d9ed" />
    <g fill="#ecd7ce" stroke="#cdbfb6" strokeWidth="0.55">
      <rect x="4" y="4" width="17" height="12" rx="1" />
      <rect x="35" y="4" width="14" height="12" rx="1" />
      <rect x="4" y="26" width="9" height="14" rx="1" />
      <rect x="17" y="26" width="8" height="14" rx="1" />
      <rect x="35" y="26" width="12" height="12" rx="1" />
      <rect x="62" y="50" width="14" height="12" rx="1" />
      <rect x="31" y="55" width="11" height="9" rx="1" />
    </g>
    {/* Full street hierarchy beneath the cycling information. */}
    <g fill="none" stroke="#c5c6bf" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 20.5h80M22 68h58" strokeWidth="3.8" />
      <path d="M14.5 21v35M52 0v17" strokeWidth="3.2" />
      <path d="M0 46q26-3 44 1t36 0" strokeWidth="7.6" />
      <path d="M28 0q3 20 0 40t1 40" strokeWidth="6.4" />
      <path d="M80 20Q60 26 52 40T47 80" strokeWidth="7.6" />
    </g>
    <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 20.5h80M22 68h58" strokeWidth="2.2" />
      <path d="M14.5 21v35M52 0v17" strokeWidth="1.8" />
      <path d="M0 46q26-3 44 1t36 0" strokeWidth="5.6" />
      <path d="M28 0q3 20 0 40t1 40" strokeWidth="4.4" />
      <path d="M80 20Q60 26 52 40T47 80" strokeWidth="5.6" />
    </g>
    {/* Signed touring routes: dark casing and vivid blue route line. */}
    <g fill="none" stroke="#17249f" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 46q26-3 44 1t36 0" strokeWidth="4.6" />
    </g>
    <g fill="none" stroke="#3859e8" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 46q26-3 44 1t36 0" />
    </g>
    {/* Side-of-road lanes and a separate park cycleway. */}
    <g fill="none" stroke="#26a5df" strokeLinecap="round">
      <path d="M25.5 0q3 20 .2 40t.8 40" strokeWidth="1.6" />
      <path d="M30.5 0q3 20 .2 40t.8 40" strokeWidth="1.25" strokeDasharray="2.4 1.6" />
      <path
        d="M80 20Q60 26 52 40T47 80"
        transform="translate(-3 -2)"
        strokeWidth="1.4"
        strokeDasharray="3 1.8"
      />
    </g>
    {/* A route marker sits directly on the signed cross-town cycle route. */}
    <circle cx="18" cy="44.5" r="8.4" fill="#fff" stroke="#17249f" strokeWidth="1.2" />
    <path
      d="m18.18 10-1.7-4.68C16.19 4.53 15.44 4 14.6 4H12v2h2.6l1.46 4h-4.81l-.36-1H12V7H7v2h1.75l1.82 5H9.9c-.44-2.23-2.31-3.88-4.65-3.99C2.45 9.87 0 12.2 0 15s2.2 5 5 5c2.46 0 4.45-1.69 4.9-4h4.2c.44 2.23 2.31 3.88 4.65 3.99 2.8.13 5.25-2.19 5.25-5 0-2.8-2.2-5-5-5h-.82ZM7.82 16c-.4 1.17-1.49 2-2.82 2-1.68 0-3-1.32-3-3s1.32-3 3-3c1.33 0 2.42.83 2.82 2H5v2Zm6.28-2h-1.4l-.73-2H15c-.44.58-.76 1.25-.9 2m4.9 4c-1.68 0-3-1.32-3-3 0-.93.41-1.73 1.05-2.28l.96 2.64 1.88-.68-.97-2.67c.03 0 .06-.01.09-.01 1.68 0 3 1.32 3 3s-1.33 3-3.01 3"
      fill="#2f55d4"
      transform="translate(12 38.5) scale(0.5)"
    />
    <g fill="#5a9458">
      <circle cx="66" cy="7" r="2.7" />
      <circle cx="73" cy="11" r="2.4" />
      <circle cx="64" cy="15" r="2.1" />
      <circle cx="72" cy="17" r="1.8" />
    </g>
  </svg>
);

export const standardMapPreview: ReactNode = defaultMapPreview;

export const globePreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect x="-2" y="-2" width="84" height="84" fill="#0a1628" />
    {/* stars */}
    <g fill="#dce8f8" opacity="0.55">
      <circle cx="9" cy="10" r="0.7" />
      <circle cx="70" cy="14" r="0.6" />
      <circle cx="16" cy="68" r="0.6" />
      <circle cx="66" cy="70" r="0.7" />
      <circle cx="6" cy="42" r="0.5" />
    </g>
    <circle cx="40" cy="40" r="29" fill="#88c6fc" opacity="0.16" />
    <circle cx="40" cy="40" r="27" fill="#1f5f9e" />
    {/* ocean shading towards the terminator */}
    <path d="M40 13a27 27 0 0 1 0 54 27 27 0 0 0 0-54Z" fill="#0f3f70" opacity="0.55" />
    {/* land masses */}
    <g fill="#3d8c5c">
      <path d="M22 24l9-6 8 3 5-3 6 5-3 6-9 2-5 5-8-3-5-4Z" />
      <path d="M46 30l10-1 6 6-2 7-6 3-4-6-5-3Z" />
      <path d="M20 42l7 1 3 6-2 8-6 4-5-6 1-8Z" />
      <path d="M38 48l9-1 6 4-2 7-8 4-6-6Z" />
      <path d="M56 46l6 1 1 5-5 3-3-5Z" />
      <path d="M31 58l5 2-1 5-5-1Z" />
    </g>
    {/* graticule */}
    <g fill="none" stroke="#a8d4ff" strokeWidth="0.6" opacity="0.35">
      <ellipse cx="40" cy="40" rx="13" ry="27" />
      <ellipse cx="40" cy="40" rx="23" ry="27" />
      <path d="M13 40h54" />
      <path d="M17 26h46" />
      <path d="M17 54h46" />
    </g>
    <circle cx="40" cy="40" r="27" fill="none" stroke="#88c6fc" strokeWidth="1.1" opacity="0.5" />
  </svg>
);
