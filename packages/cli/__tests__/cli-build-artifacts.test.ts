import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_PATH,
  type BuildRecord,
  buildProvenance,
  exportBuildBundle,
  importBuildBundle,
  readBuildRecord,
  writeBuildRecord,
} from "../src/lib/build-artifacts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const OSRM_IMAGE = `ghcr.io/project-osrm/osrm-backend:latest@${DIGEST_A}`;
const MOTIS_IMAGE = `ghcr.io/motis-project/motis:latest@${DIGEST_A}`;

function motisRecord(): BuildRecord {
  return { ...osrmRecord(), service: "motis", runtimeImages: { motis: MOTIS_IMAGE } };
}
const BUNDLE_MANIFEST_DIR = BUNDLE_MANIFEST_PATH.split("/")[0] ?? "";

let tmp: string;
let buildHost: string;
let serveHost: string;

function writeServiceManifest(root: string, id: string, image: string, digest: string): void {
  mkdirSync(join(root, "services", id), { recursive: true });
  writeFileSync(
    join(root, "services", id, "service.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image, tag: "latest", digest, expose: [5000] },
    }),
  );
}

function makeHost(name: string, osrmDigest = DIGEST_A): string {
  const root = join(tmp, name);
  mkdirSync(join(root, "infra", "docker", "data"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeServiceManifest(root, "osrm", "ghcr.io/project-osrm/osrm-backend", osrmDigest);
  writeServiceManifest(root, "motis", "ghcr.io/motis-project/motis", DIGEST_A);
  return root;
}

function dataDir(root: string): string {
  return join(root, "infra", "docker", "data");
}

function osrmRecord(): BuildRecord {
  return {
    schemaVersion: 1,
    service: "osrm",
    region: "europe/germany",
    sourcePbf: { name: "europe-germany.osm.pbf", sizeBytes: 3 },
    builtAt: "2026-10-03T00:00:00.000Z",
    runtimeImages: { osrm: OSRM_IMAGE },
    toolImages: {},
  };
}

function seedOsrmBuild(root: string): void {
  const graph = join(dataDir(root), "osrm-graph");
  mkdirSync(join(graph, "region.osrm.cells.d"), { recursive: true });
  writeFileSync(join(graph, "region.osrm"), "GRAPH");
  for (const name of ["region.osrm.partition", "region.osrm.cells", "region.osrm.mldgr"])
    writeFileSync(join(graph, name), name);
  writeFileSync(join(graph, "region.osrm.cells.d", "part"), "CELLS");
  writeFileSync(join(graph, "segment-speeds.csv"), "");
  writeFileSync(join(graph, "region.osm.pbf"), "PBF");
  writeBuildRecord(osrmRecord(), root);
}

const noneRunning = async () => [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-build-artifacts-"));
  buildHost = makeHost("build");
  serveHost = makeHost("serve");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("build provenance", () => {
  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  const release: services.ReleaseManifest = {
    schemaVersion: 1,
    release: "abc123-1-1",
    images: {
      api: `ghcr.io/openmapx/api@${digest("a")}`,
      web: `ghcr.io/openmapx/web@${digest("b")}`,
      "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
      "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
      "privacy-backup": `ghcr.io/openmapx/privacy-backup@${digest("9")}`,
      "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
      "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
    },
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "2".repeat(64),
      validatedAt: "2026-09-05T12:00:00.000Z",
      checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
    },
  };

  function checkoutAtCommit(): string {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", buildHost, ...args], { encoding: "utf-8" }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    );
    return git("rev-parse", "HEAD");
  }

  it("records the checkout's commit and the selected release for a checkout's CLI", async () => {
    const commit = checkoutAtCommit();
    services.writeReleaseComposeArtifacts(release, join(buildHost, "infra", "docker"));

    await expect(buildProvenance(buildHost, { bundled: false })).resolves.toEqual({
      revision: commit,
      release: "abc123-1-1",
    });
  });

  it("records only the release for the operations agent's CLI, which is not the checkout's code", async () => {
    checkoutAtCommit();
    services.writeReleaseComposeArtifacts(release, join(buildHost, "infra", "docker"));

    await expect(buildProvenance(buildHost, { bundled: true })).resolves.toEqual({
      release: "abc123-1-1",
    });
  });

  it("records nothing it cannot read", async () => {
    await expect(buildProvenance(buildHost, { bundled: true })).resolves.toEqual({});
  });
});

describe("build bundles", () => {
  it.each(["import", "export"] as const)(
    "refuses a live target owner before CLI %s publication",
    async (action) => {
      seedOsrmBuild(buildHost);
      const bundle = join(tmp, "owned.tar");
      await exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "osrm",
        bundle,
        rootDir: buildHost,
      });
      const control = await import("@openmapx/core/build-artifacts"),
        ops = await import("@openmapx/core/ops");
      const targetHost = action === "import" ? serveHost : buildHost;
      const infraDir = join(targetHost, "infra/docker");
      await control.provisionControlInstallation(infraDir);
      const installation = control.openControlInstallation({
        infraDir,
        role: "host-cli",
        serviceIds: ["osrm", "motis"],
      });
      let lease: import("@openmapx/core/build-artifacts").TargetLeaseAuthority | undefined;
      try {
        const admittedAt = Date.now(),
          deadlineAt = admittedAt + 60000,
          operation = { kind: "service.build" as const, serviceId: "osrm" },
          operationFingerprint = ops.opsOperationFingerprint(operation),
          execution = {
            executor: "host-cli" as const,
            principal: "host-cli" as const,
            executionId: randomUUID(),
            operationKey: ops.createControlRootOperationKey({
              notAfter: deadlineAt,
              nonce: randomBytes(16),
            }),
            operationFingerprint,
            deadlineAt,
            fingerprint: ops.executionFingerprint({
              kind: operation.kind,
              operationFingerprint,
              deadlineAt,
            }),
          },
          authority = control.retainAdmittedControlExecution(installation, {
            execution,
            kind: operation.kind,
            operation,
            admittedAt,
            requestedDeadlineAt: deadlineAt,
            serviceIds: ["osrm"],
          });
        lease = await control.acquireArtifactTargetLease({
          dataRoot: dataDir(targetHost),
          serviceIds: ["osrm"],
          owner: authority,
        });
        await expect(
          action === "import"
            ? importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning })
            : exportBuildBundle({
                runningServices: noneRunning,
                serviceId: "osrm",
                bundle: join(tmp, "busy-export.tar"),
                rootDir: buildHost,
              }),
        ).rejects.toThrow(/busy|lease|owned/i);
        if (action === "import")
          expect(existsSync(join(dataDir(serveHost), "osrm-graph/region.osrm"))).toBe(false);
        else expect(existsSync(join(tmp, "busy-export.tar"))).toBe(false);
      } finally {
        if (lease) control.closeArtifactTargetLeaseHandle(lease);
        control.closeControlInstallation(installation);
      }
    },
    60000,
  );
  it("retains imported source provenance with fresh local output identities", async () => {
    seedOsrmBuild(buildHost);
    const { artifactFingerprint } = await import("@openmapx/core/build-artifacts");
    const initial = await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle: join(tmp, "first.tar"),
      rootDir: buildHost,
    });
    const sourceFingerprints = [{ id: "a".repeat(64), sha256: "b".repeat(64), sizeBytes: 3 }];
    writeBuildRecord(
      {
        ...osrmRecord(),
        schemaVersion: 2,
        sourceFingerprints,
        artifactFingerprint: artifactFingerprint(initial.files),
      },
      buildHost,
    );
    const path = join(tmp, "v2.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle: path,
      rootDir: buildHost,
    });
    await importBuildBundle({ bundle: path, rootDir: serveHost, runningServices: noneRunning });
    expect(readBuildRecord("osrm", serveHost)).toMatchObject({
      schemaVersion: 2,
      sourceFingerprints,
    });
    const evidence = JSON.parse(
      readFileSync(join(dataDir(serveHost), ".openmapx-builds/osrm.evidence.json"), "utf8"),
    );
    expect(evidence.record.sourceFingerprints).toEqual(sourceFingerprints);
    expect(
      evidence.files.find((file: { path: string }) => file.path === "osrm-graph/region.osrm"),
    ).toMatchObject({
      sizeBytes: 5,
      inode: String(lstatSync(join(dataDir(serveHost), "osrm-graph/region.osrm")).ino),
    });
  }, 60000);

  it("round-trips a build to another host, dropping staged inputs and recording provenance", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    const exported = await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle,
      rootDir: buildHost,
    });

    expect(exported.files.map((file) => file.path)).toEqual([
      "osrm-graph/region.osrm",
      "osrm-graph/region.osrm.cells",
      "osrm-graph/region.osrm.cells.d/part",
      "osrm-graph/region.osrm.mldgr",
      "osrm-graph/region.osrm.partition",
      "osrm-graph/segment-speeds.csv",
    ]);

    const liveGraph = join(dataDir(serveHost), "osrm-graph");
    mkdirSync(liveGraph, { recursive: true });
    writeFileSync(join(liveGraph, "region.osrm"), "OLD");

    const imported = await importBuildBundle({
      bundle,
      rootDir: serveHost,
      runningServices: noneRunning,
    });

    expect(imported.service).toBe("osrm");
    expect(readFileSync(join(liveGraph, "region.osrm"), "utf-8")).toBe("GRAPH");
    expect(readFileSync(join(liveGraph, "region.osrm.cells.d", "part"), "utf-8")).toBe("CELLS");
    expect(existsSync(join(liveGraph, "region.osm.pbf"))).toBe(false);
    expect(existsSync(join(dataDir(serveHost), ".openmapx-import"))).toBe(false);
    expect(readBuildRecord("osrm", serveHost)).toMatchObject({ ...osrmRecord(), schemaVersion: 2 });
  });

  it("refuses a bundle built for a different runtime image", async () => {
    seedOsrmBuild(buildHost);
    const otherServe = makeHost("serve-other", DIGEST_B);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle,
      rootDir: buildHost,
    });

    await expect(
      importBuildBundle({ bundle, rootDir: otherServe, runningServices: noneRunning }),
    ).rejects.toThrow(/different runtime images.*osrm/);
    expect(existsSync(join(dataDir(otherServe), "osrm-graph"))).toBe(false);
  });

  it("refuses to swap while a consumer is running", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle,
      rootDir: buildHost,
    });

    await expect(
      importBuildBundle({
        bundle,
        rootDir: serveHost,
        runningServices: async (ids) => ids.filter((id) => id === "osrm"),
      }),
    ).rejects.toThrow(/osrm is running/);
  });

  it("rejects a bundle whose contents no longer match its manifest", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle,
      rootDir: buildHost,
    });

    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xf", bundle, "-C", unpacked]);
    writeFileSync(join(unpacked, "osrm-graph", "region.osrm"), "TAMPERED");
    const tampered = join(tmp, "tampered.tar");
    execFileSync(
      "tar",
      ["--no-xattrs", "-cf", tampered, "-C", unpacked, BUNDLE_MANIFEST_DIR, "osrm-graph"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );

    await expect(
      importBuildBundle({ bundle: tampered, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/failed verification: osrm-graph\/region.osrm/);
  });

  it("rejects extra entries the manifest does not list", async () => {
    seedOsrmBuild(buildHost);
    const bundle = join(tmp, "osrm.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "osrm",
      bundle,
      rootDir: buildHost,
    });

    const unpacked = join(tmp, "unpacked");
    mkdirSync(unpacked);
    execFileSync("tar", ["-xf", bundle, "-C", unpacked]);
    writeFileSync(join(unpacked, "osrm-graph", "extra"), "X");
    const padded = join(tmp, "padded.tar");
    execFileSync(
      "tar",
      ["--no-xattrs", "-cf", padded, "-C", unpacked, BUNDLE_MANIFEST_DIR, "osrm-graph"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );

    await expect(
      importBuildBundle({ bundle: padded, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/does not list: osrm-graph\/extra/);
  });

  it("rejects a bundle whose artifact root is a symlink", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "region.osrm"), "X");
    const crafted = join(tmp, "crafted");
    mkdirSync(join(crafted, BUNDLE_MANIFEST_DIR), { recursive: true });
    writeFileSync(
      join(crafted, BUNDLE_MANIFEST_PATH),
      JSON.stringify({
        ...osrmRecord(),
        dirs: ["osrm-graph"],
        directories: ["osrm-graph"],
        files: [
          {
            path: "osrm-graph/region.osrm",
            sizeBytes: 1,
            sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
          },
        ],
      }),
    );
    symlinkSync(outside, join(crafted, "osrm-graph"));
    const bundle = join(tmp, "crafted.tar");
    execFileSync(
      "tar",
      ["--no-xattrs", "-cf", bundle, "-C", crafted, BUNDLE_MANIFEST_DIR, "osrm-graph"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );

    await expect(
      importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/Unsupported tar type/);
    expect(existsSync(join(dataDir(serveHost), "osrm-graph"))).toBe(false);
  });

  it("resolves a relative bundle path against the invoking directory", async () => {
    seedOsrmBuild(buildHost);
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = tmp;
    try {
      await exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "osrm",
        bundle: "relative.tar",
        rootDir: buildHost,
      });
      expect(existsSync(join(tmp, "relative.tar"))).toBe(true);
      await importBuildBundle({
        bundle: "relative.tar",
        rootDir: serveHost,
        runningServices: noneRunning,
      });
      expect(existsSync(join(dataDir(serveHost), "osrm-graph", "region.osrm"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previous;
    }
  });

  it("refuses to export MOTIS import output that no --import build vouches for", async () => {
    const data = dataDir(buildHost);
    mkdirSync(join(data, "motis", "live", "data"), { recursive: true });
    mkdirSync(join(data, "motis-feed-proxy"), { recursive: true });
    writeBuildRecord({ ...osrmRecord(), service: "motis", runtimeImages: {} }, buildHost);

    await expect(
      exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "motis",
        bundle: join(tmp, "m.tar"),
        rootDir: buildHost,
      }),
    ).rejects.toThrow(/without --import/);
  });

  it("requires a build record before exporting", async () => {
    mkdirSync(join(dataDir(buildHost), "osrm-graph"), { recursive: true });
    await expect(
      exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "osrm",
        bundle: join(tmp, "x.tar"),
        rootDir: buildHost,
      }),
    ).rejects.toThrow(/No build record for "osrm"/);
  });

  it("refuses symlinks inside an artifact", async () => {
    seedOsrmBuild(buildHost);
    symlinkSync("/etc/passwd", join(dataDir(buildHost), "osrm-graph", "link"));
    await expect(
      exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "osrm",
        bundle: join(tmp, "x.tar"),
        rootDir: buildHost,
      }),
    ).rejects.toThrow(/Refusing symlink in build artifact: osrm-graph\/link/);
  });

  it("requires rebuilding legacy MOTIS output before exporting generated credentials", async () => {
    const data = dataDir(buildHost);
    mkdirSync(join(data, "motis/slots/A/data"), { recursive: true });
    symlinkSync("slots/A", join(data, "motis/live"));
    mkdirSync(join(data, "motis-feed-proxy/conf"), { recursive: true });
    writeFileSync(join(data, "motis-feed-proxy/conf/default.conf"), "secret-api-key");
    writeBuildRecord(motisRecord(), buildHost);
    await expect(
      exportBuildBundle({
        runningServices: noneRunning,
        serviceId: "motis",
        bundle: join(tmp, "motis.tar"),
        rootDir: buildHost,
      }),
    ).rejects.toThrow(/retained portable source metadata/);
  });

  it("keeps the active MOTIS slot unchanged until target credential materialization exists", async () => {
    const source = dataDir(buildHost);
    mkdirSync(join(source, "motis/live/data"), { recursive: true });
    mkdirSync(join(source, "motis-feed-proxy"), { recursive: true });
    writeFileSync(join(source, "motis/live/data/tt.bin"), "NEW");
    writeFileSync(
      join(source, "motis/live/portable-sources.json"),
      JSON.stringify({ version: 1, sourceFingerprints: [], credentialRequirements: [] }),
    );
    writeBuildRecord(motisRecord(), buildHost);
    const bundle = join(tmp, "motis.tar");
    await exportBuildBundle({
      runningServices: noneRunning,
      serviceId: "motis",
      bundle,
      rootDir: buildHost,
    });
    const target = dataDir(serveHost);
    const slotA = join(target, "motis/slots/A");
    mkdirSync(join(slotA, "data"), { recursive: true });
    writeFileSync(join(slotA, "data/tt.bin"), "OLD");
    symlinkSync(slotA, join(target, "motis/live"));
    await expect(
      importBuildBundle({ bundle, rootDir: serveHost, runningServices: noneRunning }),
    ).rejects.toThrow(/generated destination configuration/);
    expect(lstatSync(join(target, "motis/live")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(slotA, "data/tt.bin"), "utf8")).toBe("OLD");
  });
});

it("validates the manifest before invoking any legacy extraction hook", async () => {
  const bundle = join(tmp, "invalid.tar");
  writeFileSync(bundle, Buffer.alloc(1024));
  let extracted = false;
  await expect(
    importBuildBundle({
      bundle,
      rootDir: serveHost,
      runningServices: noneRunning,
      tar: async () => {
        extracted = true;
      },
    }),
  ).rejects.toThrow();
  expect(extracted, "untrusted archive reached extract-first tar hook").toBe(false);
});
