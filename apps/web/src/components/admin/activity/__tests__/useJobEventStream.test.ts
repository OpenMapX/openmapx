// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test";
import { type JobDetailData, reduceJobEvent, useJobEventStream } from "../useJobEventStream";

function job(overrides: Partial<JobDetailData> = {}): JobDetailData {
  return {
    source: "application",
    id: "job-1",
    type: "data.operation",
    status: "running",
    payload: null,
    result: null,
    error: null,
    progress: 10,
    createdBy: null,
    createdAt: "2026-09-06T08:00:00.000Z",
    startedAt: "2026-09-06T08:00:01.000Z",
    finishedAt: null,
    cancelable: true,
    logs: [],
    stages: [],
    ...overrides,
  };
}

describe("reduceJobEvent", () => {
  it("replaces state on snapshot and ignores other events without a base", () => {
    expect(reduceJobEvent(null, "log", { id: "x" })).toBeNull();
    expect(reduceJobEvent(null, "snapshot", { job: job() })?.id).toBe("job-1");
  });

  it("appends logs in sequence order and dedupes by id", () => {
    const base = job({ logs: [{ id: "b", seq: 1, stream: "stdout", line: "b", createdAt: "" }] });
    const withA = reduceJobEvent(base, "log", {
      id: "a",
      seq: 0,
      stream: "stdout",
      line: "a",
      createdAt: "",
    });
    expect(withA?.logs.map((log) => log.id)).toEqual(["a", "b"]);
    const again = reduceJobEvent(withA, "log", {
      id: "a",
      seq: 0,
      stream: "stdout",
      line: "a",
      createdAt: "",
    });
    expect(again).toBe(withA);
  });

  it("merges status fields and keeps untouched ones", () => {
    const next = reduceJobEvent(job(), "status", {
      status: "success",
      progress: 100,
      finishedAt: "2026-09-06T08:05:00.000Z",
    });
    expect(next).toMatchObject({
      status: "success",
      progress: 100,
      finishedAt: "2026-09-06T08:05:00.000Z",
      startedAt: "2026-09-06T08:00:01.000Z",
      cancelable: false,
    });
    expect(reduceJobEvent(job(), "progress", { progress: 55 })?.progress).toBe(55);
  });
});

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
  fail() {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event("error"));
  }
}

describe("useJobEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes live, applies events, and closes on end", () => {
    const { result } = renderHook(() => useJobEventStream("http://api.test/events"));
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("no EventSource created");
    expect(source.init?.withCredentials).toBe(true);
    expect(result.current.connection).toBe("connecting");

    act(() => source.open());
    expect(result.current.connection).toBe("live");

    act(() => source.emit("snapshot", { job: job() }));
    act(() =>
      source.emit("log", { id: "l1", seq: 0, stream: "stdout", line: "hello", createdAt: "" }),
    );
    act(() => source.emit("status", { status: "success", progress: 100 }));
    expect(result.current.data?.logs.map((log) => log.line)).toEqual(["hello"]);
    expect(result.current.data?.status).toBe("success");

    act(() => source.emit("end", { status: "success" }));
    expect(result.current.connection).toBe("closed");
    expect(source.closed).toBe(true);
  });

  it("falls back to polling after repeated transport errors", () => {
    const { result } = renderHook(() => useJobEventStream("http://api.test/events"));
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("no EventSource created");
    act(() => source.fail());
    expect(result.current.connection).toBe("reconnecting");
    act(() => source.fail());
    act(() => source.fail());
    expect(result.current.connection).toBe("polling");
    expect(source.closed).toBe(true);
  });

  it("reports polling when there is no url or no EventSource", () => {
    const { result: noUrl } = renderHook(() => useJobEventStream(null));
    expect(noUrl.current.connection).toBe("polling");
    vi.stubGlobal("EventSource", undefined);
    const { result } = renderHook(() => useJobEventStream("http://api.test/events"));
    expect(result.current.connection).toBe("polling");
  });
});
