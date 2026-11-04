import type { TransitMobileSession } from "@openmapx/core/navigation";
import { TransitNavigationProcessor } from "./TransitNavigationProcessor";
import { transitStartPackageFixture } from "./testing/transitFixture";

it("applies rider actions through native processor and retains them across serialization", () => {
  const p = new TransitNavigationProcessor();
  const prepared = p.prepare(transitStartPackageFixture(), {
    sessionId: "test",
    nowMs: 1800000000000,
    permissionMode: "foreground-only",
  });
  if (!prepared.ok) throw Error(prepared.code);
  const session = { ...prepared.session, status: "active" } as TransitMobileSession;
  const ride = (
    session.payload.startPackage.itinerary as { legs: { tripId?: string }[] }
  ).legs.findIndex((l) => l.tripId);
  const result = p.transitAction(session, { type: "board", legIndex: ride }, 1800000000000);
  expect("ok" in result).toBe(false);
  if ("ok" in result) return;
  const restored = JSON.parse(JSON.stringify(result.session));
  expect(restored.payload.tickState.phase).toBe("riding");
  const off = p.transitAction(restored, { type: "alight", legIndex: ride }, 1800000001000);
  if ("ok" in off) throw Error(off.code);
  expect(off.session.payload.tickState.phase).not.toBe("riding");
});
it("rejects a rider action for another leg rather than acknowledging an unchanged trip", () => {
  const p = new TransitNavigationProcessor();
  const r = p.prepare(transitStartPackageFixture(), {
    sessionId: "test",
    nowMs: 1800000000000,
    permissionMode: "foreground-only",
  });
  if (!r.ok) throw Error(r.code);
  expect(
    p.transitAction(
      { ...r.session, status: "active" } as TransitMobileSession,
      { type: "board", legIndex: 99 },
      1800000000000,
    ),
  ).toEqual({ ok: false, code: "invalid-action" });
});
it("owns walking speech natively and deduplicates it after restart", () => {
  const p = new TransitNavigationProcessor();
  const prepared = p.prepare(transitStartPackageFixture(), {
    sessionId: "speech",
    nowMs: 1800000000000,
    permissionMode: "foreground-only",
  });
  if (!prepared.ok) throw Error(prepared.code);
  const session = { ...prepared.session, status: "active" } as TransitMobileSession;
  const leg = (session.payload.startPackage.itinerary as { legs: Record<string, unknown>[] })
    .legs[0];
  leg.geometry = {
    type: "LineString",
    coordinates: [
      [0, 0],
      [0.002, 0],
    ],
  };
  leg.from = { name: "Home", lat: 0, lng: 0 };
  leg.to = { name: "Stop", lat: 0, lng: 0.002 };
  leg.steps = [
    { instruction: "DEPART", distanceMeters: 100 },
    { instruction: "LEFT", streetName: "Main Street", distanceMeters: 120 },
  ];
  const result = p.processFixes(
    session,
    [{ coords: [0.0001, 0], accuracy: 5, timestampMs: 1800000000000 }],
    1800000000000,
  );
  const speech = result.effects?.filter((e) => e.kind === "speak") ?? [];
  expect(speech).toHaveLength(1);
  expect(JSON.stringify(speech)).toContain("Turn left onto Main Street");
  const again = p.processFixes(JSON.parse(JSON.stringify(result.session)), [], 1800000001000);
  expect(again.effects?.filter((e) => e.kind === "speak") ?? []).toHaveLength(0);
});
