import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { FIXTURE_TOKEN, transitSessionFixture } from "../transit/testing/transitFixture";
import { projectSurface } from "./projectSurface";

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
  expect(projectSurface(s, now)?.detail).toContain("mi");
  s.payload.weakGps = true;
  expect(projectSurface(s, now)?.instruction).toMatch(/GPS/);
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
