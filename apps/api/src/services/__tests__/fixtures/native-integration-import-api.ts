/** Actual local-admin HTTP route and generated client in a native API process.
 * Only fixed public synthetic inputs enter this fixture; no DB/host handlers. */

import { writeFileSync } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createApiClient } from "@openmapx/core";
import { importAdminIntegrationConfigs } from "@openmapx/core/api-admin-sdk";
import Fastify from "fastify";
import { sql } from "../../../db";
import { getIntegration, initIntegrations, shutdownIntegrations } from "../../../integration-host";
import { adminIntegrationsRoute } from "../../../routes/admin-integrations";
import { requireAdmin } from "../../../utils/require-admin";
import { initServiceRegistry } from "../../service-registry";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text) as {
  idempotencyKey: string;
  filesystemFault?: "pause-retirement-unlink";
};
if (!/^ordinary-native-[a-f0-9-]{36}$/.test(input.idempotencyKey))
  throw Error("Invalid fixture key");
if (input.filesystemFault !== undefined && input.filesystemFault !== "pause-retirement-unlink")
  throw Error("Invalid filesystem fixture edge");
if (input.filesystemFault) {
  const unlink = filesystem.unlink,
    directory = join(process.env.OPS_TRUSTED_CONFIG_DIR!, ".candidates") + "/";
  filesystem.unlink = async (path) => {
    if (String(path).startsWith(directory)) {
      writeFileSync(join(process.env.OPENMAPX_ROOT_DIR!, "retirement-unlink-paused"), "paused");
      await new Promise<void>(() => {});
    }
    return unlink(path);
  };
  syncBuiltinESMExports();
}
const api = Fastify({ logger: false });
let exit = 0,
  phase = "registry";
try {
  await initServiceRegistry({ strict: true });
  await initIntegrations(api, [
    { directory: join(process.env.OPENMAPX_ROOT_DIR!, "integrations"), isBuiltIn: true },
  ]);
  api.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  await api.register(adminIntegrationsRoute, { prefix: "/api" });
  const baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  phase = "import";
  const result = await importAdminIntegrationConfigs(
    {
      integrations: [
        { integrationId: "alpha", config: { VALUE: "native-new", TOKEN: "synthetic-strip-this" } },
        { integrationId: "beta", config: { VALUE: "native-new-b", enabled: false } },
      ],
    },
    { "idempotency-key": input.idempotencyKey },
    {
      client: createApiClient({ baseUrl }),
      headers: { "x-openmapx-local-admin": process.env.OPENMAPX_LOCAL_ADMIN_TOKEN! },
    },
  );
  if (!result.data || !("ok" in result.data) || result.data.ok !== true) exit = 2;
  process.stdout.write(
    JSON.stringify({
      event: "result",
      state: exit === 0 ? "imported" : "refused",
      status: result.status,
      capturedOrdinaryValueMatches: getIntegration("alpha")?.config.VALUE === "native-new",
      betaDisabled: getIntegration("beta")?.enabled === false,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      event: "result",
      state: "refused",
      phase,
      errorClass: error instanceof Error ? error.name : "unknown",
    }) + "\n",
  );
  exit = 2;
} finally {
  await shutdownIntegrations();
  await api.close();
  await sql.end({ timeout: 2 });
}
process.exit(exit);
