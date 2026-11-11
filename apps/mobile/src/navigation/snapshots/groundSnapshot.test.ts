import {
  type GroundMobileSession,
  groundFullSnapshotSchema,
  groundProgressSnapshotSchema,
  NATIVE_SNAPSHOT_VERSION,
  nativeSnapshotWireSchema,
} from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { groundFullSnapshot, groundProgressSnapshot } from "./groundSnapshot";

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

    expect(snapshot.version).toBe(NATIVE_SNAPSHOT_VERSION);
    expect(snapshot.type).toBe("full");
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.revision).toBe(4);
    expect(snapshot.kind).toBe("ground");
    expect(snapshot.mode).toBe("driving");
    expect(snapshot.route).toBeTruthy();
    expect(snapshot.routeFingerprint).toEqual(expect.any(String));
    expect(snapshot.routeSelectionIntent).toBe("automatic");

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

  it("never carries the raw last fix", () => {
    const serialised = JSON.stringify(groundProgressSnapshot(session()));

    expect(serialised).not.toContain("8.6812345");
  });
});

describe("the shared snapshot contract", () => {
  it("produces exactly the shared shapes, with nothing extra", () => {
    const moving = session();
    moving.payload.progress = { alongMeters: 120, speedMps: 12 } as never;
    moving.payload.currentSpeedLimit = 50;

    expect(groundFullSnapshotSchema.safeParse(groundFullSnapshot(moving)).success).toBe(true);
    expect(groundProgressSnapshotSchema.safeParse(groundProgressSnapshot(moving)).success).toBe(
      true,
    );
  });

  it("is accepted by the page", () => {
    for (const snapshot of [groundFullSnapshot(session()), groundProgressSnapshot(session())]) {
      expect(nativeSnapshotWireSchema.safeParse(snapshot).success).toBe(true);
    }
  });
});
