import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core/server", () => ({
  repoPaths: () => ({ composeOutPath: "/srv/openmapx/infra/docker/docker-compose.generated.yml" }),
}));

const { currentAppApiRuntimeInfo, prepareAppApiReplacement, startAppApiReplacement } = await import(
  "../app-api-replacement"
);

const previousContainerId = "a".repeat(64);
const currentImageId = `sha256:${"b".repeat(64)}`;
const expectedImageId = `sha256:${"c".repeat(64)}`;
const helperContainerId = "d".repeat(64);
const outcomeFile = "/srv/openmapx/infra/docker/.maintenance/app-api-job-123.status";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("app-api replacement helper", () => {
  it("prepares an isolated sibling from the current immutable image", async () => {
    vi.stubEnv("OPENMAPX_HOST_DIR", "/srv/openmapx");
    const calls: string[][] = [];
    const outputs = [
      previousContainerId,
      previousContainerId,
      currentImageId,
      expectedImageId,
      helperContainerId,
    ];
    const execDocker = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: `${outputs.shift()}\n`, stderr: "" };
    });

    await expect(
      prepareAppApiReplacement("job-123", "ghcr.io/openmapx/api:latest", execDocker),
    ).resolves.toEqual({ helperContainerId, previousContainerId, expectedImageId, outcomeFile });

    expect(calls[0]).toEqual([
      "compose",
      "--project-directory",
      "/srv/openmapx/infra/docker",
      "-f",
      "/srv/openmapx/infra/docker/docker-compose.generated.yml",
      "ps",
      "-q",
      "app-api",
    ]);
    const createCall = calls.find(([command]) => command === "create");
    expect(createCall).toEqual(
      expect.arrayContaining([
        "create",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
        "type=bind,src=/srv/openmapx,dst=/srv/openmapx,readonly",
        "type=bind,src=/srv/openmapx/infra/docker,dst=/srv/openmapx/infra/docker",
        currentImageId,
      ]),
    );
    if (!createCall) throw new Error("Expected a docker create invocation");
    const helperScript = createCall[createCall.indexOf("-c") + 1];
    expect(helperScript).toContain("--wait --wait-timeout 180 app-api");
    expect(helperScript).toContain("app-api-rollback.yml");
  });

  it("rejects an invalid helper id and cleans up the prepared container", async () => {
    vi.stubEnv("OPENMAPX_HOST_DIR", "/srv/openmapx");
    const outputs = [
      previousContainerId,
      previousContainerId,
      currentImageId,
      expectedImageId,
      "not-a-container-id",
      "",
    ];
    const execDocker = vi.fn(async () => ({ stdout: `${outputs.shift() ?? ""}\n`, stderr: "" }));

    await expect(
      prepareAppApiReplacement("job-123", "ghcr.io/openmapx/api:latest", execDocker),
    ).rejects.toThrow("invalid update helper container id");
    expect(execDocker).toHaveBeenLastCalledWith(["rm", "-f", "not-a-container-id"]);
  });

  it("attaches to the helper and treats any return as a failed replacement", async () => {
    const execDocker = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "compose returned\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      startAppApiReplacement(
        { helperContainerId, previousContainerId, expectedImageId, outcomeFile },
        execDocker,
      ),
    ).rejects.toThrow("exited without replacing the current API: compose returned");
    expect(execDocker).toHaveBeenNthCalledWith(
      1,
      ["start", "--attach", helperContainerId],
      390_000,
    );
    expect(execDocker).toHaveBeenNthCalledWith(2, ["rm", "-f", helperContainerId]);
  });

  it("surfaces helper start failures and removes the prepared container", async () => {
    const startError = Object.assign(new Error("docker start failed"), {
      stderr: "daemon rejected the start",
    });
    const execDocker = vi
      .fn()
      .mockRejectedValueOnce(startError)
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      startAppApiReplacement(
        { helperContainerId, previousContainerId, expectedImageId, outcomeFile },
        execDocker,
      ),
    ).rejects.toThrow("App-api replacement helper failed: daemon rejected the start");
    expect(execDocker).toHaveBeenNthCalledWith(2, ["rm", "-f", helperContainerId]);
  });

  it("resolves the current container identity, image, and update job", async () => {
    vi.stubEnv("HOSTNAME", previousContainerId.slice(0, 12));
    const outputs = [previousContainerId, expectedImageId, "job-123"];
    const execDocker = vi.fn(async () => ({ stdout: `${outputs.shift()}\n`, stderr: "" }));

    await expect(currentAppApiRuntimeInfo(execDocker)).resolves.toEqual({
      containerId: previousContainerId,
      imageId: expectedImageId,
      updateJobId: "job-123",
    });
    expect(execDocker).toHaveBeenNthCalledWith(1, [
      "container",
      "inspect",
      "--format",
      "{{.Id}}",
      previousContainerId.slice(0, 12),
    ]);
    expect(execDocker).toHaveBeenNthCalledWith(2, [
      "container",
      "inspect",
      "--format",
      "{{.Image}}",
      previousContainerId.slice(0, 12),
    ]);
  });
});
