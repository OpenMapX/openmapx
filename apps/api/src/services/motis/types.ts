import type { BBox } from "../transit/types";

export type MotisFeedStatus = "pending" | "downloading" | "ready" | "failed";

export interface MotisFeed {
  slug: string;
  name: string;
  url: string;
  countryCode: string;
  status: MotisFeedStatus;
  filename: string;
  addedAt: string;
  errorMessage: string | null;
  bbox: BBox | null;
}

export interface MotisStatus {
  configured: boolean;
  url: string;
  reachable: boolean;
  feeds: MotisFeed[];
  needsRestart: boolean;
}
