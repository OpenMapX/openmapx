import type { IntegrationContext } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import {
  APPLIED_SET_CACHE_TTL_MS,
  APPLIED_SET_MAX_AGE_MS,
  createAppliedEdgeClosuresReader,
  shouldSkipPointExclusion,
} from "../edge-closures";

function ctxWith(
  get: ReturnType<typeof vi.fn>,
  url = "http://data-manager:4000",
): IntegrationContext {
  return {
    http: { get },
    getRequiredService: () => ({ serviceId: "data-manager", url, enabled: true }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IntegrationContext;
}

const event = (over: Record<string, unknown> = {}) =>
  ({
    id: "a:1",
    source: "autobahn-de",
    provider: "p",
    type: "road_closure",
    severity: "high",
    headline: "",
    geometry: { type: "Point", coordinates: [6.8, 51.2] },
    binding: { status: "exact" },
    ...over,
  }) as never;

describe("createAppliedEdgeClosuresReader", () => {
  it("pins the freshness window and the cache TTL", () => {
    expect(APPLIED_SET_MAX_AGE_MS).toBe(600_000);
    expect(APPLIED_SET_CACHE_TTL_MS).toBe(60_000);
  });

  it("returns a healthy set for a fresh write and caches for 60 s", async () => {
    let t = Date.parse("2026-09-06T10:00:00Z");
    const get = vi.fn().mockResolvedValue({
      writtenAt: "2026-09-06T09:59:00Z",
      observationIds: ["a:1"],
      resolverVersion: "1.0.0",
    });
    const read = createAppliedEdgeClosuresReader(ctxWith(get), () => t);
    const a = await read();
    expect(a.healthy).toBe(true);
    expect(a.ids.has("a:1")).toBe(true);
    t += 30_000;
    await read();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toBe("http://data-manager:4000/traffic/conditions/applied");
  });

  it("refetches once the cache TTL has elapsed", async () => {
    let t = Date.parse("2026-09-06T10:00:00Z");
    const get = vi
      .fn()
      .mockResolvedValue({ writtenAt: "2026-09-06T09:59:00Z", observationIds: ["a:1"] });
    const read = createAppliedEdgeClosuresReader(ctxWith(get), () => t);
    await read();
    t += APPLIED_SET_CACHE_TTL_MS;
    await read();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("is unhealthy when the write is older than 10 minutes, on error, and on 501", async () => {
    const t = Date.parse("2026-09-06T10:00:00Z");
    expect(
      (
        await createAppliedEdgeClosuresReader(
          ctxWith(
            vi
              .fn()
              .mockResolvedValue({ writtenAt: "2026-09-06T09:40:00Z", observationIds: ["a:1"] }),
          ),
          () => t,
        )()
      ).healthy,
    ).toBe(false);
    expect(
      (
        await createAppliedEdgeClosuresReader(
          ctxWith(vi.fn().mockRejectedValue(new Error("boom"))),
          () => t,
        )()
      ).healthy,
    ).toBe(false);
    expect(
      (
        await createAppliedEdgeClosuresReader(
          ctxWith(vi.fn().mockResolvedValue({ error: "live traffic not configured" })),
          () => t,
        )()
      ).healthy,
    ).toBe(false);
  });

  it("is unhealthy when the write is dated in the future (clock skew skips nothing)", async () => {
    const t = Date.parse("2026-09-06T10:00:00Z");
    const applied = await createAppliedEdgeClosuresReader(
      ctxWith(
        vi.fn().mockResolvedValue({ writtenAt: "2026-09-06T10:05:00Z", observationIds: ["a:1"] }),
      ),
      () => t,
    )();
    expect(applied.healthy).toBe(false);
    expect(shouldSkipPointExclusion(event(), applied)).toBe(false);
  });

  it("is unhealthy when the writer has never completed a live cycle", async () => {
    const t = Date.parse("2026-09-06T10:00:00Z");
    const applied = await createAppliedEdgeClosuresReader(
      ctxWith(
        vi.fn().mockResolvedValue({ writtenAt: null, observationIds: [], resolverVersion: null }),
      ),
      () => t,
    )();
    expect(applied.healthy).toBe(false);
    expect(applied.writtenAt).toBeNull();
  });

  it("falls back to DATA_MANAGER_URL when the service requirement is unresolved", async () => {
    const get = vi.fn().mockResolvedValue({ writtenAt: null, observationIds: [] });
    const ctx = {
      http: { get },
      getRequiredService: () => null,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as IntegrationContext;
    await createAppliedEdgeClosuresReader(ctx)();
    expect(get.mock.calls[0]?.[0]).toBe("http://localhost:4000/traffic/conditions/applied");
  });

  it("never doubles a slash when the service URL carries a trailing one", async () => {
    const get = vi.fn().mockResolvedValue({ writtenAt: null, observationIds: [] });
    await createAppliedEdgeClosuresReader(ctxWith(get, "http://data-manager:4000/"))();
    expect(get.mock.calls[0]?.[0]).toBe("http://data-manager:4000/traffic/conditions/applied");
  });

  it("is unhealthy and issues no request when the base URL fails the shared validator", async () => {
    const get = vi.fn().mockResolvedValue({ writtenAt: null, observationIds: [] });
    // Plaintext to a host outside the loopback/Compose allowlist.
    const applied = await createAppliedEdgeClosuresReader(ctxWith(get, "http://evil.test:4000"))();
    expect(applied.healthy).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("shouldSkipPointExclusion", () => {
  const healthy = { ids: new Set(["a:1"]), writtenAt: new Date(), healthy: true };
  it("skips only applied, routing-relevant edge closures", () => {
    expect(shouldSkipPointExclusion(event(), healthy)).toBe(true);
    expect(shouldSkipPointExclusion(event({ id: "other" }), healthy)).toBe(false);
    expect(shouldSkipPointExclusion(event({ binding: { status: "ambiguous" } }), healthy)).toBe(
      false,
    );
    expect(shouldSkipPointExclusion(event({ type: "lane_closure" }), healthy)).toBe(false);
    expect(shouldSkipPointExclusion(event({ vehiclesAffected: ["truck"] }), healthy)).toBe(false);
    expect(shouldSkipPointExclusion(event(), { ...healthy, healthy: false })).toBe(false);
  });

  it("does not skip an event with no binding at all", () => {
    expect(shouldSkipPointExclusion(event({ binding: undefined }), healthy)).toBe(false);
  });
});
