import { createApiClient } from "@openmapx/core";
import { getApiDataManagerTransitJobsId } from "@openmapx/core/api-admin-sdk";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const database = vi.hoisted(() => ({ results: [] as unknown[][], calls: 0, authenticated: true }));
vi.mock("../../db/index.js", () => ({
  db: {
    select: () => {
      database.calls++;
      const rows = database.results.shift() ?? [];
      const builder: Record<string, unknown> = {};
      for (const name of ["from", "where", "limit", "offset", "orderBy"])
        builder[name] = () => builder;
      Object.assign(builder, {
        // biome-ignore lint/suspicious/noThenProperty: the real Drizzle builders are thenable.
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      });
      return builder;
    },
  },
  sql: {},
}));
vi.mock("../../utils/require-admin.js", () => ({
  tryAdminSession: async () =>
    database.authenticated
      ? { user: { id: "admin", role: "admin" }, session: { id: "session" } }
      : null,
}));
beforeEach(() => {
  database.results = [];
  database.calls = 0;
  database.authenticated = true;
});
afterEach(() => vi.unstubAllGlobals());

describe("serialized data-manager job projections", () => {
  it("rejects malformed job IDs before PostgreSQL UUID casts and authenticates first", async () => {
    const app = Fastify();
    const { dataManagerRoute } = await import("../data-manager.js");
    await app.register(dataManagerRoute, { prefix: "/api" });
    try {
      expect((await app.inject("/api/data-manager/transit/jobs/not-a-uuid")).statusCode).toBe(400);
      expect(database.calls).toBe(0);
      database.authenticated = false;
      expect((await app.inject("/api/data-manager/transit/jobs/not-a-uuid")).statusCode).toBe(401);
      expect(database.calls).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("keeps the jobs page ceiling in its canonical query normalization", async () => {
    database.results = [[], [{ total: 0 }]];
    const app = Fastify();
    const { dataManagerRoute } = await import("../data-manager.js");
    await app.register(dataManagerRoute, { prefix: "/api" });
    try {
      const response = await app.inject("/api/data-manager/transit/jobs?limit=900&offset=2");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobs: [], total: 0, limit: 200, offset: 2 });
    } finally {
      await app.close();
    }
  });
  it("preserves JSONB provenance and serializes database dates through the generated browser SDK", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const date = new Date("2026-10-19T00:00:00.000Z");
    const metadata = {
      countries: ["de"],
      source: "source-mutation",
      nested: { selected: true, absent: null },
    };
    const error = { message: "Fetch failed", stack: "source stack" };
    const artifacts = { feeds: [{ id: "de:fixture", license: { attribution: "Operator" } }] };
    database.results = [
      [
        {
          id: jobId,
          kind: "transitous-sync",
          status: "error",
          startedAt: date,
          finishedAt: date,
          triggeredBy: "user:admin",
          idempotencyKey: null,
          metadata,
        },
      ],
      [
        {
          id: "22222222-2222-4222-8222-222222222222",
          stage: "fetch",
          status: "error",
          startedAt: date,
          finishedAt: date,
          durationMs: 0,
          message: null,
          error,
          artifacts,
        },
      ],
    ];
    const app = Fastify();
    const { dataManagerRoute } = await import("../data-manager.js");
    await app.register(dataManagerRoute, { prefix: "/api" });
    vi.stubGlobal("fetch", administrationSdkFetch(app));
    try {
      const result = await getApiDataManagerTransitJobsId(jobId, {
        client: createApiClient({ baseUrl: "https://app.test", credentials: "include" }),
      });
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error("Expected job details");
      expect(result.data).toMatchObject({
        startedAt: date.toISOString(),
        finishedAt: date.toISOString(),
        metadata,
        stages: [
          { startedAt: date.toISOString(), finishedAt: date.toISOString(), error, artifacts },
        ],
      });
      expect(database.results).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
