import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1" || !!crashPointsUnavailable())(
  "a fresh installation",
  () => {
    let host: CrashHost;
    beforeAll(async () => {
      host = await CrashHost.open();
    }, 600_000);
    afterAll(async () => {
      await host?.close();
    }, 120_000);

    it("runs every role on release N and finds release N+1 to update to", async () => {
      const images = host.runningImages();
      expect(images["app-api"]).toBe(host.releaseImageId("current", "api"));
      expect(images["ops-agent"]).toBe(host.releaseImageId("current", "ops-agent"));
      expect(images["data-manager"]).toBe(host.releaseImageId("current", "data-manager"));
      expect(host.release.nextDigest).toMatch(/^[a-f0-9]{64}$/);
      expect((await host.submitDataJob()).status).toBe(200);
    });
  },
);
