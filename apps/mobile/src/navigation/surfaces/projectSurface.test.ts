import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  FIXTURE_TOKEN,
  transitItineraryFixture,
  transitSessionFixture,
} from "../transit/testing/transitFixture";
import { projectSurface } from "./projectSurface";
import { surfaceText } from "./surfaceModel";

const now = 1_700_000_100_000;
function requireProjection(s: Parameters<typeof projectSurface>[0]) {
  const projected = projectSurface(s, now);
  if (!projected) throw new Error("expected a surface");
  return projected;
}
function ground() {
  const s = groundSessionFixture({ status: "active" });
  s.lastAcceptedFix = { coords: [1, 2], accuracy: 5, timestampMs: now };
  s.payload.progress = {
    currentStepIndex: 0,
    distanceToNextManeuver: 200,
    distanceRemaining: 1200,
    durationRemaining: 300,
  };
  return s;
}
it("projects a bounded maneuver, distance and ETA without location or route data", () => {
  const p = requireProjection(ground());
  expect(p.instruction).toContain("Beispielstraße");
  expect(p.detail).toContain("1.2 km");
  expect(p.staleAtMs).toBe(now + 60_000);
  expect(JSON.stringify(p)).not.toMatch(/geometry|coords|accuracy|destinationWaypoints/);
});
it("honors imperial units and German copy", () => {
  const s = ground();
  s.locale = "de";
  s.units = "imperial";
  // The phone banner's rule: feet below a mile, no thousands separator.
  expect(projectSurface(s, now)?.detail).toContain("3937 ft");
  s.payload.weakGps = true;
  expect(projectSurface(s, now)?.instruction).toMatch(/GPS/);
});
it("formats German distance decimals and duration units", () => {
  const s = ground();
  s.locale = "de";
  expect(projectSurface(s, now)?.detail).toContain("1,2 km");
  expect(projectSurface(s, now)?.detail).toContain("5 Min.");
});
it.each([
  ["walking", 0, "Walk to Hauptbahnhof"],
  ["waiting-to-board", 1, "Board at Hauptbahnhof"],
  ["riding", 1, "Get off at Messe"],
] as const)(
  "keeps explicitly scheduled %s guidance until progress becomes stale",
  (phase, legIndex, instruction) => {
    const s = transitSessionFixture();
    s.payload.confidence = "schedule";
    s.payload.tickState.phase = phase;
    s.payload.tickState.currentLegIndex = legIndex;
    s.payload.tickState.lastProgressAtMs = now - 10_000;
    s.lastAcceptedFix = { coords: [1, 2], accuracy: 5, timestampMs: now - 120_000 };
    const itinerary = transitItineraryFixture();
    s.payload.startPackage.itinerary = itinerary;
    const leg = itinerary.legs[legIndex];
    const eventAt = now + 40_000;
    if (phase === "waiting-to-board") leg.startTime = new Date(eventAt).toISOString();
    else leg.endTime = new Date(eventAt).toISOString();
    const p = requireProjection(s);
    expect(p.status).toBe("active");
    expect(p.instruction).toBe(instruction);
    expect(p.detail).toContain("Scheduled");
    expect(p.eventAtMs).toBe(eventAt);
    expect(p.staleAtMs).toBe(eventAt);
    // A schedule tick must not masquerade as a fresh GPS fix.
    expect(p.observedAtMs).toBe(now - 120_000);
    leg.endTime = leg.startTime = new Date(now + 90_000).toISOString();
    expect(projectSurface(s, now)?.staleAtMs).toBe(now + 50_000);
    s.payload.tickState.lastProgressAtMs = now - 60_001;
    expect(projectSurface(s, now)?.status).toBe("stale");
    expect(projectSurface(s, now)?.eventAtMs).toBeNull();
    s.payload.confidence = "stale";
    s.payload.tickState.lastProgressAtMs = now;
    expect(projectSurface(s, now)?.instruction).toContain("outdated");
  },
);
it("bounds feed text in UTF-16 without splitting an astral character", () => {
  expect(surfaceText("😀".repeat(160))).toBe("😀".repeat(80));
  expect(surfaceText(`${"a".repeat(159)}😀`)).toBe("a".repeat(159));
});
it("does not renew freshness from a coasted fix or a new publication timestamp", () => {
  const s = ground();
  if (!s.lastAcceptedFix) throw new Error("fixture needs a fix");
  s.lastAcceptedFix.coasted = true;
  expect(projectSurface(s, now)?.status).toBe("stale");
  s.lastAcceptedFix.coasted = false;
  s.lastAcceptedFix.timestampMs = now - 70_000;
  expect(projectSurface(s, now)?.status).toBe("stale");
});
it("rejects preparing, expired and absent authority but preserves reversible arrival", () => {
  expect(projectSurface(null, now)).toBeNull();
  expect(projectSurface(groundSessionFixture(), now)).toBeNull();
  expect(projectSurface({ ...ground(), expiresAtMs: now }, now)).toBeNull();
  expect(projectSurface({ ...ground(), status: "arrived" }, now)?.status).toBe("arrived");
});
it("projects transit phases without rotating credentials or coordinates", () => {
  const s = transitSessionFixture();
  s.payload.tickState.currentLegIndex = 1;
  s.payload.tickState.phase = "riding";
  s.lastAcceptedFix = { coords: [1, 2], accuracy: 5, timestampMs: now };
  const p = requireProjection(s);
  expect(p.instruction).toContain("Messe");
  expect(p.title).toContain("S1");
  expect(JSON.stringify(p)).not.toContain(FIXTURE_TOKEN);
  expect(JSON.stringify(p)).not.toMatch(/refreshToken|geometry|coords/);
});
it.each([
  [1, 3],
  [2, 2],
  [3, 1],
])("counts the next captured stop %i among the %i stops remaining", (cursor, remaining) => {
  const s = transitSessionFixture();
  s.payload.tickState.currentLegIndex = 1;
  s.payload.tickState.phase = "riding";
  s.payload.tickState.stopCursor = cursor;
  s.lastAcceptedFix = { coords: [8.68, 50.11], accuracy: 5, timestampMs: now };
  expect(projectSurface(s, now)?.detail).toBe(`${remaining} stops remaining`);
});
it("bounds untrusted feed text and ignores impossible progress", () => {
  const s = ground();
  (s.payload.startPackage.route.steps[0] as { instruction: string }).instruction =
    `\n${"ä".repeat(400)}\u0000`;
  s.payload.progress = {
    currentStepIndex: Infinity,
    distanceRemaining: -1,
    durationRemaining: NaN,
  };
  const p = requireProjection(s);
  expect(p.instruction.length).toBeLessThanOrEqual(160);
  expect(p.instruction).not.toContain(String.fromCharCode(0));
  expect(p.instruction).not.toContain("\n");
  expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(3000);
});
it("shows the upcoming maneuver rather than the maneuver already performed", () => {
  const s = ground();
  s.payload.startPackage.route.steps.push({
    ...s.payload.startPackage.route.steps[0],
    instruction: "Turn right into Example Street",
  });
  expect(projectSurface(s, now)?.instruction).toBe("Turn right into Example Street");
});
it("hides outdated remaining-distance and ETA while rerouting or GPS is weak", () => {
  const s = ground();
  s.payload.offRoute = true;
  expect(projectSurface(s, now)?.detail).toBe("");
  s.payload.offRoute = false;
  s.payload.weakGps = true;
  expect(projectSurface(s, now)?.detail).toBe("");
});
