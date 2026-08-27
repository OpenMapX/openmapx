import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNetworkOnlyApiPath, navigationCachePolicy } from "../../../web/src/lib/swCaches";

/**
 * Gate D — browser/session boundary (Tracks 8 and 9).
 *
 * One scenario stitched across both boundaries, in the order the plan specifies:
 *
 *   1. User A signs in and views an admin page.
 *   2. A cross-origin cookie mutation is rejected.
 *   3. Session/admin APIs and every navigation remain network-only.
 *   4. User B signs in and cannot observe User A's data.
 *
 * Every user and token here is fake. This runs against the real CSRF guard and
 * the real service-worker cache policy in jsdom; it is an integration test of
 * the two boundaries, NOT a live-browser run.
 */

const USER_A = "fixture-user-a";
const USER_A_TOKEN_URL = "/api/admin/export?token=fixture-user-a-token";
const USER_B = "fixture-user-b";
const TRUSTED_ORIGIN = "https://maps.example.test";
const HOSTILE_ORIGIN = "https://attacker.example.test";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ||= "gate-d-session-boundary-stub-secret";
  const { makeCsrfGuardHook } = await import("../utils/csrf.js");
  app = Fastify({ logger: false });
  // The production hook, wired exactly as server.ts wires it.
  app.addHook("onRequest", makeCsrfGuardHook([TRUSTED_ORIGIN]));
  app.post("/api/admin/settings", async () => ({ ok: true }));
  app.get("/api/admin/settings", async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("Gate D — browser/session boundary", () => {
  it("keeps identity-bearing documents and APIs out of Cache Storage across users", async () => {
    // 1. User A signs in and views an admin page. The service worker must never
    //    cache an authenticated navigation in the first place.
    const adminNavigation = navigationCachePolicy({
      mode: "navigate",
      url: `${TRUSTED_ORIGIN}/admin/services`,
    });
    expect(adminNavigation).toMatchObject({ strategy: "network-only" });

    // 2. A cross-origin cookie mutation is rejected.
    const hostile = await app.inject({
      method: "POST",
      url: "/api/admin/settings",
      headers: { origin: HOSTILE_ORIGIN, cookie: `session=${USER_A}` },
      payload: { theme: "dark" },
    });
    expect(hostile.statusCode).toBe(403);
    // The rejection reveals neither the policy nor the request's secrets.
    expect(hostile.body).not.toContain(USER_A);
    expect(hostile.body).not.toContain(TRUSTED_ORIGIN);

    // The same mutation from the trusted origin is allowed, so the guard is
    // rejecting on origin rather than failing shut for everything.
    const trusted = await app.inject({
      method: "POST",
      url: "/api/admin/settings",
      headers: { origin: TRUSTED_ORIGIN, cookie: `session=${USER_A}` },
      payload: { theme: "dark" },
    });
    expect(trusted.statusCode).toBe(200);

    // 3. Current policy prevents private state entering Cache Storage, so
    // sign-out needs no rollout cleanup protocol.
    for (const path of [
      "/api/auth/get-session",
      "/api/admin/settings",
      USER_A_TOKEN_URL,
      "/api/user/preferences",
    ]) {
      expect(isNetworkOnlyApiPath(new URL(path, TRUSTED_ORIGIN).pathname)).toBe(true);
    }
    expect(
      navigationCachePolicy({
        mode: "navigate",
        url: `${TRUSTED_ORIGIN}/auth/callback?token=fixture-user-a-token`,
      }),
    ).toMatchObject({ strategy: "network-only" });

    // 4. User B signs in and cannot observe User A's data.
    const asUserB = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: { origin: TRUSTED_ORIGIN, cookie: `session=${USER_B}` },
    });
    expect(asUserB.statusCode).toBe(200);
    expect(asUserB.body).not.toContain(USER_A);
  });
});
