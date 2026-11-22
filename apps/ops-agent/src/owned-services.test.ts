import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { installedCompose } from "../../../packages/core/src/services/__fixtures__/compose-path-host";
import { ownedComposePathRuntime } from "./__fixtures__/owned-compose-path-runtime";
import { ownedServiceHost } from "./__fixtures__/owned-service-host";
import { createDockerRuntime } from "./docker-runtime";
import { dispatchOpsOperation } from "./runtime";

const roots: string[] = [];
async function fixture() {
  const host = await ownedServiceHost();
  roots.push(host.root);
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;

describe("owned service cleanup", () => {
  it("deselected owned service retains stop and logs but cannot start", async () => {
    const host = await fixture();
    await host.deselect();
    const runtime = createDockerRuntime({
      stack: host.stack,
      fileExists: () => false,
      execFile: host.execFile,
      ownedServices: host.owned,
    });
    const stop = { kind: "service.stop", serviceId: "motis" } as const;
    await dispatchOpsOperation(runtime, stop, await host.context(stop));
    expect(host.calls).toContainEqual(["stop", host.row.Id]);
    expect(host.row.State).toBe("exited");
    const logs = { kind: "service.logs", serviceId: "motis", tail: 20 } as const;
    expect((await dispatchOpsOperation(runtime, logs, await host.context(logs))).lines).toEqual([
      "retained log",
    ]);
    expect(host.calls).toContainEqual(["logs", "--tail=20", host.row.Id]);
    for (const kind of [
      "service.start",
      "service.restart",
      "service.recreate",
      "service.recreateIsolated",
      "service.pull",
      "service.update",
      "service.build",
    ] as const)
      await expect(
        host.claimer.claim(
          { kind, serviceId: "motis", expectedConfigurationRevisionId: host.initial.revisionId },
          "a".repeat(64),
          signal(),
        ),
      ).resolves.toBeNull();
  });

  it.each([
    ["unknown registry ID", "com.docker.compose.service", "unknown"],
    ["same name in another project", "com.docker.compose.project", "other"],
    ["forged service label", "com.docker.compose.service", "api"],
    ["foreign working directory", "com.docker.compose.project.working_dir", "/tmp"],
    ["foreign configuration file", "com.docker.compose.project.config_files", "/etc/passwd"],
  ])("denies %s", async (_name, label, value) => {
    const host = await fixture();
    (host.row.Labels as Record<string, string>)[label] = value;
    await expect(host.owned.inspectOwnedServices(signal())).resolves.toEqual([]);
    await expect(
      host.claimer.claim({ kind: "service.stop", serviceId: "motis" }, "a".repeat(64), signal()),
    ).resolves.toBeNull();
    expect(host.calls.some((args) => args[0] === "stop")).toBe(false);
  });

  it("rejects image mismatch and ambiguous duplicate claims", async () => {
    const host = await fixture();
    host.row.Image = `sha256:${"c".repeat(64)}`;
    expect(await host.owned.inspectOwnedServices(signal())).toEqual([]);
    host.row.Image = `sha256:${"b".repeat(64)}`;
    host.setRows([host.row, { ...host.row, Id: "c".repeat(64) }]);
    await expect(host.owned.inspectOwnedServices(signal())).rejects.toThrow(
      "inventory unavailable",
    );
  });

  it("keeps a container that runs the image its generation recorded after a pull moved the tag", async () => {
    const host = await fixture();
    const reference = host.row.ConfigImage as string;
    // The fixture's generation recorded the image its containers were created with.
    expect(services.readGenerationImageIds(host.infraDir, host.initial.revisionId).motis).toBe(
      host.row.Image,
    );
    host.setImageIdentity(reference, `sha256:${"e".repeat(64)}`);
    expect(
      (await host.owned.inspectOwnedServices(signal())).map((s) => [
        s.serviceId,
        s.provenance.imageId,
      ]),
    ).toEqual([["motis", `sha256:${"b".repeat(64)}`]]);
    // An image neither recorded nor named by the reference now is a stranger's.
    host.row.Image = `sha256:${"c".repeat(64)}`;
    expect(await host.owned.inspectOwnedServices(signal())).toEqual([]);
    // A container the reference names now is the agent's, recorded or not.
    host.row.Image = `sha256:${"e".repeat(64)}`;
    expect((await host.owned.inspectOwnedServices(signal())).map((s) => s.serviceId)).toEqual([
      "motis",
    ]);
  });

  it("matches a container from a generation that recorded no images against the applied one's record", async () => {
    const host = await fixture();
    const reference = host.row.ConfigImage as string;
    // The container's generation was written before its images existed.
    rmSync(
      join(
        dirname(
          services.configurationGenerationComposeFile(host.infraDir, host.initial.revisionId),
        ),
        "images.json",
      ),
    );
    host.setImageIdentity(reference, `sha256:${"e".repeat(64)}`);
    expect(await host.owned.inspectOwnedServices(signal())).toEqual([]);
    // A later generation, applied while the old image was present, recorded it.
    host.setImageIdentity(reference, host.row.Image as string);
    await services.commitConfigurationGeneration({
      infraDir: host.infraDir,
      services: host.loaded,
      input: {
        domain: "later.example.test",
        selectedRoots: ["motis"],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      imageIds: (references) =>
        services.inspectLocalImageIds(references, async (args) => {
          const { stdout } = await host.execFile("docker", args, {
            signal: signal(),
            timeout: 15_000,
            maxBuffer: 4096,
          });
          return stdout;
        }),
    });
    host.setImageIdentity(reference, `sha256:${"e".repeat(64)}`);
    expect((await host.owned.inspectOwnedServices(signal())).map((s) => s.serviceId)).toEqual([
      "motis",
    ]);
  });

  it.each(["oversized", "malformed IDs", "blank record", "malformed inspection"])(
    "fails %s acquisition rather than truncating",
    async (mode) => {
      const host = await fixture();
      if (mode === "oversized")
        host.setRawListing(
          Array.from({ length: 257 }, (_, i) => i.toString(16).padStart(64, "0")).join("\n"),
        );
      else if (mode === "malformed IDs") host.setRawListing("short-id");
      else if (mode === "blank record") host.setRawListing(`${host.row.Id}\n\n${"c".repeat(64)}`);
      else host.setMalformedInspect();
      await expect(host.owned.inspectOwnedServices(signal())).rejects.toThrow(
        "inventory unavailable",
      );
      expect(host.calls.some((args) => args[0] === "stop")).toBe(false);
    },
  );

  it.each(["ID", "label", "image"])(
    "rejects a replaced %s at the effect boundary",
    async (mode) => {
      const host = await fixture();
      const operation = { kind: "service.stop", serviceId: "motis" } as const;
      const context = await host.context(operation);
      if (mode === "ID") host.row.Id = "c".repeat(64);
      if (mode === "label") host.row.Labels["com.docker.compose.project"] = "other";
      if (mode === "image") host.row.Image = `sha256:${"c".repeat(64)}`;
      await expect(dispatchOpsOperation(host.runtime, operation, context)).rejects.toThrow();
      expect(host.calls.some((args) => args[0] === "stop")).toBe(false);
    },
  );
});

it.runIf(installedCompose)(
  "verifies owned retained provenance using actual Compose path resolution",
  async () => {
    const fixture = await ownedComposePathRuntime();
    roots.push(fixture.host.root);
    await fixture.host.commit("advanced");
    const found = await fixture.owned.inspectOwnedServices(new AbortController().signal);
    expect(found.map((service) => service.containerId)).toEqual([fixture.row.Id]);
    expect(fixture.pathChecks.length).toBeGreaterThan(0);
    expect(fixture.pathChecks.every((checks) => Object.values(checks).every(Boolean))).toBe(true);
    expect(
      fixture.calls
        .filter((args) => args[0] === "compose")
        .every((args) => args.includes("--project-directory")),
    ).toBe(true);
  },
);

it.runIf(installedCompose)(
  "denies a container whose labels name the current pointer instead of its generation",
  async () => {
    const fixture = await ownedComposePathRuntime();
    roots.push(fixture.host.root);
    fixture.row.Labels["com.docker.compose.project.config_files"] = fixture.host.stack.composePath;
    fixture.row.Labels["com.docker.compose.project.working_dir"] = dirname(
      fixture.host.stack.composePath,
    );
    const inventory = await fixture.owned.inspectInventory?.(new AbortController().signal);
    expect(inventory?.services).toEqual([]);
    expect(inventory?.unverifiedServiceIds).toEqual(["alpha"]);
    expect(fixture.calls.some((args) => args.includes("config"))).toBe(false);
  },
);
