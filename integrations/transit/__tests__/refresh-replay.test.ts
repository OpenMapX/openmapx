import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { expect, it, vi } from "vitest";
import { MemoryUpstreamRuntime } from "../../overlay-air-quality/test-helpers";
import { createRefreshReplay } from "../refresh-replay";

it("replays a lost response and serializes concurrent requests across contexts", async () => {
  const a = createMockIntegrationContext();
  const b = createMockIntegrationContext();
  const values = new Map<string, unknown>();
  Object.assign(a, {
    cache: {
      get: async (k: string) => values.get(k),
      set: async (k: string, v: unknown) => {
        values.set(k, v);
      },
      del: async (k: string) => {
        values.delete(k);
      },
    },
  });
  Object.assign(b, { cache: a.cache });
  const runtime = new MemoryUpstreamRuntime();
  Object.assign(a, { upstreamRuntime: runtime });
  Object.assign(b, { upstreamRuntime: runtime });
  const work = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return { status: 200, body: { token: "same-successor" } };
  });
  const [first, concurrent] = await Promise.all([
    createRefreshReplay(a)("verified-id", work),
    createRefreshReplay(b)("verified-id", work),
  ]);
  expect(first).toEqual(concurrent);
  expect(await createRefreshReplay(a)("verified-id", work)).toEqual(first);
  expect(work).toHaveBeenCalledTimes(1);
  expect(runtime.leases.size).toBe(0);
});
it("retains retryability on provider failure and uses a local mutex only without runtime", async () => {
  const ctx = createMockIntegrationContext();
  const values = new Map<string, unknown>();
  Object.assign(ctx, {
    cache: {
      get: async (k: string) => values.get(k),
      set: async (k: string, v: unknown) => {
        values.set(k, v);
      },
      del: async (k: string) => {
        values.delete(k);
      },
    },
  });
  const replay = createRefreshReplay(ctx);
  await expect(
    replay("id", async () => {
      throw new Error("unavailable");
    }),
  ).resolves.toMatchObject({ status: 503 });
  const work = vi.fn(async () => ({ status: 200, body: { token: "next" } }));
  await Promise.all([replay("id", work), replay("id", work)]);
  expect(work).toHaveBeenCalledTimes(1);
});

it("does not retire state when a result write was silently fenced or unavailable", async () => {
  const ctx = createMockIntegrationContext();
  const del = vi.spyOn(ctx.cache, "del");
  expect(
    await createRefreshReplay(ctx)("id", async () => ({ status: 200, body: { token: "next" } })),
  ).toMatchObject({ status: 503 });
  expect(del).not.toHaveBeenCalled();
});
