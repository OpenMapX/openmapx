import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { declaredRouteAuth, declareRouteAuth, resetDeclaredRouteAuth } from "../route-auth.js";

beforeEach(() => {
  resetDeclaredRouteAuth();
});

describe("declareRouteAuth", () => {
  it("applies the declared level to every route in the plugin", async () => {
    const app = Fastify({ logger: false });
    await app.register(async (fastify) => {
      declareRouteAuth(fastify, "session");
      fastify.get("/a", async () => ({}));
      fastify.post("/b", async () => ({}));
    });
    await app.ready();

    expect(declaredRouteAuth("GET", "/a")).toBe("session");
    expect(declaredRouteAuth("POST", "/b")).toBe("session");
    await app.close();
  });

  it("lets a single route override the plugin-wide level", async () => {
    const app = Fastify({ logger: false });
    await app.register(async (fastify) => {
      declareRouteAuth(fastify, "public");
      fastify.post("/open", async () => ({}));
      fastify.post("/guarded", { config: { auth: "session" } }, async () => ({}));
    });
    await app.ready();

    expect(declaredRouteAuth("POST", "/open")).toBe("public");
    expect(declaredRouteAuth("POST", "/guarded")).toBe("session");
    await app.close();
  });

  it("records the prefixed url, not the url as written in the plugin", async () => {
    const app = Fastify({ logger: false });
    await app.register(
      async (fastify) => {
        declareRouteAuth(fastify, "admin");
        fastify.get("/overview", async () => ({}));
      },
      { prefix: "/api/admin" },
    );
    await app.ready();

    expect(declaredRouteAuth("GET", "/api/admin/overview")).toBe("admin");
    expect(declaredRouteAuth("GET", "/overview")).toBeUndefined();
    await app.close();
  });

  it("reports nothing for a plugin that never declared a level", async () => {
    const app = Fastify({ logger: false });
    await app.register(async (fastify) => {
      fastify.get("/undeclared", async () => ({}));
    });
    await app.ready();

    expect(declaredRouteAuth("GET", "/undeclared")).toBeUndefined();
    await app.close();
  });

  it("clears the registry on reset so a second mount starts empty", async () => {
    const app = Fastify({ logger: false });
    await app.register(async (fastify) => {
      declareRouteAuth(fastify, "admin");
      fastify.get("/x", async () => ({}));
    });
    await app.ready();
    expect(declaredRouteAuth("GET", "/x")).toBe("admin");

    resetDeclaredRouteAuth();
    expect(declaredRouteAuth("GET", "/x")).toBeUndefined();
    await app.close();
  });
});
