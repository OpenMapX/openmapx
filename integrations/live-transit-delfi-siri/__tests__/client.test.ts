import { readFileSync } from "node:fs";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { MemoryUpstreamRuntime } from "../../overlay-air-quality/test-helpers";
import { createSiriClient } from "../client";
import { SOURCE_ID } from "../match";

const xml = readFileSync(new URL("./fixtures/rhein-ruhr-re1.siri.xml", import.meta.url), "utf8");
function fixture() {
  const now = () => Date.parse("2026-11-06T21:19:00Z");
  const runtime = new MemoryUpstreamRuntime(now);
  const ctx = createMockIntegrationContext();
  let disabled = false;
  ctx.upstreamRuntime = runtime;
  ctx.getDisallowedSourceIds = async () => new Set(disabled ? [SOURCE_ID] : []);
  const fetch = vi.fn(async () => ({
    status: 200,
    headers: { etag: '"v1"' },
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(xml));
        c.close();
      },
    }),
  }));
  ctx.http.getStream = fetch;
  return {
    ctx,
    runtime,
    fetch,
    now,
    disable: () => {
      disabled = true;
    },
  };
}
describe("shared SIRI feed acquisition", () => {
  it("publishes compact buckets before the manifest and serves a cached train without another fetch", async () => {
    const f = fixture();
    const client = createSiriClient(f.ctx, f.now);
    await client.refresh();
    expect((await client.get("2026-11-06", "26839"))?.records[0].calls).toHaveLength(27);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const values = [...f.runtime.values.values()].map((v) => JSON.stringify(v.value));
    expect(values.some((v) => v.includes("<Siri"))).toBe(false);
    expect(f.runtime.leases.size).toBe(0);
  });
  it("denies acquisition without shared runtime or quota", async () => {
    const f = fixture();
    f.runtime.quotaDecision = { allowed: false, remaining: {}, retryAt: null };
    await createSiriClient(f.ctx, f.now).refresh();
    expect(f.fetch).not.toHaveBeenCalled();
    f.ctx.upstreamRuntime = undefined;
    await createSiriClient(f.ctx, f.now).refresh();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("never serves cached evidence after the source was disabled", async () => {
    const f = fixture();
    const client = createSiriClient(f.ctx, f.now);
    await client.refresh();
    f.disable();
    expect(await client.get("2026-11-06", "26839")).toBeUndefined();
    await client.refresh();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("releases the lease after malformed XML and does not publish a manifest", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue({
      status: 200,
      headers: {},
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("<bad>"));
          c.close();
        },
      }),
    });
    await expect(createSiriClient(f.ctx, f.now).refresh()).rejects.toThrow();
    expect(f.runtime.leases.size).toBe(0);
    expect(f.runtime.values.size).toBe(0);
  });
  it("coalesces concurrent callers using the shared lease", async () => {
    const f = fixture();
    await Promise.all([
      createSiriClient(f.ctx, f.now).refresh(),
      createSiriClient(f.ctx, f.now).refresh(),
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

it("uses conditional requests and renews compact buckets on 304 without freshening source time", async () => {
  const f = fixture();
  let at = f.now();
  const now = () => at;
  // Runtime and client must share the same advancing clock.
  const runtime = new MemoryUpstreamRuntime(now);
  Object.assign(f.ctx, { upstreamRuntime: runtime });
  const client = createSiriClient(f.ctx, now);
  await client.refresh();
  at += 301_000;
  f.fetch.mockResolvedValue({
    status: 304,
    headers: {},
    stream: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
  });
  await client.refresh();
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.fetch.mock.calls[1][1].headers).toMatchObject({ "If-None-Match": '"v1"' });
  expect((await client.get("2026-11-06", "26839"))?.records[0].recordedAt).toBe(
    "2026-11-06T18:30:58.165Z",
  );
});
it("does not publish data if policy changes while acquiring the feed", async () => {
  const f = fixture();
  const original = f.fetch.getMockImplementation();
  if (!original) throw new Error("Missing fixture fetch");
  f.fetch.mockImplementation(async () => {
    const result = await original();
    f.disable();
    return result;
  });
  await createSiriClient(f.ctx, f.now).refresh();
  expect(f.runtime.values.size).toBe(0);
  expect(f.runtime.leases.size).toBe(0);
});
