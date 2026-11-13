import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../../app";
import { session, user } from "../../db/schema";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

const TRUSTED_ORIGIN = "https://web.example.test";
const CLOSED_LOCAL_URL = "http://127.0.0.1:9";
const PASSWORD = "synthetic-password-1234";
const MIB = 1024 * 1024;
const BODY_LIMIT_PROBE = "/api/body-limit-probe";
const BODY_METHODS = ["post", "put", "patch", "delete"];
const AUTHENTICATED_LEVELS = new Set(["session", "admin", "service"]);

interface Operation {
  method: string;
  url: string;
  level: string;
}

/**
 * Every operation of the published API document that needs credentials and
 * accepts a body. The document lists core routes and integration routes alike,
 * so a route added later is probed without anyone extending this test.
 */
function authenticatedBodyOperations(): Operation[] {
  const document = JSON.parse(
    readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
  ) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const operations: Operation[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const level = String(operation["x-openmapx-auth"]);
      if (!BODY_METHODS.includes(method) || !AUTHENTICATED_LEVELS.has(level)) continue;
      operations.push({
        method: method.toUpperCase(),
        url: path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000000"),
        level,
      });
    }
  }
  return operations;
}

/**
 * The mobile sign-in handoff checks the caller's origin and validates its small
 * body before it looks for a session, and its own 4 KiB body limit bounds what
 * an anonymous caller can make the server read.
 */
const MOBILE_ISSUE = { method: "POST", url: "/api/mobile-auth/issue" };

const operations = authenticatedBodyOperations().filter(
  (operation) => !(operation.method === MOBILE_ISSUE.method && operation.url === MOBILE_ISSUE.url),
);

describeDatabase("authentication before the request body, through createApp()", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let app: App;
  let customIntegrations: string;
  let nextAddress = 1;
  const uploads: number[] = [];

  /** A distinct peer per request keeps the rate limiter out of the way. */
  function freshAddress(): string {
    nextAddress += 1;
    return `10.${(nextAddress >> 16) & 255}.${(nextAddress >> 8) & 255}.${nextAddress & 255}`;
  }

  function send(
    operation: { method: string; url: string },
    payload: string,
    headers: Record<string, string> = {},
  ) {
    return app.server.inject({
      method: operation.method as "POST",
      url: operation.url,
      payload,
      remoteAddress: freshAddress(),
      headers: { "content-type": "application/json", ...headers },
    });
  }

  async function signIn(role: "admin" | "user"): Promise<{ cookie: string; userId: string }> {
    const { auth } = await import("../../auth");
    const email = `${randomUUID()}@example.test`;
    const created = await auth.api.createUser({
      body: { name: "Synthetic account", email, password: PASSWORD, role },
    });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
    const response = await app.server.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: freshAddress(),
      headers: { origin: TRUSTED_ORIGIN },
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return { cookie, userId: created.user.id };
  }

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    fixture = await createMigratedPostgresFixture();
    customIntegrations = await mkdtemp(join(tmpdir(), "openmapx-auth-before-body-"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("DATABASE_URL", fixture.connectionUri);
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-with-enough-length-for-auth-0123456789");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", "ab".repeat(32));
    vi.stubEnv("CORS_ORIGIN", TRUSTED_ORIGIN);
    vi.stubEnv("OSM_API_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_WEB_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_DISCOVERY_URL", `${CLOSED_LOCAL_URL}/.well-known/openid-configuration`);
    vi.stubEnv("OPENMAPX_CUSTOM_INTEGRATIONS_DIR", customIntegrations);
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "");
    vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");

    const { createApp } = await import("../../app");
    // Integration setup may request its upstreams; keep this suite off the
    // network. The only reachable host is the review image upload endpoint.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("upload.mangrove.reviews")) {
          const form = init?.body;
          if (form instanceof FormData) {
            const file = form.get("files");
            if (file instanceof Blob) uploads.push(file.size);
          }
          return new Response(JSON.stringify(["uploaded-image"]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("External network forbidden in the application fixture");
      }),
    );
    app = await createApp();
    app.server.post(BODY_LIMIT_PROBE, async () => ({ reached: true }));
    await app.server.ready();
  }, 240_000);

  afterAll(async () => {
    try {
      await app?.stop();
      const { sql } = await import("../../db/index");
      await sql.end({ timeout: 5 });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      const { rm } = await import("node:fs/promises");
      await rm(customIntegrations, { recursive: true, force: true });
      await fixture?.stop();
    }
  }, 60_000);

  it("probes the whole authenticated surface", () => {
    expect(operations.length).toBeGreaterThan(150);
    expect(new Set(operations.map((operation) => operation.level))).toEqual(
      new Set(AUTHENTICATED_LEVELS),
    );
  });

  // Malformed JSON is the probe: a 400 proves the body was parsed first.
  it.each(operations.map((operation) => [`${operation.method} ${operation.url}`, operation]))(
    "%s answers 401 before parsing the body",
    async (_name, operation) => {
      const response = await send(operation as Operation, "{");
      expect(response.statusCode).toBe(401);
    },
  );

  it("holds the mobile sign-in handoff to its own 4 KiB body limit", async () => {
    const response = await send(MOBILE_ISSUE, JSON.stringify({ padding: "x".repeat(5 * 1024) }), {
      origin: TRUSTED_ORIGIN,
    });
    expect(response.statusCode).toBe(413);
  });

  it("answers 401 to an anonymous body larger than any route accepts", async () => {
    const response = await send(
      { method: "POST", url: "/api/saved/lists/import" },
      JSON.stringify({ padding: "x".repeat(12 * MIB) }),
    );
    expect(response.statusCode).toBe(401);
  });

  it("treats an expired session cookie like no session", async () => {
    const account = await signIn("user");
    const live = await send({ method: "POST", url: "/api/saved/lists" }, "{", {
      cookie: account.cookie,
      origin: TRUSTED_ORIGIN,
    });
    expect(live.statusCode).toBe(400);

    await fixture.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(session.userId, account.userId));
    for (const operation of [
      { method: "POST", url: "/api/saved/lists/import" },
      { method: "POST", url: "/api/shares" },
      { method: "POST", url: "/api/integrations/reviews/image" },
    ]) {
      const response = await send(operation, "{", {
        cookie: account.cookie,
        origin: TRUSTED_ORIGIN,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("refuses an administrator route to a signed-in ordinary user before the body", async () => {
    const account = await signIn("user");
    const response = await send({ method: "POST", url: "/api/admin/accounts" }, "{", {
      cookie: account.cookie,
      origin: TRUSTED_ORIGIN,
    });
    expect(response.statusCode).toBe(403);
  });

  it("limits a body sent to a route without its own limit to 1 MiB", async () => {
    const request = (size: number) =>
      send(
        { method: "POST", url: BODY_LIMIT_PROBE },
        JSON.stringify({ padding: "x".repeat(size) }),
      );

    expect((await request(MIB - 1024)).statusCode).toBe(200);
    expect((await request(MIB + 1024)).statusCode).toBe(413);
  });

  it("still accepts the largest review image from a signed-in user", async () => {
    const account = await signIn("user");
    const image = Buffer.alloc(5 * MIB, 0xff);
    const payload = JSON.stringify({
      dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
      filename: "photo.jpg",
    });
    expect(payload.length).toBeGreaterThan(6.6 * MIB);
    expect(payload.length).toBeLessThan(7 * MIB);

    const response = await send(
      { method: "POST", url: "/api/integrations/reviews/image" },
      payload,
      {
        cookie: account.cookie,
        origin: TRUSTED_ORIGIN,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ src: "https://files.mangrove.reviews/uploaded-image" });
    expect(uploads).toEqual([5 * MIB]);
  });

  it("keeps the route-flow route able to take the largest input its validation admits", async () => {
    const point = [-123.45678901234567, -12.345678901234567];
    // A full map-matching trace at full precision stays inside the default limit.
    const trace = Array.from({ length: 10_000 }, () => ({
      lat: point[1],
      lng: point[0],
      time: "2026-11-09T12:00:00.000+00:00",
    }));
    const match = JSON.stringify({ trace, mode: "drive" });
    expect(match.length).toBeLessThan(MIB);
    const matched = await send({ method: "POST", url: "/api/integrations/routing/match" }, match);
    expect(matched.statusCode).not.toBe(413);

    const geometry = Array.from({ length: 20_000 }, () => point);
    const routes = JSON.stringify({
      routes: Array.from({ length: 4 }, (_, index) => ({ id: `route-${index}`, geometry })),
    });
    expect(routes.length).toBeGreaterThan(3 * MIB);
    const flow = await send(
      { method: "POST", url: "/api/integrations/road-conditions/flow-along-route" },
      routes,
    );
    expect(flow.statusCode).not.toBe(413);

    const oversized = await send(
      { method: "POST", url: "/api/integrations/road-conditions/flow-along-route" },
      JSON.stringify({ routes: [], padding: "x".repeat(4 * MIB) }),
    );
    expect(oversized.statusCode).toBe(413);
  });

  it("refuses a review image above 7 MiB and an oversized body to other integration routes", async () => {
    const account = await signIn("user");
    const headers = { cookie: account.cookie, origin: TRUSTED_ORIGIN };

    const image = await send(
      { method: "POST", url: "/api/integrations/reviews/image" },
      JSON.stringify({ dataUrl: `data:image/jpeg;base64,${"A".repeat(7 * MIB)}` }),
      headers,
    );
    expect(image.statusCode).toBe(413);

    const submission = await send(
      { method: "POST", url: "/api/integrations/reviews/submit" },
      JSON.stringify({ jwt: "x".repeat(2 * MIB) }),
      headers,
    );
    expect(submission.statusCode).toBe(413);
  });

  it("still accepts a signed-in import of 2,000 realistic rows", async () => {
    const account = await signIn("user");
    const places = Array.from({ length: 2000 }, (_, index) => ({
      name: `Cafe ${index}`,
      lat: 52 + index / 10_000,
      lng: 13 + index / 10_000,
      note: "Imported from a takeout file with a note of ordinary length for this row.",
      fieldContributors: {
        lat: [{ sourceId: "geocoder", name: "A geocoder with a descriptive display name" }],
        lng: [{ sourceId: "geocoder", name: "A geocoder with a descriptive display name" }],
      },
    }));
    const payload = JSON.stringify({ target: { name: "Takeout" }, places });
    expect(payload.length).toBeGreaterThan(MIB / 2);

    const response = await send({ method: "POST", url: "/api/saved/lists/import" }, payload, {
      cookie: account.cookie,
      origin: TRUSTED_ORIGIN,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ imported: 2000 });
  });
});
