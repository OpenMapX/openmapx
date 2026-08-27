import {
  mintTransitousCapability,
  verifyTransitousCapability,
} from "@openmapx/core/transitous-runner";
import { describe, expect, it } from "vitest";
import { createTransitousScriptRunner, TransitousScriptError } from "./script-runner.js";

const KEY = Buffer.alloc(32, 9);
const NOW = 1_760_000_000_000;

function stubFetch(
  respond: (request: { url: string; body: Record<string, unknown> }) => {
    status?: number;
    payload: unknown;
  },
) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: HeadersInit }> = [];
  const impl = (async (input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(input), body, headers: init.headers ?? {} });
    const { status = 200, payload } = respond({ url: String(input), body });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okResult = {
  version: 1,
  ok: true,
  exitCode: 0,
  output: "",
  truncated: false,
  durationMs: 12,
};

describe("Transitous script runner client", () => {
  it("sends a typed script with a freshly minted capability", async () => {
    const { impl, calls } = stubFetch(() => ({ payload: okResult }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });

    await run({ script: "generate-attribution" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://transitous-runner:4400/v1/run");
    expect(calls[0]?.body.run).toEqual({ script: "generate-attribution" });
    const capability = String(calls[0]?.body.capability);
    expect(
      verifyTransitousCapability(KEY, capability, { script: "generate-attribution" }, NOW).ok,
    ).toBe(true);
  });

  it("mints a distinct capability per run so none can be replayed", async () => {
    const { impl, calls } = stubFetch(() => ({ payload: okResult }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });

    await run({ script: "garbage-collect" });
    await run({ script: "garbage-collect" });

    expect(calls[0]?.body.capability).not.toBe(calls[1]?.body.capability);
  });

  it("raises the script's own output so failure parsing still works", async () => {
    const { impl } = stubFetch(() => ({
      payload: {
        ...okResult,
        ok: false,
        exitCode: 1,
        output: "Error: Could not fetch de-delfi: HTTP 500",
      },
    }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });

    await expect(run({ script: "fetch", feedPath: "feeds/de.json" })).rejects.toThrow(
      /Could not fetch de-delfi/,
    );
  });

  it("scrubs credentials out of the surfaced output", async () => {
    const { impl } = stubFetch(() => ({
      payload: {
        ...okResult,
        ok: false,
        exitCode: 1,
        output: "Error: Could not fetch de-delfi: https://example.test/gtfs?api_key=zzz-fixture",
      },
    }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });

    const error = await run({ script: "fetch", feedPath: "feeds/de.json" }).then(
      () => new Error("expected a rejection"),
      (thrown: Error) => thrown,
    );
    expect(error.message).not.toContain("zzz-fixture");
    // The parse anchor survives scrubbing.
    expect(error.message).toContain("Could not fetch de-delfi");
  });

  it("never echoes the capability when the runner rejects it", async () => {
    const { impl, calls } = stubFetch(() => ({
      status: 401,
      payload: { ok: false, error: "authorization" },
    }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });

    const error = await run({ script: "garbage-collect" }).then(
      () => new Error("expected a rejection"),
      (thrown: Error) => thrown,
    );
    expect(error).toBeInstanceOf(TransitousScriptError);
    expect(error.message).not.toContain(String(calls[0]?.body.capability));
  });

  it("rejects a response that does not match the result contract", async () => {
    const { impl } = stubFetch(() => ({ payload: { version: 1, ok: true } }));
    const run = createTransitousScriptRunner({
      baseUrl: "http://transitous-runner:4400",
      capabilityKey: KEY,
      fetchImpl: impl,
      now: () => NOW,
    });
    await expect(run({ script: "garbage-collect" })).rejects.toThrow(/unexpected response/i);
  });

  it("fails closed when the runner is not configured", async () => {
    const run = createTransitousScriptRunner({
      baseUrl: "",
      capabilityKey: KEY,
      fetchImpl: (() => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(run({ script: "garbage-collect" })).rejects.toThrow(/not configured/i);
  });

  it("does not mint a capability that outlives the run it authorizes", () => {
    // The client stamps `now`, so a queued run that sits for an hour presents an
    // already-expired token rather than a still-valid one.
    const run = { script: "garbage-collect" } as const;
    const capability = mintTransitousCapability(KEY, { now: NOW, run });
    expect(verifyTransitousCapability(KEY, capability, run, NOW + 60 * 60_000).ok).toBe(false);
  });
});
