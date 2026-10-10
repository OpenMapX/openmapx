import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import type { Camera, CameraType } from "@openmapx/mobility-core/camera";
import type { OperationalEvidence } from "./operational-evidence.js";

export type {
  Camera,
  CameraStatus,
  CameraType,
  CameraView,
} from "@openmapx/mobility-core/camera";

export interface CameraQuery {
  /** Source ids the operator's data-use policy disallows. */
  excludedSourceIds?: readonly string[];
  /** Only these camera types. */
  types?: readonly CameraType[];
}

/**
 * Pluggable "cameras" capability: traffic and scenic cameras with their views
 * and current stills. The first-party `webcam` orchestrator merges every
 * registered provider behind the `webcam` data source; consumers depend only
 * on this contract, never on a provider's package.
 *
 * A provider dedups its own cameras; the orchestrator does not dedup across
 * providers. The query is a hint a provider may push into its upstream — the
 * orchestrator re-applies every filter itself.
 */
export interface CameraProvider {
  /** The OpenMapX integration id. */
  readonly id: string;
  /** When set, the orchestrator skips this provider for non-overlapping bboxes. */
  readonly coverage?: { bbox: BBox } | { all: true };
  /**
   * `partial` is set when cameras may be missing: `area` when an upstream
   * covered only part of `bbox`, `unavailable` when it did not answer.
   */
  searchCameras(
    bbox: BBox,
    q?: CameraQuery,
  ): Promise<{ cameras: Camera[]; partial?: DataSourcePartialReason }>;
  /**
   * The camera with this id, or null when this provider does not hold it.
   * The excluded sources are taken out as a search takes them out, so a
   * camera opens with the same sources it was listed with.
   */
  getCamera(id: string, q?: Pick<CameraQuery, "excludedSourceIds">): Promise<Camera | null>;
  /** The state of the feeds behind the cameras, for the coverage report. */
  getOperationalEvidence?(): Promise<OperationalEvidence>;
}
