import { describe, expect, expectTypeOf, it } from "vitest";
import type { NativeToWebPayload } from "./mobileProtocol";
import { MOBILE_PROTOCOL_MAX, nativeToWebSchema } from "./mobileProtocol";
import {
  groundFullSnapshotSchema,
  NATIVE_SNAPSHOT_HOT_FIELDS,
  type NativeSnapshot,
  transitProgressSnapshotSchema,
} from "./nativeSnapshot";

const groundFull = {
  version: 1,
  type: "full",
  kind: "ground",
  sessionId: "s1",
  revision: 4,
  routeFingerprint: "300:abc",
  status: "active",
  mode: "driving",
  route: { geometry: [[8.68, 50.11]] },
  alternatives: [],
  routeSelectionIntent: "automatic",
  progress: { alongMeters: 100 },
  weakGps: false,
  offRoute: false,
  coasting: false,
  currentSpeedLimit: 50,
  settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" },
  locale: "en",
  units: "metric",
  connectivity: "online",
  permissionMode: "background",
  reroute: { status: "idle", attempts: 0 },
} as const;

const transitProgress = {
  version: 1,
  type: "progress",
  sessionId: "t1",
  revision: 9,
  itineraryFingerprint: "trip",
  status: "active",
  currentLegIndex: 1,
  currentWalkStepIndex: 0,
  phase: "riding",
  confidence: "schedule",
  transitProgress: null,
  connectivity: "offline",
  liveStatus: { refresh: "ready", hasLiveToken: true },
} as const;

function snapshotUpdate(snapshot: unknown) {
  return nativeToWebSchema.safeParse({
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "snapshot.update",
    messageId: "m1",
    channelNonce: "n1",
    sentAtMs: 1,
    payload: { snapshot },
  });
}

describe("produced snapshots", () => {
  it("hold a native build to the complete, closed shape", () => {
    expect(groundFullSnapshotSchema.safeParse(groundFull).success).toBe(true);
    expect(transitProgressSnapshotSchema.safeParse(transitProgress).success).toBe(true);
    // Nothing extra leaves native: a raw fix would fail here.
    expect(
      groundFullSnapshotSchema.safeParse({ ...groundFull, lastAcceptedFix: { coords: [8, 50] } })
        .success,
    ).toBe(false);
    // A zero speed limit is a missing value, never a limit to show.
    expect(
      groundFullSnapshotSchema.safeParse({ ...groundFull, currentSpeedLimit: 0 }).success,
    ).toBe(false);
  });

  it("move only their hot values in a progress snapshot", () => {
    expect([...NATIVE_SNAPSHOT_HOT_FIELDS].sort()).toEqual(
      [
        "coasting",
        "confidence",
        "connectivity",
        "currentLegIndex",
        "currentSpeedLimit",
        "currentWalkStepIndex",
        "liveStatus",
        "offRoute",
        "phase",
        "progress",
        "reroute",
        "revision",
        "status",
        "transitProgress",
        "weakGps",
      ].sort(),
    );
  });
});

describe("what a page accepts", () => {
  it("accepts every produced shape, and the empty answer for no session", () => {
    expect(snapshotUpdate(groundFull).success).toBe(true);
    expect(snapshotUpdate(transitProgress).success).toBe(true);
    expect(snapshotUpdate({}).success).toBe(true);
  });

  it("accepts what a newer app adds: unknown fields and new values", () => {
    expect(
      snapshotUpdate({
        ...groundFull,
        laneGuidance: { lanes: 3 },
        status: "paused",
        mode: "scooter",
      }).success,
    ).toBe(true);
    expect(
      snapshotUpdate({ ...transitProgress, phase: "boarding", confidence: "beacon" }).success,
    ).toBe(true);
  });

  it("accepts what an older app leaves out, as long as the snapshot can be placed", () => {
    const { reroute: _reroute, coasting: _coasting, settings: _settings, ...older } = groundFull;
    expect(snapshotUpdate(older).success).toBe(true);
    expect(
      snapshotUpdate({
        type: "progress",
        sessionId: "s1",
        revision: 5,
        routeFingerprint: "300:abc",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no session", { ...groundFull, sessionId: "" }],
    ["no fingerprint", (({ routeFingerprint: _f, ...rest }) => rest)(groundFull)],
    ["an unknown snapshot type", { ...groundFull, type: "guess" }],
    ["a negative revision", { ...groundFull, revision: -1 }],
    ["a value of the wrong type", { ...groundFull, offRoute: "no" }],
    ["a record that is not a snapshot", { revision: 3 }],
  ])("refuses a snapshot with %s", (_label, snapshot) => {
    expect(snapshotUpdate(snapshot).success).toBe(false);
  });
});

describe("typed payloads", () => {
  it("accepts every produced snapshot where a native sender supplies one", () => {
    expectTypeOf<{ snapshot: NativeSnapshot }>().toExtend<NativeToWebPayload<"snapshot.update">>();
  });

  it("leaves the correlation id to the bridge", () => {
    expectTypeOf<NativeToWebPayload<"session.prepared">>().toEqualTypeOf<{
      sessionId: string;
      revision: number;
    }>();
  });

  it("does not accept one message's payload for another", () => {
    expectTypeOf<NativeToWebPayload<"permission.state">>().not.toExtend<
      NativeToWebPayload<"session.stopped">
    >();
    const stopNotice = { sessionId: "s1", finalStatus: "stopped", revision: 1 } as const;
    // @ts-expect-error A snapshot update carries a snapshot, not a stop notice.
    const wrong: NativeToWebPayload<"snapshot.update"> = stopNotice;
    expect(wrong).toBeDefined();
  });
});
