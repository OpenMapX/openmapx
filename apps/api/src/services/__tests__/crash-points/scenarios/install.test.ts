import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrashHost, crashPointsUnavailable } from "../driver";

const unavailable = crashPointsUnavailable();

describe.skipIf(unavailable)("a fresh installation", () => {
  let host: CrashHost;
  beforeAll(async () => {
    host = await CrashHost.open();
  }, 600_000);
  afterAll(async () => {
    await host?.close();
  }, 120_000);

  it("runs every role on release N and finds release N+1", async () => {
    const images = host.runningImages();
    expect(images["app-api"]).toBe(host.releaseImageId("current", "api"));
    expect(images["ops-agent"]).toBe(host.releaseImageId("current", "ops-agent"));
    expect(images["data-manager"]).toBe(host.releaseImageId("current", "data-manager"));
    host.publishNextRelease();
    const checked = await host.checkForUpdate();
    expect(checked.releaseId).toBe(host.release.next);
  }, 600_000);

  it("updates to release N+1 and recreates the agent last", async () => {
    const submitted = await host.submitUpdate();
    expect(submitted.status).toBe(200);
    const job = await host.waitForJob(submitted.jobId as string);
    expect(job.status).toBe("success");
    const images = host.runningImages();
    expect(images["app-api"]).toBe(host.releaseImageId("next", "api"));
    expect(images["ops-agent"]).toBe(host.releaseImageId("next", "ops-agent"));
    expect(images["data-manager"]).toBe(host.releaseImageId("next", "data-manager"));
    const recreated = host
      .dockerEffects({ command: "compose up", caller: "helper" })
      .map((invocation) => invocation.args.at(-1));
    expect(recreated.at(-1)).toBe("ops-agent");
  }, 600_000);
});
