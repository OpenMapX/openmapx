import { describe, expect, it } from "vitest";
import {
  buildProbeArgs,
  composeNetworkName,
  DEEP_PROBES,
  envFilePermissionWarning,
  PROBE_IMAGE,
  probeFailureDetail,
} from "../src/commands/check";

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

describe("composeNetworkName", () => {
  it("uses the explicit network name from this checkout's compose config", () => {
    expect(
      composeNetworkName(
        JSON.stringify({
          name: "docker",
          networks: { openmapx: { name: "production_openmapx" } },
        }),
      ),
    ).toBe("production_openmapx");
  });

  it("falls back to the project-derived network name", () => {
    expect(composeNetworkName(JSON.stringify({ name: "docker", networks: {} }))).toBe(
      "docker_openmapx",
    );
    expect(composeNetworkName("not json")).toBeNull();
  });
});

describe("probeFailureDetail", () => {
  it("keeps the actionable Docker error instead of the generic help footer", () => {
    expect(
      probeFailureDetail(
        "docker: Error response from daemon: network deploy_openmapx not found.\n\nRun 'docker run --help' for more information",
        125,
      ),
    ).toBe("docker: Error response from daemon: network deploy_openmapx not found.");
  });

  it("falls back to the exit code when stderr is empty", () => {
    expect(probeFailureDetail("", 125)).toBe("exit 125");
  });
});

describe("envFilePermissionWarning", () => {
  it("warns when the env file is readable beyond its owner", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o644)).toContain("chmod 600");
  });

  it("accepts owner-only read/write permissions", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o600)).toBeNull();
    expect(envFilePermissionWarning("infra/docker/.env", 0o400)).toBeNull();
  });

  it("warns for group-readable permissions", () => {
    expect(envFilePermissionWarning("infra/docker/.env", 0o660)).toContain("mode 0660");
  });

  it("ignores an absent env file", () => {
    expect(envFilePermissionWarning("infra/docker/.env", null)).toBeNull();
  });
});

describe("DEEP_PROBES", () => {
  it("bounds the overpass query with an explicit timeout", () => {
    // A timeout-less Overpass query reaped under load can orphan its
    // query-hash-keyed shm segment, after which that exact string returns
    // `duplicate_query` forever (`%5Btimeout%3A` is the URL-encoded `[timeout:`).
    const overpass = DEEP_PROBES.overpass;
    expect(overpass).not.toBeNull();
    expect(overpass?.path).toContain("%5Btimeout%3A");
    expect(overpass?.expect).toBe("elements");
  });
});
