import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { registerApi } = await import("../src/api.js");

describe("data-manager /transit/bump branch validation", () => {
  let fixtureRoot: string;
  let apps: FastifyInstance[];

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "openmapx-dm-bump-"));
    apps = [];
  });

  afterEach(async () => {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  function createTestApp(): FastifyInstance {
    const app = Fastify();
    apps.push(app);
    return app;
  }

  it.each(["--upload-pack=touch /tmp/x", "-x", "../evil", "main@{upstream}", "feat with spaces"])(
    "rejects unsafe branch %j with 400",
    async (branch) => {
      const app = createTestApp();
      registerApi(app, { dataDir: join(fixtureRoot, "data") });
      const res = await app.inject({
        method: "POST",
        url: "/transit/bump",
        payload: { branch },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("Invalid data-manager body");
    },
  );

  it("accepts a normal branch name and reports the missing installed paired resolver", async () => {
    const app = createTestApp();
    registerApi(app, { dataDir: join(fixtureRoot, "data") });
    const res = await app.inject({
      method: "POST",
      url: "/transit/bump",
      payload: { branch: "release/2026-06" },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("Paired catalog resolver is unavailable");
  });
});
