import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRequireAuth } from "../../test/auth.js";
import { osmContributionLimiters, osmContributionPublishLimit } from "../../utils/rate-limit.js";

vi.mock("../../utils/require-auth.js", () => mockRequireAuth("user-1"));

const { buildTestApp } = await import("../../test/app.js");
const { osmContributionsRoute } = await import("../osm-contributions.js");
const { OsmContributionError } = await import("../../services/osm-contributions/types.js");
const requireAuth = await import("../../utils/require-auth.js");

import type { OsmContributionService } from "../../services/osm-contributions/service.js";

const REF = { type: "node", id: 12 } as const;
const UUID = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const COMMENT = "Corrected the name from the sign on the door";

const CONTEXT = {
  ref: REF,
  version: 4,
  geometry: "point",
  center: { lat: 52.5, lon: 13.4 },
  displayName: "Café Central",
  currentPreset: { status: "matched", presetId: "amenity/cafe", name: "Cafe" },
  fields: [],
  advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=12",
  elementUrl: "https://www.openstreetmap.org/node/12",
  fetchedAt: "2026-08-10T09:00:00.000Z",
};

function fakeService(overrides: Partial<OsmContributionService> = {}): OsmContributionService {
  return {
    getCapabilities: vi.fn(async () => ({
      enabled: true,
      directEditingEnabled: true,
      linked: true,
      canWriteApi: true,
      canWriteNotes: true,
      contributorTermsAgreed: true,
      activeBlock: false,
      requiredScopes: [],
      actions: { reauthorize: false },
    })),
    getContext: vi.fn(async () => CONTEXT),
    suggestCategories: vi.fn(async () => [
      { presetId: "amenity/cafe", name: "Cafe", geometry: ["point"] },
    ]),
    preview: vi.fn(async () => ({
      ref: REF,
      baseVersion: 4,
      changes: [{ field: "name", label: "Name", action: "set", before: "A", after: "B" }],
      tagDiff: { add: [], replace: [{ key: "name", from: "A", to: "B" }], remove: [] },
      warnings: [],
      requiresReview: false,
    })),
    publish: vi.fn(async () => ({
      ref: REF,
      version: 5,
      changesetId: 77,
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
      publishedAt: "2026-08-10T09:00:00.000Z",
    })),
    createNote: vi.fn(async () => ({
      noteId: 9,
      noteUrl: "https://www.openstreetmap.org/note/9",
      status: "open" as const,
    })),
    ...overrides,
  } as unknown as OsmContributionService;
}

let app: FastifyInstance;
let service: OsmContributionService;

async function boot(overrides: Partial<OsmContributionService> = {}) {
  service = fakeService(overrides);
  app = await buildTestApp(osmContributionsRoute({ service }), { prefix: "/api" });
}

function previewBody(extra: Record<string, unknown> = {}) {
  return {
    ref: REF,
    baseVersion: 4,
    changes: [{ field: "name", action: "set", value: "Café Zentral" }],
    locale: "en",
    idempotencyKey: UUID,
    ...extra,
  };
}

function publishBody(extra: Record<string, unknown> = {}) {
  return {
    ...previewBody(),
    evidence: { kind: "survey" },
    reviewRequested: false,
    comment: COMMENT,
    ...extra,
  };
}

beforeEach(async () => {
  // The limiters are module singletons; isolate each case's budget.
  for (const limiter of osmContributionLimiters) limiter.reset();
  vi.mocked(requireAuth.requireAuthHook).mockImplementation(async (request) => {
    (request as { userId?: string }).userId = "user-1";
  });
  vi.mocked(requireAuth.getUserId).mockReturnValue("user-1");
  await boot();
});

afterEach(async () => {
  await app?.close();
});

describe("authentication", () => {
  it("requires a session on every endpoint", async () => {
    vi.mocked(requireAuth.requireAuthHook).mockImplementation(async () => {
      throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    });
    const requests = [
      { method: "GET" as const, url: "/api/osm/contributions/capabilities" },
      { method: "GET" as const, url: "/api/osm/contributions/node/12" },
      {
        method: "GET" as const,
        url: "/api/osm/contributions/categories?type=node&id=12&geometry=point&locale=en&q=cafe",
      },
      { method: "POST" as const, url: "/api/osm/contributions/preview", payload: previewBody() },
      { method: "POST" as const, url: "/api/osm/contributions/publish", payload: publishBody() },
      {
        method: "POST" as const,
        url: "/api/osm/contributions/notes",
        payload: { ref: REF, text: "The entrance is elsewhere.", idempotencyKey: UUID },
      },
    ];
    for (const request of requests) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(service.publish).not.toHaveBeenCalled();
  });
});

describe("successful responses", () => {
  it("returns capabilities", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/osm/contributions/capabilities",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, linked: true });
  });

  it("parses the element reference from the path", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/osm/contributions/way/42?locale=de",
    });
    expect(response.statusCode).toBe(200);
    expect(service.getContext).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { type: "way", id: 42 },
      "de",
    );
  });

  it("defaults the locale", async () => {
    await app.inject({ method: "GET", url: "/api/osm/contributions/node/12" });
    expect(service.getContext).toHaveBeenCalledWith(expect.anything(), REF, "en");
  });

  it("returns a preview and a publish result", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/preview",
      payload: previewBody(),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().tagDiff.replace).toHaveLength(1);

    const publish = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/publish",
      payload: publishBody(),
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toMatchObject({ changesetId: 77, version: 5 });
  });

  it("creates a note", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/notes",
      payload: { ref: REF, text: "The entrance is on the other side.", idempotencyKey: UUID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ noteId: 9 });
  });
});

describe("request validation", () => {
  it("rejects a malformed element reference", async () => {
    for (const url of [
      "/api/osm/contributions/changeset/1",
      "/api/osm/contributions/node/0",
      "/api/osm/contributions/node/-1",
      "/api/osm/contributions/node/abc",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    }
    expect(service.getContext).not.toHaveBeenCalled();
  });

  it("rejects a raw tag map, an upstream URL and changeset metadata in a body", async () => {
    for (const extra of [
      { tags: { amenity: "cafe" } },
      { apiUrl: "https://evil.example" },
      { changesetId: 5 },
      { changes: [{ field: "amenity", action: "set", value: "cafe" }] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/osm/contributions/preview",
        payload: previewBody(extra),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.preview).not.toHaveBeenCalled();
  });

  it("rejects browser-supplied coordinates on a note", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/notes",
      payload: {
        ref: REF,
        text: "The entrance is elsewhere.",
        idempotencyKey: UUID,
        lat: 0,
        lon: 0,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.createNote).not.toHaveBeenCalled();
  });

  it("rejects a publish without evidence or a human comment", async () => {
    for (const payload of [
      publishBody({ evidence: undefined }),
      publishBody({ comment: "short" }),
      publishBody({ comment: undefined }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/osm/contributions/publish",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.publish).not.toHaveBeenCalled();
  });

  it("validates and clamps the category query", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/api/osm/contributions/categories?type=node&id=12&geometry=unknown&locale=en&q=cafe",
    });
    expect(bad.statusCode).toBe(400);

    const empty = await app.inject({
      method: "GET",
      url: "/api/osm/contributions/categories?type=node&id=12&geometry=point&locale=en&q=",
    });
    expect(empty.statusCode).toBe(400);

    const clamped = await app.inject({
      method: "GET",
      url: "/api/osm/contributions/categories?type=node&id=12&geometry=point&locale=en&q=cafe&limit=999",
    });
    expect(clamped.statusCode).toBe(400);
  });
});

describe("typed errors", () => {
  it("maps the service error to the shared safe body and status", async () => {
    const cases = [
      ["FEATURE_DISABLED", 403],
      ["DIRECT_EDITING_DISABLED", 403],
      ["VERSION_CONFLICT", 409],
      ["SUBMISSION_IN_PROGRESS", 409],
      ["ELEMENT_DELETED", 410],
      ["AMBIGUOUS_RESULT", 502],
    ] as const;
    for (const [code, status] of cases) {
      await boot({
        publish: vi.fn(async () => {
          throw new OsmContributionError(code, status, "Safe message.");
        }),
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/osm/contributions/publish",
        payload: publishBody(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code, message: "Safe message." });
    }
  });

  it("emits Retry-After for a throttled contribution", async () => {
    await boot({
      publish: vi.fn(async () => {
        throw new OsmContributionError("RATE_LIMITED", 429, "Too many requests.", {
          retryAfterSeconds: 30,
        });
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/publish",
      payload: publishBody(),
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json().retryAfterSeconds).toBe(30);
  });

  it("returns a fresh context on a conflict", async () => {
    await boot({
      publish: vi.fn(async () => {
        throw new OsmContributionError("VERSION_CONFLICT", 409, "Changed upstream.", {
          context: CONTEXT as never,
        });
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/publish",
      payload: publishBody(),
    });
    expect(response.json().context.version).toBe(4);
  });

  it("never serializes an unexpected exception", async () => {
    const secret = "upstream-token-sentinel";
    await boot({
      publish: vi.fn(async () => {
        throw new Error(`boom ${secret}`);
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/osm/contributions/publish",
      payload: publishBody(),
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
    expect(response.json().code).toBe("OSM_UNAVAILABLE");
  });
});

describe("rate limiting", () => {
  it("caps publishes per user and answers with the shared throttled body", async () => {
    const responses = [];
    for (let i = 0; i < 12; i += 1) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/api/osm/contributions/publish",
          payload: publishBody(),
        }),
      );
    }
    const limited = responses.filter((response) => response.statusCode === 429);
    expect(limited.length).toBeGreaterThan(0);
    const last = limited[limited.length - 1];
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(last?.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(vi.mocked(service.publish).mock.calls.length).toBeLessThan(12);
  });

  it("keys the bucket by a digest, never the raw account id", async () => {
    await app.inject({
      method: "POST",
      url: "/api/osm/contributions/publish",
      payload: publishBody(),
    });
    const buckets = (osmContributionPublishLimit as unknown as { buckets: Map<string, unknown> })
      .buckets;
    const keys = [...buckets.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain("user-1");
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("surface", () => {
  it("exposes no raw-tag or arbitrary-upstream route", async () => {
    for (const url of [
      "/api/osm/contributions/tags",
      "/api/osm/contributions/raw",
      "/api/osm/contributions/proxy",
      "/api/osm/contributions",
    ]) {
      expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
    }
  });
});
