import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The agent's answer to the maintenance prepare is lost and the API dies.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a lost maintenance-prepare reply followed by an API restart",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "returns the original operation and prepares one data fence",
      async () => {
        const lost = host.dropReply("api->agent", {
          method: "POST",
          path: /^\/v1\/operations$/,
          kind: "configurationMaintenance.prepare",
        });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await lost;
        await host.kill("api");
        await host.restart("api");
        // The restarted API resumes the job once the dead owner's claim has lapsed.
        const job = await host.waitForJob(submitted.jobId as string, { timeoutMs: 300_000 });
        expect(job.status).toBe("success");
        expect(host.agentOperations("configurationMaintenance.prepare")).toHaveLength(1);
        const fencePrepares = host
          .requests("agent->dm")
          .filter(
            (request) =>
              request.method === "POST" &&
              /\/configuration-maintenance\/prepare$/.test(request.path),
          );
        expect(fencePrepares).toHaveLength(1);
      },
      900_000,
    );
  },
);
