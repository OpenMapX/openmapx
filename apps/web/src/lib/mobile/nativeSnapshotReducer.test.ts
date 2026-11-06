import { describe, expect, it } from "vitest";
import {
  applyNativeSnapshot,
  browserEngineAllowed,
  envelopeOf,
  forgetEvents,
  type NativeReadModel,
  projectionOf,
  rememberEvent,
  type SnapshotEnvelope,
} from "./nativeSnapshotReducer";

function fullSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: "full",
    kind: "ground",
    sessionId: "s1",
    revision: 4,
    routeFingerprint: "route-a",
    route: { geometry: [[8.68, 50.11]] },
    status: "active",
    progress: { alongMeters: 100 },
    offRoute: false,
    ...overrides,
  };
}

function progressSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: "progress",
    sessionId: "s1",
    revision: 5,
    routeFingerprint: "route-a",
    status: "active",
    progress: { alongMeters: 200 },
    offRoute: false,
    ...overrides,
  };
}

const envelope = (raw: unknown) => envelopeOf(raw) as SnapshotEnvelope;

function seeded(): NativeReadModel {
  const outcome = applyNativeSnapshot(null, envelope(fullSnapshot()));
  if (!outcome.ok) throw new Error("seed failed");
  return outcome.model;
}

describe("envelopeOf", () => {
  it("normalises a ground fingerprint", () => {
    expect(envelopeOf(fullSnapshot())).toMatchObject({
      type: "full",
      sessionId: "s1",
      revision: 4,
      fingerprint: "route-a",
      kind: "ground",
    });
  });

  it("normalises a transit fingerprint", () => {
    // Ground and transit name it differently on the wire; spreading that
    // conditional through every consumer is how one of them gets it wrong.
    const transit = { ...fullSnapshot(), kind: "transit", itineraryFingerprint: "it-a" };
    delete (transit as Record<string, unknown>).routeFingerprint;

    expect(envelopeOf(transit)).toMatchObject({ fingerprint: "it-a", kind: "transit" });
  });

  it.each([
    { label: "nothing", value: undefined },
    { label: "a string", value: "snapshot" },
    { label: "an unknown type", value: { ...fullSnapshot(), type: "guess" } },
    { label: "no session", value: { ...fullSnapshot(), sessionId: "" } },
    { label: "a non-numeric revision", value: { ...fullSnapshot(), revision: "4" } },
    { label: "no fingerprint", value: { ...fullSnapshot(), routeFingerprint: "" } },
  ])("refuses $label", ({ value }) => {
    expect(envelopeOf(value)).toBeNull();
  });
});

describe("applyNativeSnapshot", () => {
  it("accepts a full snapshot from nothing", () => {
    const outcome = applyNativeSnapshot(null, envelope(fullSnapshot()));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.revision).toBe(4);
    expect(outcome.changed).toBe(true);
  });

  it("applies the next delta", () => {
    const outcome = applyNativeSnapshot(seeded(), envelope(progressSnapshot()));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.revision).toBe(5);
    expect((outcome.model.snapshot.progress as { alongMeters: number }).alongMeters).toBe(200);
  });

  it("keeps the route a delta does not carry", () => {
    const outcome = applyNativeSnapshot(seeded(), envelope(progressSnapshot()));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.snapshot.route).toBeTruthy();
  });

  it("asks for a full snapshot when there is nothing to apply a delta to", () => {
    expect(applyNativeSnapshot(null, envelope(progressSnapshot()))).toEqual({
      ok: false,
      reason: "need-full-snapshot",
    });
  });

  it("refuses a delta for a different session", () => {
    expect(applyNativeSnapshot(seeded(), envelope(progressSnapshot({ sessionId: "s2" })))).toEqual({
      ok: false,
      reason: "need-full-snapshot",
    });
  });

  it("refuses a delta whose route changed underneath it", () => {
    // Its progress describes a line the page does not have.
    expect(
      applyNativeSnapshot(seeded(), envelope(progressSnapshot({ routeFingerprint: "route-b" }))),
    ).toEqual({ ok: false, reason: "need-full-snapshot" });
  });

  it.each([4, 3, 0])("refuses a delta at non-increasing revision %i", (revision) => {
    expect(applyNativeSnapshot(seeded(), envelope(progressSnapshot({ revision })))).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("asks for a full snapshot rather than interpolating a gap", () => {
    // A missed update is a moment of staleness; an invented one is a puck on the
    // wrong road.
    expect(applyNativeSnapshot(seeded(), envelope(progressSnapshot({ revision: 9 })))).toEqual({
      ok: false,
      reason: "need-full-snapshot",
    });
  });

  it("accepts a full snapshot that moves the revision backwards", () => {
    // A full snapshot is what the session actually is, and a reload legitimately
    // produces one at any revision.
    const outcome = applyNativeSnapshot(seeded(), envelope(fullSnapshot({ revision: 2 })));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.revision).toBe(2);
  });

  it("applies only the fields a delta is allowed to move", () => {
    const outcome = applyNativeSnapshot(
      seeded(),
      envelope(progressSnapshot({ route: { geometry: [] }, settings: { voiceEnabled: false } })),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // A delta rewriting the route would be a route change with no fingerprint
    // change, which is exactly what the fingerprint check exists to catch.
    expect(outcome.model.snapshot.route).toEqual({ geometry: [[8.68, 50.11]] });
  });

  it("keeps pending events across a delta", () => {
    const model = rememberEvent(seeded(), "e1");

    const outcome = applyNativeSnapshot(model, envelope(progressSnapshot()));

    expect(outcome.ok && outcome.model.pendingEventIds).toEqual(["e1"]);
  });

  it("keeps pending events across a full snapshot for the same session", () => {
    const model = rememberEvent(seeded(), "e1");

    const outcome = applyNativeSnapshot(model, envelope(fullSnapshot({ revision: 9 })));

    expect(outcome.ok && outcome.model.pendingEventIds).toEqual(["e1"]);
  });

  it("drops pending events when the session changes", () => {
    const model = rememberEvent(seeded(), "e1");

    const outcome = applyNativeSnapshot(model, envelope(fullSnapshot({ sessionId: "s2" })));

    expect(outcome.ok && outcome.model.pendingEventIds).toEqual([]);
  });

  it("reports an unchanged full snapshot as unchanged", () => {
    const outcome = applyNativeSnapshot(seeded(), envelope(fullSnapshot()));

    expect(outcome.ok && outcome.changed).toBe(false);
  });
});

describe("event acknowledgement", () => {
  it("remembers an event once", () => {
    const model = rememberEvent(rememberEvent(seeded(), "e1"), "e1");

    expect(model.pendingEventIds).toEqual(["e1"]);
  });

  it("forgets acknowledged events", () => {
    const model = rememberEvent(rememberEvent(seeded(), "e1"), "e2");

    expect(forgetEvents(model, ["e1"]).pendingEventIds).toEqual(["e2"]);
  });

  it("ignores an acknowledgement for an event it never had", () => {
    const model = rememberEvent(seeded(), "e1");

    expect(forgetEvents(model, ["somewhere-else"]).pendingEventIds).toEqual(["e1"]);
  });
});

describe("browserEngineAllowed", () => {
  it("allows the browser engine only in an ordinary browser", () => {
    expect(browserEngineAllowed("browser")).toBe(true);
  });

  it.each(["native", "negotiating", "error"] as const)("refuses it while %s", (authority) => {
    // Two engines would produce two answers to "where am I", spoken over each
    // other.
    expect(browserEngineAllowed(authority)).toBe(false);
  });
});

describe("projectionOf for transit", () => {
  it("hands the shell engine's leg and phase to the page as transitProgress", () => {
    const transitProgress = {
      currentLegIndex: 1,
      snapped: [8.68, 50.11],
      fractionAlongLeg: 0,
      deviationMeters: 3,
      arrived: false,
      phase: "waiting-to-board",
    };
    const raw = {
      version: 1,
      type: "full",
      kind: "transit",
      sessionId: "t1",
      revision: 2,
      itineraryFingerprint: "it-a",
      status: "active",
      itinerary: { legs: [] },
      transitProgress,
    };
    const outcome = applyNativeSnapshot(null, envelope(raw));
    if (!outcome.ok) throw new Error("not applied");
    expect(projectionOf(outcome.model, "full").transitProgress).toEqual(transitProgress);
  });
});

it("projects consecutive transit producer deltas without requiring a resume snapshot", () => {
  const initial = {
    currentLegIndex: 0,
    currentWalkStepIndex: 0,
    distanceToNextStepMeters: 100,
    position: [8, 50],
    phase: "walking",
    fractionAlongLeg: 0,
    deviationMeters: 0,
    arrived: false,
  };
  const full = applyNativeSnapshot(
    null,
    envelope({
      type: "full",
      kind: "transit",
      sessionId: "t",
      revision: 1,
      itineraryFingerprint: "trip",
      status: "active",
      transitProgress: initial,
    }),
  );
  if (!full.ok) throw Error("full refused");
  const nextProgress = {
    ...initial,
    currentWalkStepIndex: 1,
    distanceToNextStepMeters: 70,
    position: [8.001, 50],
    fractionAlongLeg: 0.4,
  };
  // Same shape as transitProgressSnapshot, including the nested read model.
  const next = applyNativeSnapshot(
    full.model,
    envelope({
      version: 1,
      type: "progress",
      sessionId: "t",
      revision: 2,
      itineraryFingerprint: "trip",
      status: "active",
      currentLegIndex: 0,
      currentWalkStepIndex: 1,
      phase: "walking",
      confidence: "live",
      transitProgress: nextProgress,
      connectivity: "online",
      liveStatus: { refresh: "stale", hasLiveToken: true },
      itinerary: { legs: ["must not replace the selected trip"] },
    }),
  );
  if (!next.ok) throw Error("delta refused");
  expect(projectionOf(next.model, "progress")).toMatchObject({
    transitProgress: nextProgress,
    liveDataUnavailable: true,
    connectivity: "online",
    confidence: "live",
  });
  expect(next.model.snapshot.itinerary).toBeUndefined();
  const empty = applyNativeSnapshot(
    next.model,
    envelope({
      type: "progress",
      sessionId: "t",
      revision: 3,
      itineraryFingerprint: "trip",
      status: "active",
      transitProgress: null,
    }),
  );
  if (!empty.ok) throw Error("empty delta refused");
  expect(projectionOf(empty.model, "progress").transitProgress).toEqual(nextProgress);
});

it("never rolls a transit timetable back when an older full snapshot arrives late", () => {
  const full = (revision: number, departure: string, fingerprint = "selected") =>
    envelope(
      fullSnapshot({
        kind: "transit",
        routeFingerprint: undefined,
        itineraryFingerprint: fingerprint,
        revision,
        itinerary: { legs: [{ startTime: departure, scheduledStartTime: "2026-11-06T08:44:00Z" }] },
        captures: [
          { stops: [{ expectedDeparture: departure, scheduledDeparture: "2026-11-06T08:44:00Z" }] },
        ],
        liveStatus: { refresh: "broken", hasLiveToken: true },
      }),
    );
  const delayed = applyNativeSnapshot(null, full(8, "2026-11-06T08:45:00Z"));
  if (!delayed.ok) throw Error("fixture");
  expect(applyNativeSnapshot(delayed.model, full(7, "2026-11-06T08:44:00Z"))).toEqual({
    ok: false,
    reason: "stale",
  });
  expect(applyNativeSnapshot(delayed.model, full(7, "2026-11-06T08:44:00Z", "older-trip"))).toEqual(
    { ok: false, reason: "stale" },
  );
  const onTime = applyNativeSnapshot(delayed.model, full(9, "2026-11-06T08:44:00Z"));
  expect(onTime.ok && onTime.model.revision).toBe(9);
  const newSession = { ...full(1, "2026-11-06T08:44:00Z"), sessionId: "new-session" };
  expect(applyNativeSnapshot(delayed.model, newSession).ok).toBe(true);
  expect(applyNativeSnapshot(null, full(1, "2026-11-06T08:44:00Z")).ok).toBe(true);
});
