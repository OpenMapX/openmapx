import type { CacheClient, LoadedIntegration } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { DirectionsResult, RoutingProvider } from "@openmapx/provider-kit/routing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

vi.mock("../closures.js", async (importOriginal) => {
  const { withStubbedClosureExclusions } = await import("./support/closure-exclusion-stub.js");
  return withStubbedClosureExclusions(await importOriginal<typeof import("../closures.js")>());
});

const route = {
  distance: 1_000,
  duration: 600,
  geometry: [
    [0, 0],
    [0.004, 0],
  ] as [number, number][],
  legs: [],
  steps: [],
  mode: "walking" as const,
};

function engine(id: string): RoutingProvider {
  const answer = async (waypoints: [number, number][]): Promise<DirectionsResult> => ({
    waypoints,
    routes: [route],
    activeRouteIndex: 0,
  });
  return { id, supportedModes: ["walking"], getRoute: answer, optimizeRoute: answer };
}

function routingIntegration(id: string, provider: RoutingProvider): LoadedIntegration {
  return {
    id,
    manifest: { id, domains: ["routing"] },
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["routing", [provider]]]),
    strings: {},
    loadState: "loaded",
    shutdownHandlers: [],
  } as LoadedIntegration;
}

/** A routing integration over two engines whose order the test changes. */
function environment() {
  const keys: string[] = [];
  const cache = {
    withCache: vi.fn(async (key: string, _ttl: number, factory: () => Promise<unknown>) => {
      keys.push(key);
      return factory();
    }),
  } as unknown as CacheClient;
  const providerOrder: Record<string, readonly string[]> = {
    routing: ["routing-a", "routing-b"],
  };
  const ctx = createMockIntegrationContext({ cache, providerOrder });
  const integrations = [
    routingIntegration("routing-a", engine("a")),
    routingIntegration("routing-b", engine("b")),
  ];
  ctx.getIntegrationsByDomain = (domain) => (domain === "routing" ? integrations : []);
  setup(ctx);

  const call = async (method: string, path: string, request: object) => {
    const registered = ctx.registered.routes.find(
      (entry) => entry.method === method && entry.path === path,
    );
    if (!registered) throw new Error(`${method} ${path} was not registered`);
    const sent = { status: 200 };
    const reply = {
      status(code: number) {
        sent.status = code;
        return reply;
      },
      header: () => reply,
      send: () => reply,
    };
    await registered.handler(request as never, reply as never);
    expect(sent.status).toBe(200);
    return keys.at(-1);
  };
  return {
    call,
    setOrder(order: readonly string[]) {
      providerOrder.routing = order;
    },
  };
}

describe.each([
  {
    name: "directions",
    method: "GET",
    path: "/directions",
    request: { query: { waypoints: "0,0;0.004,0", mode: "walking" } },
  },
  {
    name: "optimize",
    method: "GET",
    path: "/directions/optimize",
    request: { query: { waypoints: "0,0;0.002,0;0.004,0", mode: "walking" } },
  },
  {
    name: "schedule",
    method: "POST",
    path: "/directions/schedule",
    request: {
      body: {
        waypoints: [
          [0, 0],
          [0.004, 0],
        ],
        mode: "walking",
      },
    },
  },
])("$name cache key and the routing engine order", ({ method, path, request }) => {
  it("changes when the operator reorders the engines", async () => {
    const env = environment();
    const before = await env.call(method, path, request);
    env.setOrder(["routing-b", "routing-a"]);
    const after = await env.call(method, path, request);
    expect(before).toEqual(expect.any(String));
    expect(after).not.toBe(before);
  });

  it("stays the same when the served order does not change", async () => {
    const env = environment();
    const before = await env.call(method, path, request);
    env.setOrder(["routing-a", "ghost", "routing-b", "routing-a"]);
    const after = await env.call(method, path, request);
    expect(before).toEqual(expect.any(String));
    expect(after).toBe(before);
  });
});
