import { expect } from "vitest";
import { crashScenario } from "../scenario";

// The agent's answer to the maintenance prepare is lost and the API dies.
crashScenario({
  title: "a lost maintenance-prepare reply followed by an API restart",
  name: "returns the original operation and prepares one data fence",
  enabled: process.env.OPENMAPX_RUN_DATABASE_TESTS === "1",
  timeout: 900_000,
  run: async (host) => {
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
          request.method === "POST" && /\/configuration-maintenance\/prepare$/.test(request.path),
      );
    expect(fencePrepares).toHaveLength(1);
  },
});
