// @vitest-environment jsdom

import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@/test";
import { reduceJobEvent, useJobEventStream } from "../useJobEventStream";
import { FakeEventSource, job, log, timestamp } from "./fixtures";

const client = createApiClient({ baseUrl: "http://api.test/gateway", credentials: "include" });

async function latestSource() {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("Missing native stream");
  return source;
}

describe("reduceJobEvent", () => {
  it("accepts a complete snapshot and rejects malformed state writes", () => {
    expect(reduceJobEvent(null, "snapshot", { job: job() })).toEqual(job());
    const base = job();
    expect(reduceJobEvent(base, "snapshot", { job: { id: "invalid" } })).toBe(base);
    expect(reduceJobEvent(base, "progress", { type: "progress", progress: "55" })).toBe(base);
    expect(reduceJobEvent(base, "status", { type: "status", status: "invented" })).toBe(base);
    expect(reduceJobEvent(null, "log", { type: "log", ...log("a", 0) })).toBeNull();
  });
  it("attaches the current job ID to sorted deduped live logs without the event type", () => {
    const base = job({ logs: [log("b", 1)] });
    const { jobId: _, ...wire } = log("a", 0);
    const next = reduceJobEvent(base, "log", { type: "log", ...wire });
    expect(next?.logs).toEqual([log("a", 0), log("b", 1)]);
    expect(reduceJobEvent(next, "log", { type: "log", ...wire })).toBe(next);
  });
  it("merges valid status/progress and terminal end while retaining untouched fields", () => {
    const next = reduceJobEvent(job(), "status", {
      type: "status",
      status: "success",
      progress: 100,
      finishedAt: timestamp,
      result: ["complete", { nested: true }],
    });
    expect(next).toMatchObject({
      status: "success",
      progress: 100,
      startedAt: timestamp,
      finishedAt: timestamp,
      cancelable: false,
      result: ["complete", { nested: true }],
    });
    expect(reduceJobEvent(job(), "progress", { type: "progress", progress: 55 })?.progress).toBe(
      55,
    );
    expect(reduceJobEvent(job(), "end", { status: "canceled" })).toMatchObject({
      status: "canceled",
      cancelable: false,
    });
  });
});

describe("useJobEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Unexpected HTTP acquisition");
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the generated encoded target and credentials, applies events, then closes on valid end", async () => {
    const { result } = renderHook(() => useJobEventStream(client, "job /1"));
    const source = await latestSource();
    expect(source.url).toBe("http://api.test/api/admin/jobs/job%20%2F1/events?source=application");
    expect(source.init?.withCredentials).toBe(true);
    act(() => source.open());
    expect(result.current.connection).toBe("live");
    act(() => source.emit("snapshot", { job: job({ id: "job /1" }) }));
    const { jobId: _, ...wire } = log("hello", 0);
    act(() => source.emit("log", { type: "log", ...wire }));
    act(() => source.emit("progress", { type: "progress", progress: 80 }));
    act(() => source.emit("status", { type: "status", status: "success", progress: 100 }));
    expect(result.current.data?.logs[0]).toMatchObject({ jobId: "job /1", line: "hello" });
    expect(result.current.data?.status).toBe("success");
    act(() => source.emit("end", { status: "success" }));
    expect(result.current.connection).toBe("closed");
    expect(source.closed).toBe(true);
  });

  it.each<[string, unknown]>([
    ["snapshot", { job: { id: "job-1" } }],
    ["snapshot", { job: job({ id: "another-job" }) }],
    ["status", { type: "status", status: "unknown" }],
    ["progress", { type: "progress", progress: "ten" }],
    ["log", { type: "log", id: "bad" }],
    ["end", { status: "running" }],
    ["overflow", { reason: "unknown" }],
  ])("falls back without applying malformed %s frames", async (name, frame) => {
    const { result } = renderHook(() => useJobEventStream(client, "job-1"));
    const source = await latestSource();
    act(() => source.emit("snapshot", { job: job() }));
    act(() => source.emit(name, frame));
    expect(result.current.connection).toBe("polling");
    expect(result.current.data).toBeNull();
    expect(source.closed).toBe(true);
    act(() => source.emit("end", { status: "success" }));
    act(() => source.open());
    expect(result.current.connection).toBe("polling");
  });

  it("falls back on malformed JSON and reconnects on valid overflow", async () => {
    const { result } = renderHook(() => useJobEventStream(client, "job-1"));
    const source = await latestSource();
    act(() => source.emit("overflow", { reason: "slow consumer" }));
    expect(result.current.connection).toBe("reconnecting");
    act(() => source.dispatchEvent(new MessageEvent("status", { data: "{" })));
    expect(result.current.connection).toBe("polling");
    expect(source.closed).toBe(true);
  });

  it("falls back after consecutive errors, resetting the counter on open", async () => {
    const { result } = renderHook(() => useJobEventStream(client, "job-1"));
    const source = await latestSource();
    act(() => {
      source.fail();
      source.fail();
      source.open();
      source.fail();
      source.fail();
    });
    expect(result.current.connection).toBe("reconnecting");
    act(() => source.fail());
    expect(result.current.connection).toBe("polling");
    expect(source.closed).toBe(true);
  });

  it("closes superseded streams and ignores already queued stale callbacks", async () => {
    const captured: EventListener[] = [];
    const original = FakeEventSource.prototype.addEventListener;
    vi.spyOn(FakeEventSource.prototype, "addEventListener").mockImplementation(function (
      this: FakeEventSource,
      ...args: unknown[]
    ) {
      const [name, listener, options] = args as Parameters<EventTarget["addEventListener"]>;
      if (typeof listener === "function") captured.push(listener);
      return original.call(this, name, listener, options);
    });
    const { result, rerender } = renderHook(({ id }) => useJobEventStream(client, id), {
      initialProps: { id: "old" },
    });
    const old = await latestSource();
    const stale = [...captured];
    rerender({ id: "new" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(old.closed).toBe(true);
    act(() => {
      for (const listener of stale)
        listener(
          new MessageEvent("snapshot", { data: JSON.stringify({ job: job({ id: "old" }) }) }),
        );
    });
    expect(result.current.data).toBeNull();
    expect(result.current.connection).toBe("connecting");
  });

  it("does not construct EventSource after pending target resolution is superseded or unmounted", async () => {
    let resolve!: (target: sdk.AdminEventStreamTarget) => void;
    const originalTarget = sdk.streamAdminActivityJobEvents;
    let pending = true;
    vi.spyOn(sdk, "streamAdminActivityJobEvents").mockImplementation((...args: unknown[]) => {
      if (pending) {
        pending = false;
        return new Promise<sdk.AdminEventStreamTarget>((done) => {
          resolve = done;
        });
      }
      return originalTarget(...(args as Parameters<typeof originalTarget>));
    });
    const { rerender, unmount } = renderHook(({ id }) => useJobEventStream(client, id), {
      initialProps: { id: "old" },
    });
    rerender({ id: "new" });
    await latestSource();
    await act(async () => resolve({ url: "http://api.test/old", withCredentials: true }));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toContain("/new/events");
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("does not construct a stream when unmounted during target resolution", async () => {
    let resolve!: (target: sdk.AdminEventStreamTarget) => void;
    vi.spyOn(sdk, "streamAdminActivityJobEvents").mockImplementation(
      () =>
        new Promise<sdk.AdminEventStreamTarget>((done) => {
          resolve = done;
        }),
    );
    const { unmount } = renderHook(() => useJobEventStream(client, "pending"));
    unmount();
    await act(async () => resolve({ url: "http://api.test/pending", withCredentials: true }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("keeps a live native stream open beyond finite JSON deadlines", async () => {
    const { result, unmount } = renderHook(() => useJobEventStream(client, "job-1"));
    const source = await latestSource();
    vi.useFakeTimers();
    try {
      act(() => source.open());
      act(() => vi.advanceTimersByTime(60_000));
      expect(result.current.connection).toBe("live");
      expect(source.closed).toBe(false);
      unmount();
      expect(source.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back if target construction rejects, no job is selected or EventSource is absent", async () => {
    const badClient = createApiClient({ baseUrl: "http://api.test", credentials: "omit" });
    const { result } = renderHook(() => useJobEventStream(badClient, "job-1"));
    await waitFor(() => expect(result.current.connection).toBe("polling"));
    const { result: noJob } = renderHook(() => useJobEventStream(client, null));
    expect(noJob.current.connection).toBe("polling");
    vi.stubGlobal("EventSource", undefined);
    const { result: noSource } = renderHook(() => useJobEventStream(client, "job-1"));
    expect(noSource.current.connection).toBe("polling");
  });
});
