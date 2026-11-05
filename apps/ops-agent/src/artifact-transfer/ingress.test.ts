/** Opt-in exact-image ingress check; synthetic bytes only. No host Docker socket is mounted. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createApiClient } from "@openmapx/core";
import { uploadAdminArtifactTransferContent } from "@openmapx/core/api-admin-sdk";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { adminArtifactTransfersRoute } from "../../../api/src/routes/admin-artifact-transfers";
import { createUnavailableRuntime } from "../runtime";
import { buildOpsAgentServer } from "../server";
import { installArtifactTransferRuntime } from "./runtime";
import { ArtifactTransferStore } from "./store";

const authFixture = vi.hoisted(() => ({ token: "" }));
vi.mock("../../../api/src/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get("authorization") === `Bearer ${authFixture.token}`
          ? { user: { id: "ingress-admin", role: "admin" }, session: { id: "ingress" } }
          : null,
    },
  },
}));
const run = promisify(execFile);
it.skipIf(process.env.RUN_ARTIFACT_INGRESS_TESTS !== "1")(
  "ships a nonbuffering 72h entrypoint and streams beyond the old 30s agent body deadline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-artifact-ingress-"));
    const name = `openmapx-artifact-ingress-${randomUUID().slice(0, 8)}`;
    let containerId: string | undefined;
    const token = "a".repeat(43);
    authFixture.token = randomUUID();
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const store = new ArtifactTransferStore({
      dataRoot: join(root, "data"),
      privateRoot: join(root, "private"),
      token,
      capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 10000 }),
    });
    const runtime = createUnavailableRuntime();
    installArtifactTransferRuntime(runtime, store);
    const agent = buildOpsAgentServer({
      tokens: { api: token, "data-manager": "b".repeat(43) },
      runtime,
      artifactTransfers: store,
      resourcePolicy: { allowGlobal: () => true },
    });
    const api = Fastify();
    const prior = {
      OPS_AGENT_URL: process.env.OPS_AGENT_URL,
      OPS_AGENT_TOKEN_FILE: process.env.OPS_AGENT_TOKEN_FILE,
      OPENMAPX_DISABLE_LOCALHOST_AUTH: process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH,
    };
    try {
      process.env.OPS_AGENT_URL = await agent.listen({ host: "127.0.0.1", port: 0 });
      process.env.OPS_AGENT_TOKEN_FILE = tokenFile;
      process.env.OPENMAPX_DISABLE_LOCALHOST_AUTH = "1";
      await api.register(adminArtifactTransfersRoute, { prefix: "/api" });
      await api.listen({ host: "0.0.0.0", port: 0 });
      const address = api.server.address();
      if (!address || typeof address === "string") throw Error("No owned API address");
      const shipped = await readFile(resolve("services/traefik/config/traefik.yml"), "utf8");
      expect(shipped).toContain("readTimeout: 72h");
      expect(shipped).toContain("writeTimeout: 72h");
      expect(shipped).not.toContain("buffering:");
      // Exercise the shipped static timeout block over HTTP; remove only TLS/ACME/QUIC setup to avoid certificate-network effects in this local fixture.
      const configuration = shipped
        .replace(/ {4}http3:\n {6}advertisedPort: 443\n/, "")
        .replace(/ {6}tls:\n {8}certResolver: letsencrypt\n/, "")
        .replace(/\ncertificatesResolvers:\n[\s\S]*?(?=\n# Routing is generated)/, "");
      await writeFile(join(root, "traefik.yml"), configuration);
      await mkdir(join(root, "dynamic"));
      await writeFile(
        join(root, "dynamic", "routes.yml"),
        `http:\n  routers:\n    upload:\n      rule: PathPrefix(\`/api/admin/artifact-transfers\`)\n      entryPoints: [websecure]\n      service: api\n  services:\n    api:\n      loadBalancer:\n        servers:\n          - url: http://host.docker.internal:${address.port}\n  middlewares:\n    hsts:\n      headers:\n        stsSeconds: 31536000\n`,
      );
      containerId = (
        await run("docker", [
          "run",
          "--detach",
          "--rm",
          "--name",
          name,
          "--label",
          "openmapx.test=artifact-ingress",
          "--memory",
          "256m",
          "-p",
          "127.0.0.1::443",
          "--mount",
          `type=bind,source=${root}/traefik.yml,target=/etc/traefik/traefik.yml,readonly`,
          "--mount",
          `type=bind,source=${root}/dynamic,target=/etc/traefik/dynamic,readonly`,
          "traefik@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c",
        ])
      ).stdout.trim();
      const mapping = (await run("docker", ["port", containerId, "443/tcp"])).stdout.trim();
      const port = Number(mapping.split(":").at(-1));
      const client = createApiClient({
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: "omit",
        headerInterceptor: () => ({ Authorization: `Bearer ${authFixture.token}` }),
      });
      let reachable = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/admin/artifact-transfers`, {
            headers: { Authorization: `Bearer ${authFixture.token}` },
            signal: AbortSignal.timeout(1000),
          });
          if (response.status === 200) {
            reachable = true;
            break;
          }
        } catch {}
        await delay(200);
      }
      expect(reachable, (await run("docker", ["logs", containerId])).stderr).toBe(true);
      const stage = await store.createStage({
        ownerId: "ingress-admin",
        purpose: "prepared-artifact",
        direction: "upload",
        declaredBytes: 36,
        operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
      });
      class SlowBlob extends Blob {
        override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
          let sent = 0;
          return new ReadableStream(
            {
              async pull(c) {
                if (sent === 36) {
                  c.close();
                  return;
                }
                await delay(1000);
                c.enqueue(new Uint8Array([sent++]));
              },
            },
            { highWaterMark: 0 },
          );
        }
      }
      const started = Date.now();
      const upload = uploadAdminArtifactTransferContent(
        stage.stageId,
        new SlowBlob([new Uint8Array(36)]),
        { client, timeoutMs: 60000 },
      );
      await delay(6000);
      const inFlight = await store.getStage({
        stageId: stage.stageId,
        ownerId: "ingress-admin",
        purpose: stage.purpose,
      });
      expect(inFlight.bytes).toBeGreaterThan(0);
      expect(inFlight.bytes).toBeLessThan(36);
      const result = await upload;
      expect(Date.now() - started).toBeGreaterThan(30000);
      expect(result.status).toBe(200);
      if (result.status === 200)
        expect(result.data).toMatchObject({ state: "uploaded", bytes: 36 });
    } finally {
      if (containerId) await run("docker", ["rm", "--force", containerId]).catch(() => {});
      await api.close();
      await agent.close();
      store.close();
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
