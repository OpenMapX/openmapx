import { describe, expect, it } from "vitest";
import { buildProbeArgs, PROBE_IMAGE } from "../src/commands/check";

describe("buildProbeArgs", () => {
  it("builds args for a standalone `docker run` curl container on the compose network", () => {
    const args = buildProbeArgs("docker_openmapx", "http://valhalla:8002/status");

    // `--network` is rejected by `docker compose run` (cobra: "unknown flag:
    // --network"), so the probe must run via plain `docker run`, which accepts
    // it. The network name is passed straight through.
    const netIdx = args.indexOf("--network");
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(args[netIdx + 1]).toBe("docker_openmapx");
  });

  it("uses a real, pinned curl image", () => {
    const args = buildProbeArgs("docker_openmapx", "http://app-api:3001/health");
    // The old `alpine/wget:1.27.0` image does not exist on Docker Hub.
    expect(PROBE_IMAGE).toMatch(/^curlimages\/curl:\d+\.\d+\.\d+$/);
    expect(args).toContain(PROBE_IMAGE);
  });

  it("does not pass docker-compose-only flags to `docker run`", () => {
    const args = buildProbeArgs("docker_openmapx", "http://app-api:3001/health");
    // `--no-deps` is a `docker compose run` flag; `docker run` errors on it.
    expect(args).not.toContain("--no-deps");
  });

  it("auto-removes the container and targets the probe url last", () => {
    const url = "http://photon:2322/api?q=test";
    const args = buildProbeArgs("docker_openmapx", url);
    expect(args).toContain("--rm");
    expect(args[args.length - 1]).toBe(url);
  });
});
