import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { renderFeedProxyNginxConfig } from "@openmapx/motis-feed-proxy-config";
import { afterEach, expect, it, vi } from "vitest";
import { createCandidateManifest } from "../../../../services/data-manager/src/jobs/transitous/candidate";
import {
  inspectPortableMotisRecipe,
  type MotisPinnedBlobReader,
  materializePortableMotisCandidate,
  producePortableMotisRecipe,
  readVerifiedPortableMotisMaterialization,
} from "./motis-portable";

vi.mock("node:fs", async (original) => {
  const native = await original<typeof import("node:fs")>();
  return { ...native, renameSync: vi.fn(native.renameSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "omx-portable-motis-"));
  roots.push(value);
  return value;
};
const pins = { transitousCommit: "a".repeat(40), atlasCommit: "b".repeat(40) };
const credentials = { "de/demo": "SOURCE_PRIVATE_KEY" };
const destinationCredentials = { "de/demo": "DESTINATION_PRIVATE_KEY" };
const config = {
  server: { port: 8080 },
  timetable: {
    datasets: {
      "de-demo": {
        path: "de_demo.gtfs.zip",
        rt: [{ url: "http://motis-feed-proxy/feed/de-demo-0", protocol: "gtfsrt" }],
      },
    },
  },
};
const readBlob: MotisPinnedBlobReader = vi.fn(async (repo, _commit, path) => {
  if (repo === "catalog" && path === "configs/motis/config.yml")
    return JSON.stringify({ server: { port: 8080 }, timetable: { datasets: {} } });
  if (repo === "catalog" && path === "feeds/de.json")
    return JSON.stringify({
      sources: [{ name: "demo", type: "transitland-atlas", "transitland-atlas-id": "f-demo" }],
    });
  if (repo === "atlas" && path === "feeds/.openmapx-atlas-id/f-demo")
    return JSON.stringify({
      feeds: [
        {
          id: "f-demo",
          urls: {
            static_current: "https://operator.example/static.zip",
            realtime_trip_updates: "https://operator.example/realtime.pb",
          },
          authorization: { type: "header", param_name: "X-Api-Key" },
        },
      ],
    });
  throw Error("No pinned blob");
});
function fixture() {
  const dir = root(),
    vars = {
      "de-demo-0": {
        url: "https://operator.example/realtime.pb",
        headers: { "X-Api-Key": credentials["de/demo"] },
        gbfs: false,
      },
    };
  const files: Record<string, string> = {
    "config.yml": JSON.stringify(config),
    "license.json": "[]",
    "de_demo.gtfs.zip": "synthetic timetable",
    "transit-source-manifest.json": JSON.stringify({
      version: 1,
      generatedAt: "2026-10-30T00:00:00.000Z",
      sources: [
        {
          sourceId: "catalog:de:demo",
          region: "de",
          name: "demo",
          format: "gtfs",
          origin: "catalog",
          originUrl: "https://origin.example/static?key=[redacted]",
          license: {},
          transformations: [],
          artifact: {
            relativePath: "de_demo.gtfs.zip",
            sha256: createHash("sha256").update("synthetic timetable").digest("hex"),
            sizeBytes: 19,
            modifiedAt: "2026-10-30T00:00:00.000Z",
          },
        },
      ],
    }),
    ".openmapx-feed-proxy/feed-proxy-vars.json": JSON.stringify(vars),
    ".openmapx-feed-proxy/conf/default.conf": renderFeedProxyNginxConfig(vars),
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  createCandidateManifest(dir, "synthetic-epoch", "2026-10-30T00:00:00.000Z");
  return dir;
}
async function produce(dir = fixture()) {
  await producePortableMotisRecipe({ stagingDir: dir, pins, readBlob, credentials });
  return { dir, metadata: JSON.parse(readFileSync(join(dir, "portable-sources.json"), "utf8")) };
}
it.each([false, true])(
  "journal-publishes or restores a materialized bundle without changing MOTIS slot aliases (fault=%s)",
  async (fault) => {
    const control = await import("./index"),
      ops = await import("../ops"),
      publication = await import("./publication");
    const original = await produce(),
      exportRoot = root(),
      infraDir = root(),
      dataRoot = join(infraDir, "data");
    cpSync(original.dir, join(exportRoot, "motis/live"), { recursive: true });
    mkdirSync(join(exportRoot, "motis/live/data"));
    writeFileSync(join(exportRoot, "motis/live/data/tt.bin"), "compiled timetable");
    mkdirSync(join(exportRoot, "motis-feed-proxy"));
    const chunks: Buffer[] = [];
    await control.writeBuildBundle({
      dataRoot: exportRoot,
      serviceId: "motis",
      record: {
        schemaVersion: 1,
        service: "motis",
        builtAt: "2026-10-30T00:00:00.000Z",
        runtimeImages: { motis: "image:1" },
        toolImages: {},
      },
      target: new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
      }),
      limits: control.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: new AbortController().signal,
    });
    const stageId = randomUUID(),
      stagingRoot = join(dataRoot, `.openmapx-import-${stageId}`);
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const bundle = await control.validateBuildBundle({
      source: Readable.from([Buffer.concat(chunks)]),
      stagingRoot,
      limits: control.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: new AbortController().signal,
    });
    const { materialization } = await materializePortableMotisCandidate({
      archiveFingerprint: bundle.artifactFingerprint,
      stagingDir: join(stagingRoot, "motis/live"),
      recipe: original.metadata.recipe,
      pins,
      readBlob,
      credentials: destinationCredentials,
    });
    for (const slot of ["A", "B"]) {
      mkdirSync(join(dataRoot, "motis/slots", slot), { recursive: true });
      writeFileSync(join(dataRoot, "motis/slots", slot, "old"), slot);
    }
    symlinkSync("slots/A", join(dataRoot, "motis/live"));
    symlinkSync("slots/B", join(dataRoot, "motis/staging"));
    writeFileSync(
      join(dataRoot, "motis/slot-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeSlot: "A",
        previousHealthySlot: "B",
        datasetEpoch: "old",
        activatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    mkdirSync(join(dataRoot, "motis-feed-proxy/conf"), { recursive: true });
    writeFileSync(join(dataRoot, "motis-feed-proxy/conf/default.conf"), "old proxy");
    const aliases = ["live", "staging"].map((name) => ({
      name,
      inode: lstatSync(join(dataRoot, "motis", name)).ino,
      target: readlinkSync(join(dataRoot, "motis", name)),
    }));
    await control.provisionControlInstallation(infraDir);
    const ids = ["motis", "motis-feed-proxy", "motis-staging"],
      installation = control.openControlInstallation({
        infraDir,
        role: "host-cli",
        serviceIds: ids,
      });
    let lease: import("./target-lease").TargetLeaseAuthority | undefined;
    try {
      const admittedAt = Date.now(),
        deadlineAt = admittedAt + 300000,
        expectedFingerprint = await publication.artifactPublicationFingerprint(dataRoot, "motis"),
        operation = {
          kind: "artifactTransfer.import" as const,
          stageId,
          ownerId: "host-cli",
          expectedSha256: bundle.archiveSha256,
          previewFingerprint: "a".repeat(64),
          expectedCurrentRevisionId: null,
        },
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
          serviceIds: ids,
        });
      lease = await control.acquireArtifactTargetLease({
        dataRoot,
        serviceIds: ids,
        owner: authority,
      });
      const nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
      let injected = false;
      if (fault)
        vi.mocked(fs.renameSync).mockImplementation((from, to) => {
          if (
            !injected &&
            String(to).endsWith("/motis-feed-proxy") &&
            String(from).endsWith("/motis-feed-proxy")
          ) {
            injected = true;
            throw Error("Named proxy publication rename failure");
          }
          return nativeRename(from, to);
        });
      const result = await publication.publishValidatedBuild({
        dataRoot,
        stagingRoot,
        stageId,
        bundle,
        authority,
        lease,
        expectedFingerprint,
        materialization,
      });
      expect(result.outcome).toBe(fault ? "not_committed" : "committed");
      if (fault) {
        expect(injected).toBe(true);
        expect(readFileSync(join(dataRoot, "motis/live/old"), "utf8")).toBe("A");
        expect(readFileSync(join(dataRoot, "motis-feed-proxy/conf/default.conf"), "utf8")).toBe(
          "old proxy",
        );
        expect(
          JSON.parse(readFileSync(join(dataRoot, "motis/slot-state.json"), "utf8")),
        ).toMatchObject({ datasetEpoch: "old", activatedAt: "2026-01-01T00:00:00.000Z" });
      }
      for (const alias of aliases) {
        expect(lstatSync(join(dataRoot, "motis", alias.name)).ino).toBe(alias.inode);
        expect(readlinkSync(join(dataRoot, "motis", alias.name))).toBe(alias.target);
      }
      if (fault) return;
      expect(readFileSync(join(dataRoot, "motis/live/data/tt.bin"), "utf8")).toBe(
        "compiled timetable",
      );
      expect(readFileSync(join(dataRoot, "motis-feed-proxy/conf/default.conf"), "utf8")).toContain(
        "DESTINATION_PRIVATE_KEY",
      );
      expect(
        JSON.parse(readFileSync(join(dataRoot, "motis/slot-state.json"), "utf8")),
      ).toMatchObject({
        activeSlot: "A",
        previousHealthySlot: "B",
        datasetEpoch: "synthetic-epoch",
      });
      expect(
        JSON.parse(readFileSync(join(dataRoot, "motis/slot-state.json"), "utf8")),
      ).not.toHaveProperty("activatedAt");
    } finally {
      if (lease) control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(installation);
    }
  },
  60000,
);
function extract(data: Awaited<ReturnType<typeof produce>>) {
  const dest = root();
  for (const path of ["license.json", "de_demo.gtfs.zip", "portable-sources.json"])
    writeFileSync(join(dest, path), readFileSync(join(data.dir, path)));
  return dest;
}
it("produces the actual candidate's nonsecret recipe and materializes different destination credentials offline", async () => {
  const source = await produce(),
    serialized = JSON.stringify(source.metadata);
  expect(serialized).not.toContain("SOURCE_PRIVATE_KEY");
  expect(serialized).not.toContain("operator.example/realtime");
  expect(serialized).not.toContain("originUrl");
  expect(source.metadata.credentialRequirements).toEqual(["de/demo"]);
  const destination = extract(source),
    { manifest } = await materializePortableMotisCandidate({
      archiveFingerprint: "d".repeat(64),
      stagingDir: destination,
      recipe: source.metadata.recipe,
      pins,
      readBlob,
      credentials: destinationCredentials,
    });
  expect(
    readFileSync(join(destination, ".openmapx-feed-proxy/feed-proxy-vars.json"), "utf8"),
  ).toContain("DESTINATION_PRIVATE_KEY");
  expect(
    readFileSync(join(destination, ".openmapx-feed-proxy/conf/default.conf"), "utf8"),
  ).toContain("https://operator.example/realtime.pb");
  expect(manifest.epoch).toBe("synthetic-epoch");
  expect(manifest.expectations.realtimeFeeds).toBe(1);
  expect(readFileSync(join(destination, "config.yml"), "utf8")).not.toContain("PRIVATE_KEY");
});
it("rejects a missing destination credential without publishing candidate config", async () => {
  const source = await produce(),
    destination = extract(source);
  await expect(
    materializePortableMotisCandidate({
      archiveFingerprint: "d".repeat(64),
      stagingDir: destination,
      recipe: source.metadata.recipe,
      pins,
      readBlob,
      credentials: {},
    }),
  ).rejects.toThrow("credential is missing");
  expect(() => readFileSync(join(destination, "config.yml"))).toThrow();
});
it("binds selectors to the destination's approved catalog pair", async () => {
  const source = await produce();
  await expect(
    inspectPortableMotisRecipe({
      recipe: source.metadata.recipe,
      pins: { ...pins, atlasCommit: "c".repeat(40) },
      readBlob,
    }),
  ).rejects.toThrow("pins");
});
it("refuses attacker-selected endpoint metadata and config exfiltration before inserting target keys", async () => {
  const source = await produce();
  source.metadata.recipe.routes[0].url = "https://attacker.example";
  await expect(
    inspectPortableMotisRecipe({ recipe: source.metadata.recipe, pins, readBlob }),
  ).rejects.toThrow();
  delete source.metadata.recipe.routes[0].url;
  const altered = JSON.stringify({ ...config, elevators: { url: "https://attacker.example" } });
  source.metadata.recipe.config = altered;
  source.metadata.recipe.configSha256 = createHash("sha256").update(altered).digest("hex");
  await expect(
    inspectPortableMotisRecipe({ recipe: source.metadata.recipe, pins, readBlob }),
  ).rejects.toThrow();
});
it("refuses a changed compiled source before writing a destination config", async () => {
  const source = await produce(),
    destination = extract(source);
  writeFileSync(join(destination, "de_demo.gtfs.zip"), "changed");
  await expect(
    materializePortableMotisCandidate({
      archiveFingerprint: "d".repeat(64),
      stagingDir: destination,
      recipe: source.metadata.recipe,
      pins,
      readBlob,
      credentials: destinationCredentials,
    }),
  ).rejects.toThrow("integrity");
  expect(() => readFileSync(join(destination, "config.yml"))).toThrow();
});
it.each(["headers", "secret URL", "unbound endpoint", "oversized"])(
  "does not retain an unsafe %s recipe from the producer",
  async (kind) => {
    const dir = fixture();
    if (kind === "headers")
      writeFileSync(
        join(dir, "config.yml"),
        JSON.stringify({ ...config, elevators: { headers: { Authorization: "HOST_SECRET" } } }),
      );
    if (kind === "secret URL")
      writeFileSync(
        join(dir, "config.yml"),
        JSON.stringify({ ...config, elevators: { url: "https://host.example/?key=HOST_SECRET" } }),
      );
    if (kind === "unbound endpoint")
      writeFileSync(
        join(dir, ".openmapx-feed-proxy/feed-proxy-vars.json"),
        JSON.stringify({
          "de-demo-0": {
            url: "https://attacker.example/rt",
            headers: { "X-Api-Key": credentials["de/demo"] },
          },
        }),
      );
    if (kind === "oversized")
      writeFileSync(
        join(dir, "config.yml"),
        JSON.stringify({ ...config, note: " ".repeat(1024 * 1024 + 1) }),
      );
    createCandidateManifest(dir, "synthetic-epoch", "2026-10-30T00:00:00.000Z");
    await expect(
      producePortableMotisRecipe({ stagingDir: dir, pins, readBlob, credentials }),
    ).rejects.toThrow();
    expect(() => readFileSync(join(dir, "portable-sources.json"))).toThrow();
  },
);
it("honors cancellation before offline destination writes", async () => {
  const source = await produce(),
    destination = extract(source),
    controller = new AbortController();
  controller.abort();
  await expect(
    materializePortableMotisCandidate({
      archiveFingerprint: "d".repeat(64),
      stagingDir: destination,
      recipe: source.metadata.recipe,
      pins,
      readBlob,
      credentials: destinationCredentials,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(() => readFileSync(join(destination, "config.yml"))).toThrow();
});

it("binds the nominal proof to the original archive, metadata and exact generated bytes", async () => {
  const source = await produce(),
    destination = extract(source);
  const result = await materializePortableMotisCandidate({
    archiveFingerprint: "d".repeat(64),
    stagingDir: destination,
    recipe: source.metadata.recipe,
    pins,
    readBlob,
    credentials: destinationCredentials,
  });
  const metadataSha = createHash("sha256")
    .update(readFileSync(join(destination, "portable-sources.json")))
    .digest("hex");
  const args = {
    stagingDir: destination,
    archiveFingerprint: "d".repeat(64),
    portableMetadataSha256: metadataSha,
  };
  const proof = await readVerifiedPortableMotisMaterialization(result.materialization, args);
  expect(proof.generatedArtifacts.map((f) => f.path)).toContain("config.yml");
  expect(proof.generatedArtifacts.map((f) => f.path)).toContain(
    ".openmapx-feed-proxy/feed-proxy-vars.json",
  );
  await expect(
    readVerifiedPortableMotisMaterialization(result.materialization, {
      ...args,
      archiveFingerprint: "e".repeat(64),
    }),
  ).rejects.toThrow("archive");
  writeFileSync(join(destination, ".openmapx-feed-proxy/feed-proxy-vars.json"), "{}");
  await expect(
    readVerifiedPortableMotisMaterialization(result.materialization, args),
  ).rejects.toThrow();
});
it("rejects a bundle-selected web directory even after the attacker updates its config digest", async () => {
  const source = await produce(),
    recipe = source.metadata.recipe;
  const changed = JSON.stringify({
    ...config,
    server: { port: 8080, web_folder: ".openmapx-feed-proxy" },
  });
  recipe.config = changed;
  recipe.configSha256 = createHash("sha256").update(changed).digest("hex");
  await expect(inspectPortableMotisRecipe({ recipe, pins, readBlob })).rejects.toThrow(
    "approved pinned template",
  );
});
it.each(["userinfo", "query", "header", "source inventory", "template digest", "config digest"])(
  "rejects unsafe %s before target secret materialization",
  async (kind) => {
    const source = await produce(),
      recipe = source.metadata.recipe;
    if (kind === "header") {
      const cfg = JSON.parse(recipe.config);
      cfg.timetable.datasets["de-demo"].rt[0].headers = { Authorization: "BUNDLE_SECRET" };
      recipe.config = JSON.stringify(cfg);
      recipe.configSha256 = createHash("sha256").update(recipe.config).digest("hex");
    }
    if (kind === "source inventory")
      recipe.sourceManifest.sources[0].artifact.sha256 = "f".repeat(64);
    if (kind === "template digest") recipe.templateSha256 = "e".repeat(64);
    if (kind === "config digest") recipe.configSha256 = "e".repeat(64);
    const selected: MotisPinnedBlobReader = async (repo, commit, path) => {
      const text = await readBlob(repo, commit, path);
      if (repo !== "atlas" || !["userinfo", "query"].includes(kind)) return text;
      const value = JSON.parse(text);
      value.feeds[0].urls.realtime_trip_updates =
        kind === "userinfo"
          ? "https://secret@operator.example/realtime.pb"
          : "https://operator.example/realtime.pb?token=secret";
      return JSON.stringify(value);
    };
    await expect(
      inspectPortableMotisRecipe({ recipe, pins, readBlob: selected }),
    ).rejects.toThrow();
  },
);
