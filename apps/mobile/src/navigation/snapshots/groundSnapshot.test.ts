import type { GroundMobileSession } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  applyGroundSnapshot,
  GROUND_SNAPSHOT_VERSION,
  groundFullSnapshot,
  groundProgressSnapshot,
  type SnapshotView,
} from "./groundSnapshot";

function session(overrides: Partial<GroundMobileSession> = {}): GroundMobileSession {
  return groundSessionFixture({
    status: "active",
    revision: 4,
    lastAcceptedFix: {
      coords: [8.6812345, 50.1109876],
      accuracy: 4,
      timestampMs: 1_700_000_100_000,
    },
    ...overrides,
  });
}

describe("groundFullSnapshot", () => {
  it("carries the identity and route a page needs to start rendering", () => {
    const snapshot = groundFullSnapshot(session());

    expect(snapshot.version).toBe(GROUND_SNAPSHOT_VERSION);
    expect(snapshot.type).toBe("full");
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.revision).toBe(4);
    expect(snapshot.kind).toBe("ground");
    expect(snapshot.mode).toBe("driving");
    expect(snapshot.route).toBeTruthy();
    expect(snapshot.routeFingerprint).toEqual(expect.any(String));
    expect(snapshot.routeSelectionIntent).toBe("automatic");
  });

  it("carries the read model the UI shows", () => {
    const snapshot = groundFullSnapshot(session());

    expect(snapshot).toMatchObject({
      weakGps: false,
      offRoute: false,
      coasting: false,
      currentSpeedLimit: null,
      locale: "en",
      units: "metric",
      connectivity: "online",
      permissionMode: "background",
    });
    expect(snapshot.settings).toBeTruthy();
    expect(snapshot.reroute).toBeTruthy();
  });

  it("never carries the raw last fix", () => {
    const snapshot = groundFullSnapshot(session());
    const serialised = JSON.stringify(snapshot);

    expect(serialised).not.toContain("8.6812345");
    expect(serialised).not.toContain("50.1109876");
    expect(serialised).not.toContain("lastAcceptedFix");
  });

  it("never carries destination waypoints or routing options", () => {
    const snapshot = groundFullSnapshot(session()) as unknown as Record<string, unknown>;

    expect(snapshot.destinationWaypoints).toBeUndefined();
    expect(snapshot.routeOptions).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("destinationWaypoints");
  });

  it("never carries engine internals the UI cannot use", () => {
    const serialised = JSON.stringify(groundFullSnapshot(session()));

    for (const internal of [
      "tickState",
      "offRouteScore",
      "spokenCues",
      "cueLedger",
      "committedStepIndex",
    ]) {
      expect(serialised).not.toContain(internal);
    }
  });

  it("does not share mutable arrays with the session it projected", () => {
    const current = session();
    const snapshot = groundFullSnapshot(current);

    (snapshot.route as { geometry: number[][] }).geometry.push([9.99, 49.99]);

    expect(current.payload.startPackage.route.geometry).toHaveLength(2);
  });
});

describe("groundProgressSnapshot", () => {
  it("carries the identity a consumer needs to apply it safely", () => {
    const snapshot = groundProgressSnapshot(session());

    expect(snapshot.type).toBe("progress");
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.revision).toBe(4);
    expect(snapshot.routeFingerprint).toEqual(expect.any(String));
  });

  it("carries only the values that change while moving", () => {
    const snapshot = groundProgressSnapshot(session()) as unknown as Record<string, unknown>;

    expect(Object.keys(snapshot).sort()).toEqual([
      "coasting",
      "connectivity",
      "currentSpeedLimit",
      "offRoute",
      "progress",
      "reroute",
      "revision",
      "routeFingerprint",
      "sessionId",
      "status",
      "type",
      "version",
      "weakGps",
    ]);
  });

  it("never carries the route", () => {
    const snapshot = groundProgressSnapshot(session()) as unknown as Record<string, unknown>;

    expect(snapshot.route).toBeUndefined();
    expect(snapshot.alternatives).toBeUndefined();
  });

  it("never carries the raw last fix", () => {
    const serialised = JSON.stringify(groundProgressSnapshot(session()));

    expect(serialised).not.toContain("8.6812345");
  });
});

describe("applyGroundSnapshot", () => {
  const full = groundFullSnapshot(session());
  const applied = applyGroundSnapshot(null, full);
  const view = (applied as { view: SnapshotView }).view;

  it("accepts a full snapshot from nothing", () => {
    expect(applied.ok).toBe(true);
    expect(view.revision).toBe(4);
  });

  it("applies a newer delta for the same route", () => {
    const delta = groundProgressSnapshot(session({ revision: 5, offRoute: true } as never));

    const result = applyGroundSnapshot(view, { ...delta, revision: 5 });

    expect(result.ok).toBe(true);
    expect((result as { view: SnapshotView }).view.revision).toBe(5);
  });

  it("keeps the route a delta does not carry", () => {
    const delta = groundProgressSnapshot(session({ revision: 5 }));

    const result = applyGroundSnapshot(view, delta) as { view: SnapshotView };

    expect(result.view.full.route).toEqual(full.route);
  });

  it("asks for a full snapshot when there is nothing to apply a delta to", () => {
    const delta = groundProgressSnapshot(session({ revision: 5 }));

    expect(applyGroundSnapshot(null, delta)).toEqual({ ok: false, reason: "need-full-snapshot" });
  });

  it("refuses a delta for a different session", () => {
    const delta = groundProgressSnapshot(session({ sessionId: "session-2", revision: 5 }));

    expect(applyGroundSnapshot(view, delta)).toEqual({ ok: false, reason: "need-full-snapshot" });
  });

  it("refuses a delta whose route changed underneath it", () => {
    const delta = {
      ...groundProgressSnapshot(session({ revision: 5 })),
      routeFingerprint: "a-different-road",
    };

    expect(applyGroundSnapshot(view, delta)).toEqual({ ok: false, reason: "need-full-snapshot" });
  });

  it.each([4, 3, 0])("refuses a delta at non-increasing revision %i", (revision) => {
    const delta = { ...groundProgressSnapshot(session({ revision })), revision };

    expect(applyGroundSnapshot(view, delta)).toEqual({ ok: false, reason: "need-full-snapshot" });
  });

  it("accepts a full snapshot even when it moves the revision backwards", () => {
    // A full snapshot is authoritative by definition: it is what the session
    // actually is, and a reload legitimately produces one at any revision.
    const older = groundFullSnapshot(session({ revision: 2 }));

    const result = applyGroundSnapshot(view, older);

    expect(result.ok).toBe(true);
    expect((result as { view: SnapshotView }).view.revision).toBe(2);
  });
});
