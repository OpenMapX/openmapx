import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerApi } from "../../api.js";
import { registerAuth } from "../../auth.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
it("keeps observation and mutation routes closed without a durable receiver", async () => {
  const app = Fastify();
  apps.push(app);
  registerAuth(app, "synthetic-execution-token");
  registerApi(app, { dataDir: "/tmp/openmapx-nonexistent-execution-fixture" });
  const headers = { authorization: "Bearer synthetic-execution-token" };
  const id = "00000000-0000-4000-8000-000000000001";
  for (const request of [
    {
      method: "POST" as const,
      url: "/executions",
      payload: { operationKey: "opk1_abcdefghijklmnop", input: { kind: "download-fonts" } },
    },
    { method: "GET" as const, url: `/executions/${id}` },
    { method: "GET" as const, url: "/executions/by-key/opk1_abcdefghijklmnop" },
    {
      method: "POST" as const,
      url: `/executions/${id}/cancel`,
      payload: { operationKey: "opk1_abcdefghijklmnop", fingerprint: "a".repeat(64) },
    },
    { method: "GET" as const, url: `/executions/configuration-maintenance/${id}` },
  ]) {
    const result = await app.inject({ ...request, headers });
    expect(result.statusCode, result.body).toBe(503);
    expect((await app.inject(request)).statusCode).toBe(401);
  }
  const privateInput = await app.inject({
    method: "POST",
    url: "/executions",
    headers,
    payload: {
      operationKey: "opk1_abcdefghijklmnop",
      input: {
        kind: "generation-hardlinks",
        revisionId: `cfg1_${"a".repeat(43)}`,
        planDigest: "a".repeat(64),
        coordinatorMode: "require-running",
      },
    },
  });
  expect(privateInput.statusCode).toBe(400);
});
