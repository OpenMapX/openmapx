import { afterAll, beforeAll, describe, expect } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";
import { scenario } from "../scenario";

// The API dies after saving the new configuration, before the agent applies it.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "an API killed between saving and applying a configuration",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    scenario(
      "continues with the same candidate and applies the generation once",
      async () => {
        const start = host.mark();
        const render = host.holdRequest("api->agent", {
          method: "POST",
          path: /^\/v1\/operations$/,
          kind: "stack.render",
        });
        const submitted = await host.submitUpdate();
        expect(submitted.status).toBe(200);
        await render.entered;
        await host.kill("api");
        // The request never reached the agent.
        render.discard();
        await host.restart("api");
        // The restarted API resumes the job once the dead owner's claim has lapsed.
        const job = await host.waitForJob(submitted.jobId as string, { timeoutMs: 300_000 });
        expect(job.status).toBe("success");
        expect(host.agentOperations("stack.render")).toHaveLength(1);
        const recreated = host
          .dockerEffects({ command: "compose up", caller: "helper", since: start })
          .map((call) => call.args.at(-1));
        expect(new Set(recreated).size).toBe(recreated.length);
        expect(recreated.at(-1)).toBe("ops-agent");
      },
      900_000,
    );
  },
);
