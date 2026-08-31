import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../index.js";
import type { DirectionsResult, RoutingProvider, TravelMode } from "../../types.js";

export interface RoutingProviderFixture {
  integrationId: string;
  providerId: string;
  getRoute: RoutingProvider["getRoute"];
  optimizeRoute?: RoutingProvider["optimizeRoute"];
  getMatrix?: RoutingProvider["getMatrix"];
  priority?: number;
  supportsExclusions?: boolean;
}

export interface RoutingTestRequest {
  query?: Record<string, string>;
  body?: Record<string, unknown> | null;
}

export interface RoutingTestReply {
  status(code: number): RoutingTestReply;
  send(body?: unknown): void;
  header(name: string, value: string): void;
  code: number;
  body: unknown;
}

export type RoutingTestHandler = (
  request: RoutingTestRequest,
  reply: RoutingTestReply,
) => Promise<void>;

export function createRoutingTestReply(): RoutingTestReply {
  const reply: RoutingTestReply = {
    code: 200,
    body: undefined,
    status(code) {
      reply.code = code;
      return reply;
    },
    send(body) {
      reply.body = body;
    },
    header: vi.fn(),
  };
  return reply;
}

export function createDirectionsResult(routes: DirectionsResult["routes"] = []): DirectionsResult {
  return { waypoints: [], routes, activeRouteIndex: 0 };
}

interface RoutingHandlerEnvironmentOptions {
  routingProviders: RoutingProviderFixture[];
  closurePoints?: [number, number][];
  additionalIntegrations?: Record<string, unknown[]>;
  metricsRecorder?: IntegrationContext["metricsRecorder"];
}

export function createRoutingHandlerEnvironment(options: RoutingHandlerEnvironmentOptions): {
  getHandler(path: string): RoutingTestHandler;
} {
  const handlers = new Map<string, RoutingTestHandler>();
  const closureEvents = (options.closurePoints ?? []).map((coordinates, index) => ({
    id: `closure:${index}`,
    source: "test",
    provider: "road-conditions-stub",
    type: "road_closure",
    severity: "high",
    geometry: { type: "Point", coordinates },
    headline: `Closure ${index}`,
  }));

  const context = {
    getIntegrationsByDomain(domain: string) {
      if (domain === "routing") {
        return options.routingProviders.map((fixture) => ({
          id: fixture.integrationId,
          providers: new Map<string, RoutingProvider[]>([
            [
              "routing",
              [
                {
                  id: fixture.providerId,
                  supportedModes: ["driving", "walking", "cycling"] as TravelMode[],
                  priority: fixture.priority,
                  supportsExclusions: fixture.supportsExclusions,
                  getRoute: fixture.getRoute,
                  ...(fixture.optimizeRoute ? { optimizeRoute: fixture.optimizeRoute } : {}),
                  ...(fixture.getMatrix ? { getMatrix: fixture.getMatrix } : {}),
                },
              ],
            ],
          ]),
        }));
      }
      if (domain === "road-conditions" && closureEvents.length > 0) {
        return [
          {
            id: "road-conditions-stub",
            providers: new Map<string, unknown[]>([
              [
                "road-conditions",
                [
                  {
                    id: "road-conditions-stub",
                    getEvents: vi.fn().mockResolvedValue(closureEvents),
                  },
                ],
              ],
            ]),
          },
        ];
      }
      return options.additionalIntegrations?.[domain] ?? [];
    },
    getDisallowedSourceIds: async () => new Set<string>(),
    registerRoute(_method: string, path: string, handler: RoutingTestHandler) {
      handlers.set(path, handler);
    },
    cache: {
      withCache: vi.fn(async (_key: string, _ttl: number, factory: () => Promise<unknown>) =>
        factory(),
      ),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...(options.metricsRecorder ? { metricsRecorder: options.metricsRecorder } : {}),
  } as unknown as IntegrationContext;

  setup(context);

  return {
    getHandler(path) {
      const handler = handlers.get(path);
      if (!handler) throw new Error(`${path} handler was not registered`);
      return handler;
    },
  };
}

export interface ClosureRoutingContractOptions {
  name: string;
  path: "/directions" | "/directions/optimize";
  operation: "directions" | "optimize";
  waypointsQuery: string;
}

const CLOSURE_POINT: [number, number] = [0.15, 51.15];

function operationFixture(operation: ClosureRoutingContractOptions["operation"]) {
  const operationSpy = vi.fn(async () => createDirectionsResult());
  return {
    operationSpy,
    provider: {
      integrationId: "routing-closure-aware",
      providerId: "engine-b",
      getRoute:
        operation === "directions" ? operationSpy : vi.fn(async () => createDirectionsResult()),
      ...(operation === "optimize" ? { optimizeRoute: operationSpy } : {}),
      priority: 10,
      supportsExclusions: true,
    } satisfies RoutingProviderFixture,
  };
}

export function closureRoutingContract(options: ClosureRoutingContractOptions): void {
  describe(`${options.name} closure-routing contract`, () => {
    it("forwards active closure geometry to an exclusion-capable provider", async () => {
      const { operationSpy, provider } = operationFixture(options.operation);
      const environment = createRoutingHandlerEnvironment({
        routingProviders: [provider],
        closurePoints: [CLOSURE_POINT],
      });
      const reply = createRoutingTestReply();

      await environment.getHandler(options.path)(
        { query: { waypoints: options.waypointsQuery, avoidClosures: "true" } },
        reply,
      );

      expect(operationSpy).toHaveBeenCalledOnce();
      expect(operationSpy.mock.calls[0]?.[2]).toMatchObject({
        excludeLocations: [CLOSURE_POINT],
        excludePolygons: [],
      });
    });

    it.each([
      {
        caseName: "closure avoidance is omitted",
        closurePoints: [CLOSURE_POINT],
        avoidClosures: undefined,
      },
      {
        caseName: "no closures are active",
        closurePoints: [],
        avoidClosures: "true",
      },
    ])("does not inject exclusions when $caseName", async ({ closurePoints, avoidClosures }) => {
      const { operationSpy, provider } = operationFixture(options.operation);
      const environment = createRoutingHandlerEnvironment({
        routingProviders: [provider],
        closurePoints,
      });
      const reply = createRoutingTestReply();
      const query = { waypoints: options.waypointsQuery } as Record<string, string>;
      if (avoidClosures) query.avoidClosures = avoidClosures;

      await environment.getHandler(options.path)({ query }, reply);

      expect(operationSpy).toHaveBeenCalledOnce();
      expect(operationSpy.mock.calls[0]?.[2]).not.toHaveProperty("excludeLocations");
      expect(operationSpy.mock.calls[0]?.[2]).not.toHaveProperty("excludePolygons");
    });
  });
}
