import type { ApiOperation } from "@openmapx/core/api-contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import z from "zod/v4";
import { createContractRouteRegistrar } from "../contract-route";

const itemSchema = z.strictObject({ id: z.string(), count: z.number().int() });
const errorSchema = z.strictObject({ error: z.string() });
const operations = {
  readItem: {
    method: "GET",
    path: "/api/item",
    auth: "public",
    responses: {
      200: { kind: "json", schema: itemSchema },
      500: { kind: "json", schema: errorSchema },
    },
  },
} satisfies Record<string, ApiOperation>;

const register = createContractRouteRegistrar(operations, {
  tag: "test",
  label: "test",
  validationPhase: "preHandler",
});

async function appWith(handler: Parameters<typeof register>[2]) {
  const app = Fastify();
  app.register(async (api) => register(api, "readItem", handler), { prefix: "/api" });
  await app.ready();
  return app;
}

afterEach(() => vi.restoreAllMocks());

describe("contract route responses", () => {
  it("validates an object body once and sends its validated JSON", async () => {
    const parse = vi.spyOn(itemSchema, "safeParse");
    const app = await appWith(async () => ({ id: "a", count: 2 }));

    const response = await app.inject({ method: "GET", url: "/api/item" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "a", count: 2 });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("still refuses an object body that breaks the contract", async () => {
    const app = await appWith(async () => ({ id: "a", count: "two" }));
    const response = await app.inject({ method: "GET", url: "/api/item" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("two");
  });

  it("still refuses a pre-serialized string that breaks the contract", async () => {
    const app = await appWith(async (_req, reply) => {
      reply.type("application/json");
      return reply.send(JSON.stringify({ id: "a", count: "two" }));
    });
    const response = await app.inject({ method: "GET", url: "/api/item" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("two");
  });

  it("validates a valid pre-serialized string in onSend", async () => {
    const parse = vi.spyOn(itemSchema, "safeParse");
    const app = await appWith(async (_req, reply) => {
      reply.type("application/json");
      return reply.send(JSON.stringify({ id: "b", count: 3 }));
    });
    const response = await app.inject({ method: "GET", url: "/api/item" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "b", count: 3 });
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
