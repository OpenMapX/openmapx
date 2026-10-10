import type { Attribution } from "./attribution.js";

/** What a camera looks at; the OpenConditions `camera` feature types. */
export type CameraType = "traffic" | "landscape" | "city" | "weather" | "beach" | "other";

/** The OpenConditions `camera_status` vocabulary. */
export type CameraStatus = "online" | "offline" | "stale" | "unknown";

/** One direction or preset of a camera, with its current still and/or stream. */
export interface CameraView {
  /** Unique within the camera; a single-view camera uses "0". */
  key: string;
  name?: string;
  /** Degrees clockwise from north, 0 <= bearing < 360. */
  bearing?: number;
  /** Free-text direction when the source gives no bearing (e.g. "Northbound"). */
  direction?: string;
  road?: string;
  /** The current still. Absent for a stream-only view. */
  imageUrl?: string;
  thumbnailUrl?: string;
  streamUrl?: string;
  streamType?: "hls" | "rtsp" | "mjpeg" | "webrtc" | "mp4";
  status: CameraStatus;
  /** Seconds between new images; the provider copies the camera's value onto each view. */
  refreshSec?: number;
  /** When the still was taken, as an ISO 8601 timestamp. */
  imageAt?: string;
  /** True when the reading is past its validity. */
  stale: boolean;
  /**
   * The publisher's page for this view's still. A camera linked across
   * sources lists every member's views, so each view links its own
   * publisher, as some publishers' terms require of a shown image.
   */
  detailUrl?: string;
  /** Whether this view's still may be republished (proxied) or only linked. */
  imageRedistribution?: "allowed" | "link_only" | "unknown";
}

export interface Camera {
  id: string;
  name: string;
  type: CameraType;
  country?: string;
  coordinates: [number, number];
  operator?: { name: string; website?: string };
  /** The publisher's page for this camera. */
  detailUrl?: string;
  /** A third-party player page; it loads in the browser only after consent. */
  playerEmbedUrl?: string;
  views: CameraView[];
  sources: string[];
  attributions: Attribution[];
}
