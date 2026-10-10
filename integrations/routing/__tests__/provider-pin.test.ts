import { describe, expect, it } from "vitest";
import {
  createDirectionsCacheIdentity,
  DIRECTIONS_REQUEST_POLICY,
  parseDirectionsRequest,
} from "../directions-request";
import {
  createDirectionsResult,
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract";

const query = { waypoints: "0,0;0.002,0", mode: "driving", provider: "routing-second" };

describe("pinned directions provider", () => {
  it("routes with the requested compatible provider instead of the default", async () => {
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-first",
          providerId: "first",
          getRoute: async () => createDirectionsResult(),
        },
        {
          integrationId: "routing-second",
          providerId: "second",
          getRoute: async () => createDirectionsResult(),
        },
      ],
    });
    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")({ query }, reply);
    expect(reply.code).toBe(200);
    expect(reply.body).toMatchObject({ provider: "routing-second" });
  });

  it("does not fall back when the requested provider fails", async () => {
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-first",
          providerId: "first",
          getRoute: async () => createDirectionsResult(),
        },
        {
          integrationId: "routing-second",
          providerId: "second",
          getRoute: async () => {
            throw new Error("offline");
          },
        },
      ],
    });
    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")({ query }, reply);
    expect(reply.code).toBe(502);
  });

  it("does not bypass required exclusion capabilities", async () => {
    const environment = createRoutingHandlerEnvironment({
      closurePoints: [[0.001, 0]],
      routingProviders: [
        {
          integrationId: "routing-second",
          providerId: "second",
          supportsExclusions: false,
          getRoute: async () => createDirectionsResult(),
        },
        {
          integrationId: "routing-aware",
          providerId: "aware",
          supportsExclusions: true,
          getRoute: async () => createDirectionsResult(),
        },
      ],
    });
    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")({ query: { ...query, avoidClosures: "1" } }, reply);
    expect(reply.code).toBe(503);
  });

  it("rejects malformed pins and separates pinned cache identities", () => {
    expect(() =>
      parseDirectionsRequest({ ...query, provider: "https://host" }, DIRECTIONS_REQUEST_POLICY),
    ).toThrow();
    const a = parseDirectionsRequest(query, DIRECTIONS_REQUEST_POLICY);
    const b = parseDirectionsRequest(
      { ...query, provider: "routing-first" },
      DIRECTIONS_REQUEST_POLICY,
    );
    expect(createDirectionsCacheIdentity(a, null)).not.toEqual(
      createDirectionsCacheIdentity(b, null),
    );
  });
});
