import type {
  HttpClient,
  HttpResponse,
  ResponseOptions,
  UpstreamRuntime,
} from "@openmapx/integration-framework";
import {
  HealthCheckDocument,
  PlanTripDocument,
} from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnturClient } from "./client";
import { isEnturRequestError } from "./errors";

const signal = () => new AbortController().signal;
function fixture() {
  const calls: { url: string; body?: string; options: ResponseOptions }[] = [];
  let response: HttpResponse<string> = {
    status: 200,
    headers: {},
    body: '{"data":{"stopPlace":null}}',
  };
  const send = async (url: string, options: ResponseOptions, body?: string) => {
    calls.push({ url, options, body });
    return response;
  };
  const http = {
    getText: (url: string, options: ResponseOptions) => send(url, options),
    postText: (url: string, body: string, options: ResponseOptions) => send(url, options, body),
  } as HttpClient;
  const admissions: unknown[] = [];
  const cooldowns: unknown[] = [];
  const runtime = {
    admitSharedRequest: async (input: unknown) => {
      admissions.push(input);
      return { allowed: true, remaining: 1 };
    },
    deferSharedRequests: async (input: unknown) => {
      cooldowns.push(input);
    },
  } as unknown as UpstreamRuntime;
  const options = {
    http,
    upstreamRuntime: runtime,
    config: {},
    sourceIds: { journeyPlanner: "jp", vehicles: "v", nsr: "n", geocoder: "g" },
    contributors: { jp: [{ sourceId: "jp", name: "Entur", publisher: { name: "original" } }] },
    isSourceAllowed: async () => true,
  };
  return {
    calls,
    admissions,
    cooldowns,
    options,
    setResponse(value: HttpResponse<string>) {
      response = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});
describe("Entur host adapter", () => {
  it("uses injected text HTTP with the generated GraphQL request and bounded options", async () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    await expect(
      client.graphQl("journeyPlanner", HealthCheckDocument, { id: "NSR:StopPlace:1" }, signal()),
    ).resolves.toEqual({ stopPlace: null });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://api.entur.io/journey-planner/v3/graphql");
    expect(JSON.parse(f.calls[0]?.body ?? "")).toEqual({
      query: HealthCheckDocument.toString(),
      variables: { id: "NSR:StopPlace:1" },
    });
    expect(f.calls[0]?.options).toMatchObject({
      headers: { "ET-Client-Name": "openmapx-server", "Content-Type": "application/json" },
      maxBytes: 8 * 1024 * 1024,
      redirect: "error",
      contentTypes: ["application/json", "application/graphql-response+json"],
    });
    expect(f.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
    expect(f.calls[0]?.options.timeoutMs).toBeLessThanOrEqual(8000);
    await client.graphQl("vehicles", HealthCheckDocument, { id: "x" }, signal());
    expect(f.calls[1]?.url).toBe("https://api.entur.io/realtime/v2/vehicles/graphql");
    f.setResponse({ status: 200, headers: {}, body: '{"features":[]}' });
    await client.getJson("geocoder", "/autocomplete?text=Oslo", signal());
    await client.getJson("nsr", "/stop-places/NSR:StopPlace:1", signal());
    expect(f.calls[2]?.url).toBe("https://api.entur.io/geocoder/v1/autocomplete?text=Oslo");
    expect(f.calls[3]?.url).toBe(
      "https://api.entur.io/stop-places/v1/read/stop-places/NSR:StopPlace:1",
    );
  });
  it("normalizes immutable config and receipts; cache identity includes config/receipts deterministically", () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    const same = createEnturClient({
      ...f.options,
      config: {
        clientName: " openmapx-server ",
        nsrEndpoint: "https://api.entur.io/stop-places/v1/read/",
      },
    });
    expect(same.identity).toBe(client.identity);
    f.options.contributors.jp[0].publisher.name = "changed";
    f.options.sourceIds.journeyPlanner = "changed";
    expect(client.contributors.jp?.[0]?.publisher?.name).toBe("original");
    expect(Object.isFrozen(client.contributors.jp?.[0]?.publisher)).toBe(true);
    expect(Object.isFrozen(client.config)).toBe(true);
    expect(createEnturClient(f.options).identity).not.toBe(client.identity);
  });
  it.each([
    "http://private.test",
    "https://user:secret@private.test",
    "https://private.test/#secret",
    "https://private.test/#",
    "bad",
  ])("rejects unsafe endpoint %s without exposing it", (journeyPlannerEndpoint) => {
    const f = fixture();
    expect(() => createEnturClient({ ...f.options, config: { journeyPlannerEndpoint } })).toThrow(
      /configuration/i,
    );
  });
  it("rejects invalid client headers and absent families before HTTP", async () => {
    const f = fixture();
    expect(() =>
      createEnturClient({ ...f.options, config: { clientName: "bad\nheader" } }),
    ).toThrow();
    const client = createEnturClient({ ...f.options, sourceIds: { vehicles: "v" } });
    await expect(client.assertSourceAllowed("nsr")).rejects.toMatchObject({ kind: "source" });
    await expect(
      client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "source" });
    expect(f.calls).toHaveLength(0);
  });
  it("checks source policy before HTTP and again before publication", async () => {
    const f = fixture();
    const allowed = false;
    const client = createEnturClient({ ...f.options, isSourceAllowed: async () => allowed });
    await expect(client.getJson("nsr", "/x", signal())).rejects.toMatchObject({ kind: "policy" });
    expect(f.calls).toHaveLength(0);
    let checks = 0;
    const changed = createEnturClient({ ...f.options, isSourceAllowed: async () => ++checks <= 2 });
    await expect(changed.getJson("nsr", "/x", signal())).rejects.toMatchObject({ kind: "policy" });
    expect(f.calls).toHaveLength(1);
  });
  it("requires available shared admission for Journey Planner and never retries denials", async () => {
    for (const upstreamRuntime of [
      undefined,
      {} as UpstreamRuntime,
      {
        admitSharedRequest: async () => ({ allowed: false, reason: "quota", retryAfterMs: 1 }),
      } as unknown as UpstreamRuntime,
      {
        admitSharedRequest: async () => {
          throw new Error("secret");
        },
      } as unknown as UpstreamRuntime,
    ]) {
      const f = fixture();
      const client = createEnturClient({ ...f.options, upstreamRuntime });
      await expect(
        client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal()),
      ).rejects.toSatisfy(isEnturRequestError);
      expect(f.calls).toHaveLength(0);
    }
  });
  it("classifies the actual generated PlanTrip document and shares origin/client/family identity", async () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    // No variable parsing is needed for quota classification, and the result fixture is not validated as an operation result.
    await client.graphQl("journeyPlanner", PlanTripDocument, {} as never, signal());
    await client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    const [trip, other] = f.admissions as { scope: string; key: string; policy: unknown }[];
    expect(trip?.policy).toEqual({ id: "trip", limit: 500, durationMs: 60000, minIntervalMs: 7 });
    expect(other?.policy).toEqual({
      id: "other",
      limit: 1000,
      durationMs: 60000,
      minIntervalMs: 5,
    });
    expect(trip?.scope).toBe(other?.scope);
    expect(trip?.key).toBe(other?.key);
    const second = createEnturClient({
      ...f.options,
      sourceIds: { journeyPlanner: "other-receipt" },
      contributors: {},
      config: { journeyPlannerEndpoint: "https://api.entur.io/custom/graphql" },
    });
    await second.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    expect(f.admissions[2]).toMatchObject({ scope: trip?.scope, key: trip?.key });
    await createEnturClient({ ...f.options, config: { clientName: "another-client" } }).graphQl(
      "journeyPlanner",
      HealthCheckDocument,
      { id: "x" },
      signal(),
    );
    expect((f.admissions[3] as { key: string }).key).not.toBe(trip?.key);
  });
  it("bounds stalled admission and caller cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const upstreamRuntime = {
      admitSharedRequest: () => new Promise(() => {}),
      deferSharedRequests: async () => {},
    } as unknown as UpstreamRuntime;
    const client = createEnturClient({ ...f.options, upstreamRuntime });
    const work = client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    const assertion = expect(work).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(f.calls).toHaveLength(0);
    const controller = new AbortController();
    const cancelled = client.graphQl(
      "journeyPlanner",
      HealthCheckDocument,
      { id: "x" },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "abort" });
  });
  it("waits only for spacing and charges HTTP against the remaining overall deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let count = 0;
    f.options.upstreamRuntime.admitSharedRequest = async () =>
      ++count === 1
        ? { allowed: false, reason: "spacing", retryAfterMs: 7 }
        : { allowed: true, remaining: 1 };
    const work = createEnturClient(f.options).graphQl(
      "journeyPlanner",
      HealthCheckDocument,
      { id: "x" },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(7);
    await work;
    expect(f.calls[0]?.options.timeoutMs).toBe(7993);
  });
  it("handles non-JSON 429 with skew-safe maximum shared cooldown and no retry", async () => {
    const f = fixture();
    f.setResponse({
      status: 429,
      body: "private-secret",
      headers: {
        date: "Mon, 19 Oct 2026 10:00:00 GMT",
        "retry-after": "Mon, 19 Oct 2026 10:00:30 GMT",
        "rate-limit-expiry-time": "Mon, 19 Oct 2026 10:01:00 GMT",
      },
    });
    const client = createEnturClient(f.options);
    await expect(
      client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "http", status: 429 });
    expect(f.calls).toHaveLength(1);
    expect(f.cooldowns[0]).toMatchObject({ delayMs: 60000 });
    expect(JSON.stringify(f.cooldowns)).not.toContain("private-secret");
  });
  it("retains bounded observed cooldown for other APIs without runtime", async () => {
    const f = fixture();
    f.setResponse({ status: 429, body: "not JSON", headers: { "retry-after": "2" } });
    const client = createEnturClient({ ...f.options, upstreamRuntime: undefined });
    await expect(client.getJson("nsr", "/x", signal())).rejects.toMatchObject({ status: 429 });
    await expect(client.getJson("nsr", "/x", signal())).rejects.toMatchObject({ kind: "cooldown" });
    expect(f.calls).toHaveLength(1);
  });
  it.each([404, 503])("classifies HTTP %i without exposing bodies or URLs", async (status) => {
    const f = fixture();
    f.setResponse({ status, body: "private-secret", headers: {} });
    try {
      await createEnturClient(f.options).getJson("nsr", "/x?secret=private-secret", signal());
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ status, kind: "http" });
      expect(String(error)).not.toContain("private-secret");
    }
  });
  it("rejects GraphQL partial errors and malformed success JSON", async () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    f.setResponse({
      status: 200,
      body: '{"data":{},"errors":[{"message":"private-secret"}]}',
      headers: {},
    });
    await expect(
      client.graphQl("vehicles", HealthCheckDocument, { id: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "graphql" });
    f.setResponse({ status: 200, body: "private-secret", headers: {} });
    await expect(client.getJson("nsr", "/x", signal())).rejects.toMatchObject({ kind: "response" });
  });
  it("rejects path origin escapes", async () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    for (const path of [
      "//evil.test/x",
      "https://evil.test/x",
      "/../outside",
      "/x#fragment",
      "/x#",
      "/%2e%2e/outside",
    ]) {
      await expect(client.getJson("nsr", path, signal())).rejects.toMatchObject({ kind: "config" });
    }
    expect(f.calls).toHaveLength(0);
  });
  it.each(["quota", "cooldown", "store_unavailable"] as const)(
    "never retries shared %s denial",
    async (reason) => {
      const f = fixture();
      let attempts = 0;
      f.options.upstreamRuntime.admitSharedRequest = async () => {
        attempts++;
        return { allowed: false, reason, retryAfterMs: 1 };
      };
      await expect(
        createEnturClient(f.options).graphQl(
          "journeyPlanner",
          HealthCheckDocument,
          { id: "x" },
          signal(),
        ),
      ).rejects.toMatchObject({ kind: reason === "store_unavailable" ? "unavailable" : reason });
      expect(attempts).toBe(1);
      expect(f.calls).toHaveLength(0);
    },
  );
  it("cancels spacing wait and does not dispatch another admission or HTTP", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let attempts = 0;
    f.options.upstreamRuntime.admitSharedRequest = async () => {
      attempts++;
      return { allowed: false, reason: "spacing", retryAfterMs: 7000 };
    };
    const controller = new AbortController();
    const work = createEnturClient(f.options).graphQl(
      "journeyPlanner",
      HealthCheckDocument,
      { id: "x" },
      controller.signal,
    );
    const assertion = expect(work).rejects.toMatchObject({ kind: "abort" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempts).toBe(1);
    expect(f.calls).toHaveLength(0);
  });
  it("does not round safe shared provider cooldowns down to the local observation cap", async () => {
    const f = fixture();
    f.setResponse({ status: 429, body: "not JSON", headers: { "retry-after": "172800" } });
    await expect(createEnturClient(f.options).getJson("nsr", "/x", signal())).rejects.toMatchObject(
      { status: 429 },
    );
    expect(f.cooldowns[0]).toMatchObject({ delayMs: 172800000 });
  });
  it.each([
    [{ "retry-after": "5" }, 5000],
    [
      {
        date: "Mon, 19 Oct 2026 10:00:00 GMT",
        "retry-after": "2",
        "rate-limit-expiry-time": "1792404010",
      },
      10000,
    ],
    [
      {
        date: "Mon, 19 Oct 2026 10:00:00 GMT",
        "retry-after": "3",
        "rate-limit-expiry-time": "unsafe",
      },
      3000,
    ],
    [
      { "retry-after": "99999999999999999999999999999", "rate-limit-expiry-time": "unsafe" },
      undefined,
    ],
  ] as const)("selects only safe provider cooldowns %j", async (headers, expected) => {
    const f = fixture();
    f.setResponse({ status: 429, body: "x", headers });
    await expect(createEnturClient(f.options).getJson("nsr", "/x", signal())).rejects.toMatchObject(
      { status: 429 },
    );
    if (expected === undefined) expect(f.cooldowns).toHaveLength(0);
    else expect(f.cooldowns[0]).toMatchObject({ delayMs: expected });
  });
  it("retains the caller cancellation reason as the error cause", async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new Error("caller cancellation");
    controller.abort(reason);
    await expect(
      createEnturClient(f.options).getJson("nsr", "/x", controller.signal),
    ).rejects.toMatchObject({ kind: "abort", cause: reason });
    expect(f.calls).toHaveLength(0);
  });
  it("rejects an incomplete or unavailable supplied runtime for other API families", async () => {
    for (const upstreamRuntime of [
      {} as UpstreamRuntime,
      {
        ...fixture().options.upstreamRuntime,
        admitSharedRequest: async () => ({
          allowed: false,
          reason: "store_unavailable",
          retryAfterMs: null,
        }),
      } as UpstreamRuntime,
    ]) {
      const f = fixture();
      await expect(
        createEnturClient({ ...f.options, upstreamRuntime }).getJson("nsr", "/x", signal()),
      ).rejects.toMatchObject({ kind: "unavailable" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("keeps custom endpoint paths and configured query values in wire requests", async () => {
    const f = fixture();
    const client = createEnturClient({
      ...f.options,
      config: {
        journeyPlannerEndpoint: "https://custom.test/graphql/?mode=custom",
        nsrEndpoint: "https://custom.test/read/?mode=custom",
      },
    });
    await client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    await client.getJson("nsr", "/stop-places/x?limit=3", signal());
    expect(f.calls[0]?.url).toBe("https://custom.test/graphql/?mode=custom");
    expect(new URL(f.calls[1]?.url ?? "").searchParams.get("mode")).toBe("custom");
    expect(new URL(f.calls[1]?.url ?? "").searchParams.get("limit")).toBe("3");
  });
  it("separates shared gate identities by origin and family without inventing non-JP quotas", async () => {
    const f = fixture();
    const client = createEnturClient(f.options);
    await client.graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    await client.graphQl("vehicles", HealthCheckDocument, { id: "x" }, signal());
    await createEnturClient({
      ...f.options,
      config: { journeyPlannerEndpoint: "https://custom.test/graphql" },
    }).graphQl("journeyPlanner", HealthCheckDocument, { id: "x" }, signal());
    const keys = f.admissions.map((entry) => (entry as { key: string }).key);
    expect(new Set(keys).size).toBe(3);
    expect(f.admissions[1]).toMatchObject({ policy: undefined });
  });
  it.each([
    "OpenMapX-server",
    "company app",
    "server",
    "company_app",
    "company-application secret",
  ])("rejects ET client identity outside lowercase company-application form: %s", (clientName) => {
    const f = fixture();
    expect(() => createEnturClient({ ...f.options, config: { clientName } })).toThrow(
      /configuration/i,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("uses client time for absolute cooldown only when response Date is absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
    const f = fixture();
    f.setResponse({
      status: 429,
      body: "x",
      headers: { "retry-after": "Mon, 19 Oct 2026 10:00:10 GMT" },
    });
    await expect(createEnturClient(f.options).getJson("nsr", "/x", signal())).rejects.toMatchObject(
      { status: 429 },
    );
    expect(f.cooldowns[0]).toMatchObject({ delayMs: 10000 });
  });
  it("caps only local observed cooldown at 24 hours without adding a quota counter", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setResponse({ status: 429, body: "x", headers: { "retry-after": "172800" } });
    const instance = createEnturClient({ ...f.options, upstreamRuntime: undefined });
    await expect(instance.getJson("nsr", "/x", signal())).rejects.toMatchObject({ status: 429 });
    await expect(instance.getJson("nsr", "/x", signal())).rejects.toMatchObject({
      kind: "cooldown",
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await expect(instance.getJson("nsr", "/x", signal())).rejects.toMatchObject({ status: 429 });
    expect(f.calls).toHaveLength(2);
  });
  it("bounds a never-settling public policy assertion to eight seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const instance = createEnturClient({
      ...f.options,
      isSourceAllowed: () => new Promise(() => {}),
    });
    let result: unknown;
    const finished = instance.assertSourceAllowed("nsr").then(
      () => {
        result = "published";
      },
      (error: unknown) => {
        result = error;
      },
    );
    await vi.advanceTimersByTimeAsync(8001);
    expect(result).toMatchObject({ kind: "timeout" });
    await finished;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
  it("lets a public policy assertion caller retire promptly and preserves its abort cause", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const instance = createEnturClient({
      ...f.options,
      isSourceAllowed: () => new Promise(() => {}),
    });
    let result: unknown;
    const finished = instance.assertSourceAllowed("nsr", controller.signal).then(
      () => {
        result = "published";
      },
      (error: unknown) => {
        result = error;
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    const reason = new Error("retired caller");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ kind: "abort", cause: reason });
    await finished;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
  it("keeps internal policy checks within the original operation deadline without leftover timers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let checks = 0;
    const instance = createEnturClient({
      ...f.options,
      isSourceAllowed: () =>
        ++checks === 1
          ? new Promise((resolve) => setTimeout(() => resolve(true), 5000))
          : new Promise(() => {}),
    });
    const work = instance.getJson("nsr", "/x", signal());
    const assertion = expect(work).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(checks).toBe(2);
    expect(f.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
