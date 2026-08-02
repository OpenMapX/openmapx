import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerApi } from "../api.js";

const RESULT = {
  segments: 12613,
  rows: 2787,
  tiles: 11,
  resolvable: 2569,
  matched: 2569,
  matchRatePct: 100,
  built: true,
  wayCount: 6838,
  edgeCount: 9001,
};

const appWith = (bakePredicted: () => Promise<typeof RESULT>) => {
  const app = Fastify();
  // biome-ignore lint/suspicious/noExplicitAny: partial ApiOptions for the test
  registerApi(app, { bakePredicted } as any);
  return app;
};

describe("POST /traffic/predicted/bake", () => {
  it("accepts the request without waiting for the bake", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = appWith(async () => {
      await gate;
      return RESULT;
    });

    // A real bake runs for hours; the handler must return long before it ends.
    const res = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true });

    release();
    await app.close();
  });

  it("returns 409 while a bake is already running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = appWith(async () => {
      await gate;
      return RESULT;
    });

    const first = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(second.statusCode).toBe(409);

    release();
    await app.close();
  });

  it("frees the single-flight lock after a failed bake", async () => {
    const bake = vi
      .fn()
      .mockRejectedValueOnce(new Error("docker exploded"))
      .mockResolvedValueOnce(RESULT);
    // biome-ignore lint/suspicious/noExplicitAny: partial ApiOptions for the test
    const app = appWith(bake as any);

    const first = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(first.statusCode).toBe(202);
    // Let the rejected promise settle so the finally-block clears the lock.
    await new Promise((resolve) => setImmediate(resolve));

    const second = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(second.statusCode).toBe(202);
    expect(bake).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns 501 when no baker is configured", async () => {
    const app = Fastify();
    registerApi(app, {});
    const res = await app.inject({ method: "POST", url: "/traffic/predicted/bake" });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});
