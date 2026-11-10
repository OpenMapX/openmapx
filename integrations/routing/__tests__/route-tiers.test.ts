import type { RouteOptions } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { createRoutingHandlerEnvironment } from "./support/routing-handler-contract.js";

describe("routing route rate-limit tiers", () => {
  it("keeps directions on their own tier and heavier planning on expensive", () => {
    const tiers = new Map<string, RouteOptions["rateLimitTier"]>();
    createRoutingHandlerEnvironment({
      routingProviders: [],
      contextOverrides: {
        registerRoute: (
          method: string,
          path: string,
          _handler: unknown,
          options?: RouteOptions,
        ) => {
          tiers.set(`${method} ${path}`, options?.rateLimitTier);
        },
      },
    });

    expect(tiers.get("GET /directions")).toBe("routing");
    expect(tiers.get("POST /directions/schedule")).toBe("routing");
    expect(tiers.get("GET /directions/optimize")).toBe("expensive");
    expect(tiers.get("POST /directions/ev")).toBe("expensive");
  });
});
