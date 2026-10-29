/** Actual built-in OSRM builder/staged publication/recording; external command I/O only is substituted. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("execa", () => ({
  execa: async (command: string, args: string[]) => {
    commands.calls.push([command, ...args]);
    if (command === "docker" && args[0] === "run") {
      const volume = args[args.indexOf("-v") + 1];
      if (!volume) throw Error("Missing actual builder mount");
      const directory = volume.slice(0, -6);
      for (const name of [
        "region.osrm",
        "region.osrm.partition",
        "region.osrm.cells",
        "region.osrm.mldgr",
      ])
        writeFileSync(join(directory, name), `synthetic external OSRM output ${name}`);
    }
    return { stdout: "", stderr: "", exitCode: command === "git" ? 1 : 0 };
  },
}));
it("records the actual default builder's source hash and local output evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-default-build-evidence-"));
  try {
    mkdirSync(join(root, "infra/docker/data/osm"), { recursive: true });
    mkdirSync(join(root, "services/osrm"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(
      join(root, "services/osrm/service.json"),
      JSON.stringify({
        id: "osrm",
        name: "OSRM",
        version: "1.0.0",
        quality: "built-in",
        buildCommand: "openmapx services build osrm",
        container: { image: "example.test/osrm", tag: "1" },
      }),
    );
    writeFileSync(join(root, "infra/docker/data/osm/europe-germany.osm.pbf"), "source fixture");
    const { buildServices } = await import("../src/lib/service-builds");
    await buildServices({
      rootDir: root,
      mode: "explicit",
      serviceIds: ["osrm"],
      region: "europe/germany",
    });
    const record = JSON.parse(
        readFileSync(join(root, "infra/docker/data/.openmapx-builds/osrm.json"), "utf8"),
      ),
      evidence = JSON.parse(
        readFileSync(join(root, "infra/docker/data/.openmapx-builds/osrm.evidence.json"), "utf8"),
      );
    expect(record).toMatchObject({
      schemaVersion: 2,
      service: "osrm",
      sourceFingerprints: [{ sha256: createHash("sha256").update("source fixture").digest("hex") }],
    });
    expect(evidence.record).toEqual(record);
    expect(evidence.files.map((f: { path: string }) => f.path)).toContain(
      "osrm-graph/region.osrm.mldgr",
    );
    expect(evidence.inputs).toHaveLength(1);
    expect(commands.calls.filter((call) => call[0] === "docker" && call[1] === "run")).toHaveLength(
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
