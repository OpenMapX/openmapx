import { LOCATION_PROFILE_KINDS, type LocationProfileKind, profileFor } from "./profiles";

describe("profileFor", () => {
  it("requests navigation-grade driving updates", () => {
    expect(profileFor("driving")).toMatchObject({
      accuracy: "navigation",
      timeIntervalMs: 1_000,
      distanceIntervalMeters: 3,
      activityType: "automotive-navigation",
      pausesUpdatesAutomatically: false,
    });
  });

  it("treats motorcycle as an automotive profile", () => {
    expect(profileFor("motorcycle").activityType).toBe("automotive-navigation");
  });

  it("uses a fitness activity type for cycling", () => {
    expect(profileFor("cycling")).toMatchObject({
      accuracy: "navigation",
      distanceIntervalMeters: 5,
      activityType: "fitness",
    });
  });

  it("uses a pedestrian cadence for walking", () => {
    const walking = profileFor("walking");
    expect(walking.activityType).toBe("other-navigation");
    expect(walking.distanceIntervalMeters).toBe(5);
    expect(walking.timeIntervalMs).toBeGreaterThanOrEqual(2_000);
    expect(walking.timeIntervalMs).toBeLessThanOrEqual(3_000);
  });

  it("raises transit cadence near a transfer", () => {
    expect(profileFor("transit-near-event").timeIntervalMs).toBeLessThan(
      profileFor("transit-cruise").timeIntervalMs,
    );
  });

  it("never lets the operating system pause an active session", () => {
    for (const kind of LOCATION_PROFILE_KINDS) {
      expect(profileFor(kind).pausesUpdatesAutomatically).toBe(false);
    }
  });

  it("requests at least high accuracy for every supported mode", () => {
    for (const kind of LOCATION_PROFILE_KINDS) {
      expect(["high", "navigation"]).toContain(profileFor(kind).accuracy);
    }
  });

  it("returns a frozen profile so a caller cannot mutate the shared table", () => {
    const profile = profileFor("driving");
    expect(Object.isFrozen(profile)).toBe(true);
    // Asserted by outcome rather than by a thrown error: Babel's CommonJS output
    // is not strict mode, so a write to a frozen object fails silently here.
    (profile as { timeIntervalMs: number }).timeIntervalMs = 60_000;
    expect(profileFor("driving").timeIntervalMs).toBe(1_000);
  });

  it("returns an identical profile for repeated lookups", () => {
    expect(profileFor("walking")).toBe(profileFor("walking"));
  });

  it("rejects an unknown profile kind rather than guessing a cadence", () => {
    expect(() => profileFor("teleport" as LocationProfileKind)).toThrow(
      /unknown location profile/i,
    );
  });

  it("keeps every declared kind in the table", () => {
    for (const kind of LOCATION_PROFILE_KINDS) expect(profileFor(kind)).toBeDefined();
  });
});
