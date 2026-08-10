export const DAWARICH_LIMITS = {
  requestTimeoutMs: 10_000,
  timelineOrSettingsMaxBytes: 2 * 1024 * 1024,
  tracksPageMaxBytes: 5 * 1024 * 1024,
  maxRedirects: 2,
  tracksPerPage: 500,
  maxTrackPages: 20,
  maxTrackFeaturesPerDay: 10_000,
} as const;

export type DawarichLimits = typeof DAWARICH_LIMITS;
