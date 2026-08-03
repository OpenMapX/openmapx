import { describe, expect, it } from "vitest";
import {
  OFFLINE_PACKAGE_METRIC_EVENT,
  recordOfflinePackageMetric,
  sanitizeOfflinePackageMetric,
} from "./packageMetrics";

const PACKAGE_ID = `omp1-${"a".repeat(64)}`;

describe("offline package metrics", () => {
  it("keeps lifecycle fields while dropping location and identity data", () => {
    const metric = sanitizeOfflinePackageMetric({
      event: "verify",
      packageId: PACKAGE_ID,
      status: "error",
      datasetVersion: "2026-08-03",
      styleVersion: "style-1",
      durationMs: 1234.7,
      byteLength: 2048.2,
      errorCode: "checksum-mismatch",
      browserCapability: { indexedDb: true, opfs: false, cacheStorage: true },
      bbox: [-10, 40, 10, 50],
      route: [
        [1, 2],
        [3, 4],
      ],
      destinationLabel: "home",
      userId: "user-1",
    } as never);

    expect(metric).toEqual({
      event: "verify",
      packageId: PACKAGE_ID,
      status: "error",
      datasetVersion: "2026-08-03",
      styleVersion: "style-1",
      durationMs: 1235,
      byteLength: 2048,
      errorCode: "checksum-mismatch",
      browserCapability: { indexedDb: true, opfs: false, cacheStorage: true },
    });
    expect("bbox" in metric).toBe(false);
    expect("route" in metric).toBe(false);
    expect("destinationLabel" in metric).toBe(false);
    expect("userId" in metric).toBe(false);
  });

  it("emits the sanitized metric as an in-process event", () => {
    let received: Event | undefined;
    const listener = (event: Event) => {
      received = event;
    };
    window.addEventListener(OFFLINE_PACKAGE_METRIC_EVENT, listener);
    const metric = recordOfflinePackageMetric({
      event: "cold-reload",
      packageId: PACKAGE_ID,
      status: "local-package",
    });
    window.removeEventListener(OFFLINE_PACKAGE_METRIC_EVENT, listener);

    expect(metric.packageId).toBe(PACKAGE_ID);
    expect(received?.type).toBe(OFFLINE_PACKAGE_METRIC_EVENT);
    expect((received as CustomEvent).detail).toEqual(metric);
  });
});
