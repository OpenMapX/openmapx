import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function tarMember(name: string, bytes = Buffer.alloc(0), type = "0", size = bytes.length): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    `${[...header]
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
  );
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const payload = Buffer.from("GRAPH");
const fixtureManifest = () => ({
  schemaVersion: 1,
  service: "osrm",
  builtAt: "2026-10-23T00:00:00.000Z",
  runtimeImages: { osrm: "image:1" },
  toolImages: {},
  dirs: ["osrm-graph"],
  directories: ["osrm-graph"],
  files: [{ path: "osrm-graph/region.osrm", sizeBytes: payload.length, sha256: sha(payload) }],
});
function archiveFixture(members?: Buffer[], manifest = fixtureManifest()): Buffer {
  return Buffer.concat([
    tarMember(".openmapx-bundle/manifest.json", Buffer.from(JSON.stringify(manifest))),
    ...(members ?? [
      tarMember("osrm-graph/", Buffer.alloc(0), "5"),
      tarMember("osrm-graph/region.osrm", payload),
    ]),
    Buffer.alloc(1024),
  ]);
}
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-archive-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function validate(bytes: Buffer, overrides = {}) {
  const sourcePath = join(import.meta.dirname, "archive.ts");
  expect(existsSync(sourcePath), "missing shared bounded archive validation").toBe(true);
  const api = await import("./archive");
  const stagingRoot = join(root, "stage");
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  return api.validateBuildBundle({
    source: Readable.from([bytes]),
    stagingRoot,
    limits: { ...api.DEFAULT_ARTIFACT_ARCHIVE_LIMITS, ...overrides },
    signal: new AbortController().signal,
  });
}
describe("bounded build archive", () => {
  it("reserves exact validated manifest capacity before creating any payload", async () => {
    const api = await import("./archive"),
      stagingRoot = join(root, "reserved-stage");
    mkdirSync(stagingRoot, { mode: 0o700 });
    let observed: unknown;
    await expect(
      api.validateBuildBundle({
        source: Readable.from([archiveFixture()]),
        stagingRoot,
        limits: api.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
        signal: new AbortController().signal,
        reservePayload: (reservation) => {
          observed = reservation;
          throw Error("Insufficient reserved capacity");
        },
      }),
    ).rejects.toThrow("Insufficient reserved capacity");
    expect(observed).toEqual({
      expandedBytes: payload.length,
      entries: 3,
      manifestBytes: Buffer.byteLength(JSON.stringify(fixtureManifest())),
    });
    expect(existsSync(join(stagingRoot, "osrm-graph"))).toBe(false);
  });
  it("does not extract after cancellation while waiting for manifest capacity", async () => {
    const api = await import("./archive"),
      stagingRoot = join(root, "canceled-reservation"),
      controller = new AbortController();
    mkdirSync(stagingRoot, { mode: 0o700 });
    await expect(
      api.validateBuildBundle({
        source: Readable.from([archiveFixture()]),
        stagingRoot,
        limits: api.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
        signal: controller.signal,
        reservePayload: async () => {
          controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(join(stagingRoot, "osrm-graph"))).toBe(false);
  });

  it.each([false, true])("streams safe v1 bytes from plain/gzip (%s) tar", async (gzip) => {
    const bytes = gzip ? gzipSync(archiveFixture()) : archiveFixture();
    const result = await validate(bytes);
    expect(result.archiveSha256).toBe(sha(bytes));
    expect(result.expandedBytes).toBe(5);
    expect(readFileSync(join(root, "stage/osrm-graph/region.osrm"), "utf8")).toBe("GRAPH");
  });
  it.each(["../escape", "/escape", "C:/escape", "osrm-graph\\escape", "osrm-graph/../escape"])(
    "rejects unsafe path %s before write",
    async (name) => {
      await expect(validate(archiveFixture([tarMember(name, payload)]))).rejects.toThrow(
        /path|member|artifact/,
      );
      expect(existsSync(join(root, "escape"))).toBe(false);
    },
  );
  it.each(["1", "2", "3", "4", "6", "S"])("rejects link/device/sparse type %s", async (type) => {
    await expect(
      validate(archiveFixture([tarMember("osrm-graph/region.osrm", payload, type)])),
    ).rejects.toThrow(/type|link|sparse/);
    expect(existsSync(join(root, "stage/osrm-graph/region.osrm"))).toBe(false);
  });
  it("rejects duplicate directory spellings", async () => {
    await expect(
      validate(
        archiveFixture([
          tarMember("osrm-graph", Buffer.alloc(0), "5"),
          tarMember("osrm-graph/", Buffer.alloc(0), "5"),
        ]),
      ),
    ).rejects.toThrow(/duplicate/i);
  });
  it("rejects missing and extra members", async () => {
    await expect(validate(archiveFixture([]))).rejects.toThrow(/missing/i);
    await expect(
      validate(archiveFixture([tarMember("osrm-graph/extra", payload)])),
    ).rejects.toThrow(/does not list/);
  });
  it("checks metadata sizes before opening payload", async () => {
    await expect(
      validate(archiveFixture([tarMember("osrm-graph/region.osrm", payload, "0", 100)])),
    ).rejects.toThrow(/verification|size/);
    expect(existsSync(join(root, "stage/osrm-graph/region.osrm"))).toBe(false);
  });
  it("bounds extended headers before reading them", async () => {
    await expect(
      validate(archiveFixture([tarMember("PaxHeader", Buffer.alloc(0), "x", 16385)])),
    ).rejects.toThrow(/extended|header/);
  });
  it("rejects changed bytes, truncated EOF and nonzero trailing structure", async () => {
    await expect(
      validate(archiveFixture([tarMember("osrm-graph/region.osrm", Buffer.from("OTHER"))])),
    ).rejects.toThrow(/verification/);
    await expect(validate(archiveFixture().subarray(0, -512))).rejects.toThrow(
      /EOF|truncated|terminator/,
    );
    await expect(validate(Buffer.concat([archiveFixture(), Buffer.from("extra")]))).rejects.toThrow(
      /trailing/,
    );
  });
  it("enforces actual expansion and single gzip member", async () => {
    await expect(validate(gzipSync(archiveFixture()), { maxExpandedBytes: 4 })).rejects.toThrow(
      /expanded|limit|budget/,
    );
    await expect(
      validate(Buffer.concat([gzipSync(archiveFixture()), gzipSync(Buffer.alloc(0))])),
    ).rejects.toThrow(/gzip|trailing|concatenated/);
  });
});

it("exports a sanitized MOTIS candidate with credential IDs and no generated runtime credentials", async () => {
  const { writeBuildBundle, DEFAULT_ARTIFACT_ARCHIVE_LIMITS } = await import("./archive");
  const { Writable } = await import("node:stream");
  const { writeFileSync, symlinkSync } = await import("node:fs");
  const data = join(root, "data");
  mkdirSync(join(data, "motis/slots/A/data"), { recursive: true });
  mkdirSync(join(data, "motis-feed-proxy/conf"), { recursive: true });
  symlinkSync("slots/A", join(data, "motis/live"));
  writeFileSync(join(data, "motis/slots/A/data/tt.bin"), "TT");
  writeFileSync(join(data, "motis/slots/A/license.json"), '{"license":"synthetic-public"}');
  writeFileSync(join(root, "acquired.gtfs.zip"), "synthetic acquired timetable");
  linkSync(join(root, "acquired.gtfs.zip"), join(data, "motis/slots/A/de_feed.gtfs.zip"));
  writeFileSync(join(data, "motis/slots/A/config.yml"), "secret-api-key");
  writeFileSync(join(data, "motis-feed-proxy/feed-proxy-vars.json"), "secret-api-key");
  writeFileSync(join(data, "motis-feed-proxy/conf/default.conf"), "secret-api-key");
  writeFileSync(
    join(data, "motis/slots/A/portable-sources.json"),
    JSON.stringify({
      version: 1,
      sourceFingerprints: [],
      credentialRequirements: ["synthetic-feed"],
    }),
  );
  const chunks: Buffer[] = [];
  const target = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const result = await writeBuildBundle({
    dataRoot: data,
    serviceId: "motis",
    record: {
      schemaVersion: 1,
      service: "motis",
      builtAt: "2026-10-23T00:00:00.000Z",
      runtimeImages: { motis: "image:1" },
      toolImages: {},
    },
    target,
    limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  expect(result.manifest).toMatchObject({
    schemaVersion: 2,
    credentialRequirements: ["synthetic-feed"],
    runtimeMaterialization: "motis-target-credentials",
  });
  expect(Buffer.concat(chunks).includes(Buffer.from("secret-api-key"))).toBe(false);
  expect(result.manifest.files.map((file) => file.path)).toContain("motis/live/license.json");
  expect(result.manifest.files.map((file) => file.path)).toContain("motis/live/de_feed.gtfs.zip");
  const validated = await validate(Buffer.concat(chunks));
  expect(validated.artifactFingerprint).toBe(result.artifactFingerprint);
});
it.each(["tileserver", "osrm", "otp", "pelias", "motis"])(
  "round-trips the portable %s layout on the real filesystem",
  async (service) => {
    const { writeBuildBundle, DEFAULT_ARTIFACT_ARCHIVE_LIMITS } = await import("./archive");
    const { Writable } = await import("node:stream");
    const { writeFileSync } = await import("node:fs");
    const dirs: Record<string, string[]> = {
      tileserver: ["tile-mbtiles"],
      osrm: ["osrm-graph"],
      otp: ["otp-graph"],
      pelias: ["pelias"],
      motis: ["motis/live/data", "motis-feed-proxy"],
    };
    const data = join(root, "data");
    const serviceDirs = dirs[service];
    if (!serviceDirs?.[0]) throw Error("Missing fixture artifact directory");
    for (const dir of serviceDirs) mkdirSync(join(data, dir), { recursive: true });
    writeFileSync(join(data, serviceDirs[0], "artifact.bin"), "DATA");
    if (service === "motis")
      writeFileSync(
        join(data, "motis/live/portable-sources.json"),
        JSON.stringify({ version: 1, sourceFingerprints: [], credentialRequirements: [] }),
      );
    const chunks: Buffer[] = [];
    const result = await writeBuildBundle({
      dataRoot: data,
      serviceId: service,
      record: {
        schemaVersion: 1,
        service,
        builtAt: "2026-10-23T00:00:00.000Z",
        runtimeImages: { [service]: "image:1" },
        toolImages: {},
      },
      target: new Writable({
        write(b, _e, done) {
          chunks.push(Buffer.from(b));
          done();
        },
      }),
      limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: new AbortController().signal,
    });
    const checked = await validate(gzipSync(Buffer.concat(chunks)));
    expect(checked.manifest.service).toBe(service);
    expect(checked.artifactFingerprint).toBe(result.artifactFingerprint);
  },
);
it("rejects effective PAX escape/size and sparse metadata before payload", async () => {
  function paxRecord(key: string, value: string) {
    const tail = ` ${key}=${value}\n`;
    let size = tail.length + 1;
    while (size !== tail.length + String(size).length) size = tail.length + String(size).length;
    return Buffer.from(`${size}${tail}`);
  }
  for (const [key, value] of [
    ["path", "../escape"],
    ["size", "-1"],
    ["GNU.sparse.size", "5"],
  ])
    await expect(
      validate(
        archiveFixture([
          tarMember("PaxHeader", paxRecord(key!, value!), "x"),
          tarMember("osrm-graph/region.osrm", payload),
        ]),
      ),
    ).rejects.toThrow(/path|size|sparse|PAX/);
  expect(existsSync(join(root, "escape"))).toBe(false);
});
it("rejects expansion-ratio overflow and corrupt compression", async () => {
  await expect(
    validate(gzipSync(archiveFixture()), { maxExpansionRatio: 1, expansionRatioThresholdBytes: 1 }),
  ).rejects.toThrow(/ratio/);
  const corrupt = gzipSync(archiveFixture());
  corrupt[corrupt.length - 8] ^= 0xff;
  await expect(validate(corrupt)).rejects.toThrow(/gzip|checksum/);
});

it("validates fragmented tar trailing blocks independently of input chunk boundaries", async () => {
  const a = await import("./archive");
  const bytes = Buffer.concat([archiveFixture(), Buffer.alloc(1024)]);
  mkdirSync(join(root, "stage"), { mode: 0o700 });
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 137) chunks.push(bytes.subarray(i, i + 137));
  await expect(
    a.validateBuildBundle({
      source: Readable.from(chunks),
      stagingRoot: join(root, "stage"),
      limits: a.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ expandedBytes: 5 });
});
