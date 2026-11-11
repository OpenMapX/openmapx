import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  classifyProviderFailure,
  ProviderCancelledError,
  ProviderPayloadError,
  ProviderRetiredError,
  ProviderTimeoutError,
  parseProviderPayload,
  parseProviderRecords,
  raceCallerAbort,
  runWithProviderDeadline,
} from "../provider-execution";

describe("provider execution", () => {
  it("actively aborts provider work at the deadline", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const work = runWithProviderDeadline(
      ({ signal }) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 1_200 },
    );
    const rejection = expect(work).rejects.toBeInstanceOf(ProviderTimeoutError);

    await vi.advanceTimersByTimeAsync(1_200);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("propagates caller cancellation distinctly from a timeout", async () => {
    const controller = new AbortController();
    const work = runWithProviderDeadline(() => new Promise(() => {}), {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(work).rejects.toBeInstanceOf(ProviderCancelledError);
  });
});

describe("classifyProviderFailure", () => {
  function aborted(reason?: unknown): AbortSignal {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  }

  it("maps a caller abort to caller_cancelled", () => {
    expect(classifyProviderFailure(new ProviderCancelledError())).toBe("caller_cancelled");
    const signal = aborted();
    expect(classifyProviderFailure(signal.reason, signal)).toBe("caller_cancelled");
  });

  it("follows the cause chain of a wrapped abort", () => {
    const signal = aborted();
    const wrapped = new TypeError("fetch failed", { cause: signal.reason });
    expect(classifyProviderFailure(wrapped, signal)).toBe("caller_cancelled");
    const named = Object.assign(new Error("request aborted"), { name: "AbortError" });
    expect(classifyProviderFailure(named, signal)).toBe("caller_cancelled");
  });

  it("keeps an upstream failure that settled before the caller aborted", () => {
    const signal = aborted();
    const upstream = Object.assign(new Error("HTTP 503"), { status: 503 });
    expect(classifyProviderFailure(upstream, signal)).toBe("upstream_5xx");
    expect(classifyProviderFailure(new Error("socket hang up"), signal)).toBe("connection");
  });

  it("reports deadlines as timeouts, not cancellations", () => {
    expect(classifyProviderFailure(new ProviderTimeoutError())).toBe("timeout");
    expect(classifyProviderFailure(new ProviderTimeoutError(), aborted())).toBe("timeout");
    const deadline = aborted(new DOMException("signal timed out", "TimeoutError"));
    expect(classifyProviderFailure(deadline.reason, deadline)).toBe("timeout");
    const timeoutReason = aborted(new ProviderTimeoutError());
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyProviderFailure(abort, timeoutReason)).toBe("timeout");
  });

  it("treats an abort the caller did not request as the provider's own deadline", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyProviderFailure(abort)).toBe("timeout");
    expect(classifyProviderFailure(abort, new AbortController().signal)).toBe("timeout");
  });

  it("classifies HTTP statuses and structured codes", () => {
    const status = (value: number) => Object.assign(new Error(`HTTP ${value}`), { status: value });
    expect(classifyProviderFailure(status(401))).toBe("auth");
    expect(classifyProviderFailure(status(403))).toBe("auth");
    expect(classifyProviderFailure(status(429))).toBe("quota");
    expect(classifyProviderFailure(status(502))).toBe("upstream_5xx");
    expect(classifyProviderFailure(Object.assign(new Error("bad"), { statusCode: 500 }))).toBe(
      "upstream_5xx",
    );
    const code = (value: string) => Object.assign(new Error(value), { code: value });
    expect(classifyProviderFailure(code("quota_exhausted"))).toBe("quota");
    expect(classifyProviderFailure(code("invalid_response"))).toBe("invalid_payload");
    expect(classifyProviderFailure(code("invalid_request"))).toBe("input");
    expect(classifyProviderFailure(code("unauthorized"))).toBe("auth");
    expect(classifyProviderFailure(code("forbidden"))).toBe("auth");
    expect(classifyProviderFailure(code("ETIMEDOUT"))).toBe("timeout");
    expect(classifyProviderFailure(new ProviderPayloadError("missing departures"))).toBe(
      "invalid_payload",
    );
    expect(classifyProviderFailure(Object.assign(new Error("parse"), { name: "ZodError" }))).toBe(
      "invalid_payload",
    );
    expect(classifyProviderFailure("boom")).toBe("connection");
  });
});

describe("classifyProviderFailure through causes", () => {
  it("reads a status or code from the cause of a wrapped upstream error", () => {
    const upstream = Object.assign(new Error("HTTP 401"), { status: 401 });
    expect(
      classifyProviderFailure(new Error("TfL stop search unavailable", { cause: upstream })),
    ).toBe("auth");
    const busy = Object.assign(new Error("HTTP 503"), { status: 503 });
    expect(classifyProviderFailure(new Error("iRail unavailable", { cause: busy }))).toBe(
      "upstream_5xx",
    );
  });
});

describe("parseProviderPayload", () => {
  const schema = z.object({ items: z.array(z.unknown()) });

  it("returns the parsed fields", () => {
    expect(parseProviderPayload(schema, { items: [1], extra: true }, "Feed")).toEqual({
      items: [1],
    });
  });

  it("throws an invalid-payload error naming the first bad field", () => {
    const parse = () => parseProviderPayload(schema, { items: null }, "Feed departures");
    expect(parse).toThrow(ProviderPayloadError);
    expect(parse).toThrow("Feed departures: unexpected response shape at items");
    try {
      parse();
    } catch (error) {
      expect(classifyProviderFailure(error)).toBe("invalid_payload");
    }
  });
});

describe("parseProviderRecords", () => {
  const stop = z.object({ id: z.string(), lat: z.number() });

  it("keeps valid records and drops malformed neighbours", () => {
    expect(
      parseProviderRecords(
        stop,
        [{ id: "a", lat: 1 }, { id: "b" }, null, { id: "c", lat: 2 }],
        "Stops",
      ),
    ).toEqual([
      { id: "a", lat: 1 },
      { id: "c", lat: 2 },
    ]);
  });

  it("accepts an empty list as a valid empty result", () => {
    expect(parseProviderRecords(stop, [], "Stops")).toEqual([]);
  });

  it("rejects a non-empty list without one usable record", () => {
    expect(() => parseProviderRecords(stop, [{ id: "a" }, {}], "Stops")).toThrow(
      "Stops: no usable records at lat",
    );
  });
});

describe("classifyProviderFailure for upstream 4xx and host retirement", () => {
  it("counts generic upstream 4xx responses so a retired endpoint can open the circuit", () => {
    for (const value of [400, 404, 410, 422]) {
      const error = Object.assign(new Error(`HTTP ${value}`), { status: value });
      expect(classifyProviderFailure(error)).toBe("connection");
      expect(classifyProviderFailure(new Error("wrapped", { cause: error }))).toBe("connection");
    }
    for (const code of ["NOT_FOUND", "INVALID_REQUEST"])
      expect(classifyProviderFailure(Object.assign(new Error(code), { code }))).toBe("connection");
  });

  it("keeps only adapter-rejected caller input as non-counted input", () => {
    const input = Object.assign(new Error("invalid planning time"), { code: "invalid_request" });
    expect(classifyProviderFailure(input)).toBe("input");
  });

  it("treats the host retiring a generation as a cancellation, not a provider failure", () => {
    const generation = new AbortController();
    generation.abort(new ProviderRetiredError());
    expect(classifyProviderFailure(generation.signal.reason)).toBe("caller_cancelled");
    const wrapped = new TypeError("fetch failed", { cause: generation.signal.reason });
    expect(classifyProviderFailure(wrapped)).toBe("caller_cancelled");
    expect(classifyProviderFailure(wrapped, new AbortController().signal)).toBe("caller_cancelled");
  });

  it("reads cancellation and deadline kinds that adapter clients convert aborts into", () => {
    const kind = (value: string) => Object.assign(new Error(value), { kind: value });
    expect(classifyProviderFailure(kind("cancelled"))).toBe("caller_cancelled");
    expect(classifyProviderFailure(kind("timeout"))).toBe("timeout");
    expect(classifyProviderFailure(kind("payload"))).toBe("connection");
  });
});

describe("raceCallerAbort", () => {
  it("settles with a cancellation as soon as the caller aborts", async () => {
    const controller = new AbortController();
    const work = raceCallerAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(work).rejects.toBeInstanceOf(ProviderCancelledError);
  });

  it("keeps the provider's own failure when it settles first", async () => {
    const controller = new AbortController();
    const upstream = Object.assign(new Error("HTTP 500"), { status: 500 });
    const work = raceCallerAbort(Promise.reject(upstream), controller.signal);
    await expect(work).rejects.toBe(upstream);
    controller.abort();
  });

  it("passes the result through without a signal", async () => {
    await expect(raceCallerAbort(Promise.resolve(3))).resolves.toBe(3);
  });
});
