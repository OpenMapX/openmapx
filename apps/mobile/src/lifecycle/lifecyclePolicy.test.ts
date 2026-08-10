import type { GroundMobileSession, MobileNavigationSession } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import {
  type AppVisibility,
  decideLifecycle,
  type LifecycleAction,
  planIncludes,
} from "./lifecyclePolicy";

const NOW = 1_700_000_100_000;

function session(overrides: Partial<GroundMobileSession> = {}): MobileNavigationSession {
  return groundSessionFixture({
    status: "active",
    startedAtMs: NOW - 60_000,
    updatedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60 * 60_000,
    ...overrides,
  });
}

function kinds(input: Parameters<typeof decideLifecycle>[0]): Array<LifecycleAction["kind"]> {
  return decideLifecycle(input).actions.map((action) => action.kind);
}

function plan(
  overrides: {
    session?: MobileNavigationSession | null;
    visibility?: AppVisibility;
    driverRunning?: boolean;
    nowMs?: number;
  } = {},
) {
  return {
    session: overrides.session === undefined ? session() : overrides.session,
    visibility: overrides.visibility ?? "active",
    driverRunning: overrides.driverRunning ?? true,
    nowMs: overrides.nowMs ?? NOW,
  };
}

describe("decideLifecycle", () => {
  describe("background sessions", () => {
    it.each<AppVisibility>(["active", "inactive", "background"])(
      "keeps a running background session while %s",
      (visibility) => {
        expect(kinds(plan({ visibility }))).toContain("keep-tracking");
      },
    );

    it("does not restart a driver the system already stopped", () => {
      const actions = kinds(plan({ driverRunning: false }));

      expect(actions).toContain("offer-resume");
      expect(actions).not.toContain("keep-tracking");
    });

    it("treats a running task plus a recorded session as authoritative", () => {
      // This is the ordinary process-recreation case: the OS relaunched the app
      // into a callback, and both halves of the state agree.
      const decision = decideLifecycle(plan({ visibility: "background" }));

      expect(planIncludes(decision, "keep-tracking")).toBe(true);
      expect(planIncludes(decision, "offer-resume")).toBe(false);
    });
  });

  describe("foreground-only sessions", () => {
    const foregroundOnly = () => session({ permissionMode: "foreground-only" });

    it("keeps delivering while the app is visible", () => {
      expect(kinds(plan({ session: foregroundOnly() }))).toContain("keep-tracking");
    });

    it.each<AppVisibility>(["inactive", "background"])(
      "pauses immediately when the app is %s",
      (visibility) => {
        const actions = kinds(plan({ session: foregroundOnly(), visibility }));

        expect(actions).toContain("pause-foreground-only");
        expect(actions).not.toContain("keep-tracking");
      },
    );

    it("waits for an explicit resume after being paused", () => {
      const actions = kinds(
        plan({ session: foregroundOnly(), visibility: "active", driverRunning: false }),
      );

      expect(actions).toContain("offer-resume-foreground-only");
      expect(actions).not.toContain("keep-tracking");
    });
  });

  describe("expiry", () => {
    it("ends a session past its lifetime rather than continuing it", () => {
      const actions = kinds(plan({ session: session({ expiresAtMs: NOW - 1 }) }));

      expect(actions).toContain("expire");
      expect(actions).not.toContain("keep-tracking");
    });

    it("expires even when the app is not visible", () => {
      expect(
        kinds(plan({ session: session({ expiresAtMs: NOW - 1 }), visibility: "background" })),
      ).toContain("expire");
    });

    it("keeps a session that expires in a moment", () => {
      expect(kinds(plan({ session: session({ expiresAtMs: NOW + 1 }) }))).toContain(
        "keep-tracking",
      );
    });
  });

  describe("orphans", () => {
    it("stops a driver that has no session behind it", () => {
      expect(kinds(plan({ session: null, driverRunning: true }))).toContain("stop-orphan-driver");
    });

    it.each(["arrived", "stopped", "expired", "error"] as const)(
      "stops a driver still running after a %s session",
      (status) => {
        expect(kinds(plan({ session: session({ status }), driverRunning: true }))).toContain(
          "stop-orphan-driver",
        );
      },
    );

    it("does nothing when there is neither a session nor a driver", () => {
      expect(kinds(plan({ session: null, driverRunning: false }))).toEqual(["keep-awake"]);
    });
  });

  describe("keep-awake", () => {
    it("is on only while a background session is visible", () => {
      const active = decideLifecycle(plan({ visibility: "active" }));
      const backgrounded = decideLifecycle(plan({ visibility: "background" }));

      expect(active.actions).toContainEqual({ kind: "keep-awake", active: true });
      expect(backgrounded.actions).toContainEqual({ kind: "keep-awake", active: false });
    });

    it("is off whenever there is no live session", () => {
      for (const input of [
        plan({ session: null }),
        plan({ session: session({ status: "stopped" }) }),
        plan({ session: session({ expiresAtMs: NOW - 1 }) }),
      ]) {
        expect(decideLifecycle(input).actions).toContainEqual({
          kind: "keep-awake",
          active: false,
        });
      }
    });

    it("is off for a paused foreground-only session", () => {
      const decision = decideLifecycle(
        plan({ session: session({ permissionMode: "foreground-only" }), visibility: "background" }),
      );

      expect(decision.actions).toContainEqual({ kind: "keep-awake", active: false });
    });
  });

  it("plans a preparing session the same way as an active one", () => {
    expect(kinds(plan({ session: session({ status: "preparing" }) }))).toContain("keep-tracking");
  });
});
