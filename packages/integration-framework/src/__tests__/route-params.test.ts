import { describe, expectTypeOf, it } from "vitest";
import type { IntegrationContext, RouteHandler, RouteParams, RouteRequest } from "../context";

declare const ctx: IntegrationContext;

const byId = (req: RouteRequest<RouteParams<"/stops/:id">>) => {
  expectTypeOf(req.params.id).toEqualTypeOf<string>();
};
const byIdAndX = (req: RouteRequest<{ id: string; x: string }>) => {
  expectTypeOf(req.params.x).toEqualTypeOf<string>();
};
const anyParams: RouteHandler = () => undefined;

// The registrations below run only through the type checker; they must not reach a real context.
function typeOnly(_check: () => void): void {}

describe("RouteParams", () => {
  it("declares each :name segment of a literal path as a string", () => {
    expectTypeOf<RouteParams<"/stops/:id">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<RouteParams<"/tiles/:z/:x/:y">>().toMatchTypeOf<{
      z: string;
      x: string;
      y: string;
    }>();
  });

  it("strips a file-extension or hyphen suffix from the param name", () => {
    expectTypeOf<RouteParams<"/tiles/:z/:x/:y.png">>().toMatchTypeOf<{
      z: string;
      x: string;
      y: string;
    }>();
    expectTypeOf<keyof RouteParams<"/tiles/:y.png">>().toEqualTypeOf<"y">();
    expectTypeOf<keyof RouteParams<"/legs/:id-geometry">>().toEqualTypeOf<"id">();
  });

  it("declares a trailing wildcard as *", () => {
    expectTypeOf<RouteParams<"/stations/:id/detail/*">>().toMatchTypeOf<{
      id: string;
      "*": string;
    }>();
    expectTypeOf<keyof RouteParams<"/files/*">>().toEqualTypeOf<"*">();
  });

  it("declares no params for a literal path without any", () => {
    expectTypeOf<RouteParams<"/stops">>().toEqualTypeOf<Record<string, never>>();
  });

  it("declares any param for a path only known as string", () => {
    expectTypeOf<RouteParams<string>>().toEqualTypeOf<Record<string, string>>();
  });

  it("keeps only the first name of /:a-:b, which is stricter than the host", () => {
    expectTypeOf<keyof RouteParams<"/pair/:a-:b">>().toEqualTypeOf<"a">();
  });
});

describe("registerRoute", () => {
  it("narrows an inline handler's params to the names its path declares", () => {
    typeOnly(() => {
      ctx.registerRoute("GET", "/stops/:id", (req) => {
        expectTypeOf(req.params.id).toEqualTypeOf<string>();
        // @ts-expect-error the path declares no such param
        void req.params.name;
      });
      ctx.registerRoute("GET", "/files/*", (req) => {
        expectTypeOf(req.params["*"]).toEqualTypeOf<string>();
      });
    });
  });

  it("accepts a separately typed handler on a path that declares its params", () => {
    typeOnly(() => {
      ctx.registerRoute("GET", "/stops/:id", byId);
      ctx.registerRoute("GET", "/vehicles/:id", byId);
    });
  });

  it("refuses a separately typed handler on a path that lacks its params", () => {
    typeOnly(() => {
      // @ts-expect-error `/stops` declares no id
      ctx.registerRoute("GET", "/stops", byId);
      // @ts-expect-error `/stops/:id` declares no x
      ctx.registerRoute("GET", "/stops/:id", byIdAndX);
      // @ts-expect-error `/pair/:a-:b` declares only a
      ctx.registerRoute("GET", "/pair/:a-:b", (req: RouteRequest<{ a: string; b: string }>) => {
        void req.params.b;
      });
    });
  });

  it("accepts a handler typed with the default params on any path", () => {
    typeOnly(() => {
      ctx.registerRoute("GET", "/stops", anyParams);
      ctx.registerRoute("GET", "/stops/:id", anyParams);
    });
  });
});
