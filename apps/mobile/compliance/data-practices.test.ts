import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The registry is the single source of truth for what the installed app does
 * with data. The privacy policy, the store answers, and the permission surface
 * are all derived from it, because three independent descriptions of the same
 * behaviour is three chances to be wrong in different directions.
 *
 * These tests are therefore not schema validation for its own sake. Each one
 * pins a claim somebody could otherwise weaken by editing a JSON file: that a
 * practice which leaves the device names a recipient, that nothing retains data
 * for an unstated length of time, and that "not collected" is never asserted
 * about something that demonstrably travels.
 */

interface Retention {
  kind: "ephemeral" | "bounded" | "account-lifetime";
  maxHours?: number;
  note?: string;
}

interface Practice {
  id: string;
  dataType: string;
  source: string;
  leavesDevice: boolean;
  recipient?: string;
  endpoint?: string;
  purpose: string;
  linkedToAccount: boolean;
  retention: Retention;
  shared: "none" | "processor" | "third-party-controller";
  encryptedInTransit?: boolean;
  userControl: string;
  appleLabel: {
    collected: boolean;
    category: string;
    purposes?: string[];
    linkedToIdentity?: boolean;
    usedForTracking?: boolean;
    exemptionReason?: string;
  };
  googleDataSafety: {
    collected: boolean;
    shared: boolean;
    category?: string;
    ephemeral?: boolean;
    optional?: boolean;
    purposes?: string[];
  };
  legalSection: string;
  notes?: string;
}

const registry = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "data-practices.json"), "utf8"),
) as { version: number; practices: Practice[] };

const practices = registry.practices;
const byId = new Map(practices.map((practice) => [practice.id, practice]));

/** Every behaviour a reviewer would look for. A missing row is a missing answer. */
const REQUIRED_PRACTICES = [
  "precise-location-active-navigation",
  "background-location-active-navigation",
  "route-request-coordinates",
  "reroute-coordinates",
  "transit-plan-and-refresh",
  "captured-transit-stops",
  "local-alerts",
  "account-and-contact",
  "saved-places-and-settings",
  "review-keypair",
  "published-reviews",
  "diagnostics-export",
  "system-auth-handoff",
  "webview-storage",
  "map-and-media-providers",
  "store-operational-data",
];

describe("coverage", () => {
  it.each(REQUIRED_PRACTICES)("declares %s", (id) => {
    expect(byId.has(id)).toBe(true);
  });

  it("has no duplicate ids", () => {
    expect(byId.size).toBe(practices.length);
  });
});

describe("every practice answers the questions a reviewer asks", () => {
  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s names a recipient if it leaves the device",
    (_id, practice) => {
      if (!practice.leavesDevice) return;
      expect(practice.recipient).toBeTruthy();
      // "unclassified" is not a recipient; it is the absence of one.
      expect(practice.recipient?.toLowerCase()).not.toContain("unclassified");
      expect(practice.recipient?.toLowerCase()).not.toContain("various");
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s encrypts anything it sends",
    (_id, practice) => {
      if (!practice.leavesDevice) return;
      expect(practice.encryptedInTransit).toBe(true);
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s states a purpose specific enough to check",
    (_id, practice) => {
      expect(practice.purpose.length).toBeGreaterThan(40);
      for (const vague of [
        "improve the app",
        "business purposes",
        "as needed",
        "various purposes",
      ]) {
        expect(practice.purpose.toLowerCase()).not.toContain(vague);
      }
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s bounds its retention",
    (_id, practice) => {
      if (practice.retention.kind !== "bounded") return;
      // A bounded retention with no number is an unbounded retention wearing a
      // label.
      expect(typeof practice.retention.maxHours).toBe("number");
      expect(practice.retention.maxHours).toBeGreaterThan(0);
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s says how the user can control it",
    (_id, practice) => {
      expect(practice.userControl.length).toBeGreaterThan(15);
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s points at a section of the published policy",
    (_id, practice) => {
      expect(practice.legalSection).toBeTruthy();
    },
  );
});

describe("store answers cannot contradict the behaviour", () => {
  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s justifies any 'not collected' answer about data that travels",
    (_id, practice) => {
      if (!practice.leavesDevice) return;
      if (practice.appleLabel.collected) return;
      // Apple permits a real-time-processing exception, but claiming it without
      // saying why is how an app ends up with a label it cannot defend.
      expect(practice.appleLabel.exemptionReason ?? practice.notes ?? "").not.toBe("");
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s does not claim retention it says elsewhere it has",
    (_id, practice) => {
      if (practice.retention.kind !== "ephemeral") return;
      // Ephemeral means processed and discarded. A row cannot be ephemeral and
      // also linked to an account for its lifetime.
      expect(
        practice.googleDataSafety.collected === false || practice.googleDataSafety.ephemeral,
      ).toBeTruthy();
    },
  );

  it.each(practices.map((practice) => [practice.id, practice] as const))(
    "%s declares onward sharing consistently",
    (_id, practice) => {
      const sharesOnward = practice.shared === "third-party-controller";
      if (!sharesOnward) return;
      expect(practice.googleDataSafety.shared || !practice.googleDataSafety.collected).toBe(true);
    },
  );

  it("declares no tracking anywhere", () => {
    // The app has no analytics, no advertising identifier, and no cross-app
    // measurement. If that ever changes, this test is where it is noticed.
    for (const practice of practices) {
      expect(practice.appleLabel.usedForTracking ?? false).toBe(false);
    }
  });
});

describe("the location story specifically", () => {
  it("keeps navigation fixes on the device", () => {
    for (const id of [
      "precise-location-active-navigation",
      "background-location-active-navigation",
    ]) {
      // This is the claim that makes background location legitimate, and the one
      // a reviewer will check hardest.
      expect(byId.get(id)?.leavesDevice).toBe(false);
    }
  });

  it("bounds the on-device session to a day", () => {
    for (const id of [
      "precise-location-active-navigation",
      "background-location-active-navigation",
      "captured-transit-stops",
    ]) {
      const retention = byId.get(id)?.retention;
      expect(retention?.kind).toBe("bounded");
      expect(retention?.maxHours).toBeLessThanOrEqual(24);
    }
  });

  it("sends coordinates only for a route the user asked for", () => {
    const sending = practices.filter(
      (practice) => practice.leavesDevice && practice.appleLabel.category.includes("Location"),
    );

    // Every location transmission is a user-initiated request, not a stream.
    expect(sending.map((practice) => practice.id).sort()).toEqual([
      "map-and-media-providers",
      "reroute-coordinates",
      "route-request-coordinates",
      "transit-plan-and-refresh",
    ]);
  });

  it("treats every transmitted coordinate as ephemeral", () => {
    for (const id of [
      "route-request-coordinates",
      "reroute-coordinates",
      "transit-plan-and-refresh",
    ]) {
      expect(byId.get(id)?.retention.kind).toBe("ephemeral");
    }
  });
});

describe("account data", () => {
  it("says published reviews are not retracted by account deletion", () => {
    // A public commons is public. Copy claiming otherwise would be false.
    expect(byId.get("published-reviews")?.retention.note).toContain("does not retract");
  });

  it("keeps the auth handoff to two minutes", () => {
    const retention = byId.get("system-auth-handoff")?.retention;

    expect(retention?.kind).toBe("bounded");
    expect((retention?.maxHours ?? 1) * 60).toBeCloseTo(2, 1);
  });
});
