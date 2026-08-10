import { describe, expect, it } from "vitest";
import {
  applyNativeSnapshot,
  browserEngineAllowed,
  envelopeOf,
  forgetEvents,
  type NativeReadModel,
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
