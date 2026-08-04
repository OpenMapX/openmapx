import Fastify from "fastify";
import { describe, expect, it } from "vitest";

const { registerApi } = await import("../src/api.js");

describe("data-manager /transit/bump branch validation", () => {
  it.each(["--upload-pack=touch /tmp/x", "-x", "../evil", "main@{upstream}", "feat with spaces"])(
    "rejects unsafe branch %j with 400",
    async (branch) => {
      const app = Fastify();
      registerApi(app, { dataDir: "/tmp/openmapx-dm-bump", repoRoot: "/tmp/repo" });
      const res = await app.inject({
        method: "POST",
        url: "/transit/bump",
        payload: { branch },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("invalid-branch");
      await app.close();
    },
  );

  it("accepts a normal branch name (passes validation, fails later on missing catalog)", async () => {
    const app = Fastify();
    registerApi(app, { dataDir: "/tmp/openmapx-dm-bump", repoRoot: "/tmp/repo" });
    const res = await app.inject({
      method: "POST",
      url: "/transit/bump",
      payload: { branch: "release/2026-06" },
    });
    // Passes the ref check, then hits the catalog-not-cloned guard (409),
    // proving the validator did not reject a legitimate ref.
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("catalog-not-cloned");
    await app.close();
  });
});
