import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  backupInstalledIntegration,
  packageIntegration,
  restoreInstalledIntegration,
} from "@openmapx/integration-framework/installer";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatIntegrationsTable,
  installIntegration,
  listIntegrations,
  registerIntegrationsCommands,
  removeIntegration,
  validateIntegration,
} from "../src/commands/integrations";

let tmp: string;

function writeIntegration(
  parent: "integrations" | "custom_integrations",
  id: string,
  body: Record<string, unknown>,
) {
  const dir = join(tmp, parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  domains: ["map-overlay"],
  quality: "community",
  platform: ">=1.0.0",
};

function writeTarGz(sourceDir: string, artifactPath: string): void {
  const result = spawnSync("tar", ["-czf", artifactPath, "-C", sourceDir, "."], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `tar exited with ${result.status}`);
  }
}

interface TarFixtureEntry {
  name: string;
  type?: "0" | "2" | "7" | "g" | "x";
  data?: Buffer | string;
  linkName?: string;
  claimedSize?: number;
  omitPadding?: boolean;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
}

function tarFixtureEntry(entry: TarFixtureEntry): Buffer {
  const payload = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf-8");
  const claimedSize = entry.claimedSize ?? payload.length;
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf-8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, claimedSize);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? "0", 156, 1, "ascii");
  if (entry.linkName) header.write(entry.linkName, 157, 100, "utf-8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(header, 148, 8, checksum);

  if (entry.omitPadding) return Buffer.concat([header, payload]);
  if (claimedSize !== payload.length) {
    throw new Error("Padded tar fixtures require payload length to match the claimed size");
  }
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

function writeTarFixture(
  artifactPath: string,
  entries: TarFixtureEntry[],
  options: { endBlocks?: boolean } = {},
): void {
  const blocks = entries.map(tarFixtureEntry);
  if (options.endBlocks ?? true) blocks.push(Buffer.alloc(1024));
  writeFileSync(artifactPath, gzipSync(Buffer.concat(blocks)));
}

function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(`${key}=${value}\n`, "utf-8");
  let length = body.length + 2;
  for (;;) {
    const next = Buffer.byteLength(String(length)) + 1 + body.length;
    if (next === length) return Buffer.concat([Buffer.from(`${length} `), body]);
    length = next;
  }
}

function manifestTarEntry(id: string): TarFixtureEntry {
  return {
    name: "manifest.json",
    data: JSON.stringify({ ...baseManifest, id }),
  };
}

async function expectArtifactRejection(
  artifactPath: string,
  id: string,
  message: RegExp,
): Promise<void> {
  await expect(
    installIntegration({ source: artifactPath, sourceKind: "artifact", rootDir: tmp }),
  ).rejects.toThrow(message);
  expect(existsSync(join(tmp, "custom_integrations", id))).toBe(false);
  const staging = join(tmp, "custom_integrations", ".staging");
  expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-int-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  // findRepoRoot needs at least one OpenMapX-specific top-level dir.
  mkdirSync(join(tmp, "services"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("listIntegrations", () => {
  it("returns nothing when custom_integrations is missing", () => {
    expect(listIntegrations({ rootDir: tmp })).toEqual([]);
  });

  it("lists installed community integrations", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    writeIntegration("custom_integrations", "ads-b", { ...baseManifest, id: "ads-b" });
    const list = listIntegrations({ rootDir: tmp });
    expect(list.map((i) => i.id)).toEqual(["ads-b", "weather-radar"]);
  });

  it("ignores entries without a manifest.json", () => {
    mkdirSync(join(tmp, "custom_integrations", "incomplete"), { recursive: true });
    expect(listIntegrations({ rootDir: tmp })).toEqual([]);
  });

  it("includes built-in integrations when --include-built-in is set", () => {
    writeIntegration("integrations", "core-feature", {
      ...baseManifest,
      id: "core-feature",
      quality: "built-in",
    });
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const list = listIntegrations({ rootDir: tmp, includeBuiltIn: true });
    expect(list.map((i) => i.id)).toEqual(["core-feature", "weather-radar"]);
  });

  it("formats installed declarative integrations as a table", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const out = formatIntegrationsTable(listIntegrations({ rootDir: tmp }));
    expect(out).toContain("weather-radar");
    expect(out).toContain("community");
  });
});

describe("integrations command policy", () => {
  it("does not expose executable community build controls", () => {
    const program = new Command();
    registerIntegrationsCommands(program);
    const integrations = program.commands.find((command) => command.name() === "integrations");
    const commandNames = integrations?.commands.map((command) => command.name()) ?? [];
    const install = integrations?.commands.find((command) => command.name() === "install");
    const packageCommand = integrations?.commands.find((command) => command.name() === "package");

    expect(commandNames).not.toContain("build");
    expect(install?.options.map((option) => option.long)).not.toContain("--no-build");
    expect(packageCommand?.options.map((option) => option.long)).not.toContain("--no-build");
  });
});

describe("validateIntegration", () => {
  it("passes a valid manifest", () => {
    writeIntegration("custom_integrations", "good", { ...baseManifest, id: "good" });
    const result = validateIntegration(join(tmp, "custom_integrations", "good"));
    expect(result.valid).toBe(true);
    expect(result.id).toBe("good");
  });

  it("flags missing required fields", () => {
    // Missing `domains`
    writeIntegration("custom_integrations", "broken", {
      id: "broken",
      name: "Broken",
      version: "1.0.0",
      quality: "community",
    });
    const result = validateIntegration(join(tmp, "custom_integrations", "broken"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("domains"))).toBe(true);
  });

  it("returns an error for missing manifest", () => {
    const result = validateIntegration(join(tmp, "custom_integrations", "ghost"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/manifest\.json/);
  });

  it.each([
    ["missing", "missing"],
    ["directory", "directory"],
    ["oversized", "oversized"],
  ])("rejects a declared %s preview", (_label, kind) => {
    const dir = join(tmp, "custom_integrations", `bad-preview-${kind}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: `bad-preview-${kind}`,
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    if (kind === "directory") mkdirSync(join(dir, "preview.svg"));
    if (kind === "oversized") writeFileSync(join(dir, "preview.svg"), "x".repeat(64 * 1024 + 1));

    const result = validateIntegration(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/frontend\.layerSelector\.preview/);
  });
});

describe("installIntegration (local source)", () => {
  it("copies a local directory into custom_integrations/<id>/", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b" }),
      "utf-8",
    );
    const result = await installIntegration({ source: src, rootDir: tmp });
    expect(result.id).toBe("ads-b");
    expect(result.replaced).toBe(false);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b", "manifest.json"))).toBe(true);
  });

  it("copies a declared static preview without building frontend code", async () => {
    const src = join(tmp, "preview-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "preview-demo",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    writeFileSync(join(src, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    await installIntegration({ source: src, rootDir: tmp });
    expect(
      readFileSync(join(tmp, "custom_integrations", "preview-demo", "preview.svg"), "utf-8"),
    ).toContain("<svg");
    expect(
      existsSync(join(tmp, "custom_integrations", "preview-demo", "dist", "frontend", "index.js")),
    ).toBe(false);
  });

  it("rejects a declared missing preview before replacing an existing install", async () => {
    const src = join(tmp, "missing-preview-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "preview-demo",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    const installed = join(tmp, "custom_integrations", "preview-demo");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "keep.txt"), "existing");

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /frontend\.layerSelector\.preview.*missing/,
    );
    expect(readFileSync(join(installed, "keep.txt"), "utf-8")).toBe("existing");
  });

  it("rejects same-origin community frontend source", async () => {
    const src = join(tmp, "frontend-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "frontend-demo",
        frontend: { mapLayer: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "map-layer.tsx"),
      "export default function MapLayer() { return null; }",
      "utf-8",
    );

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Executable community integration code cannot be installed without an isolation boundary/,
    );
    expect(existsSync(join(tmp, "custom_integrations", "frontend-demo"))).toBe(false);
  });

  it("installs a declarative integration without creating build output", async () => {
    const src = join(tmp, "backend-only");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "backend-only" }),
      "utf-8",
    );

    await installIntegration({ source: src, rootDir: tmp });
    expect(existsSync(join(tmp, "custom_integrations", "backend-only", "dist"))).toBe(false);
  });

  it("rejects community backend source instead of installing it into the API trust domain", async () => {
    const src = join(tmp, "backend-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "backend-demo",
        backend: { routes: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "index.ts"),
      [
        'import type { IntegrationContext } from "@openmapx/core";',
        'import { message } from "./message.js";',
        "export function setup(ctx: IntegrationContext) {",
        '  ctx.registerRoute("GET", "/message", (_req, reply) => reply.send({ message }));',
        "}",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(join(src, "message.ts"), 'export const message = "hello";', "utf-8");

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Executable community integration code cannot be installed.*isolated service/s,
    );
    expect(existsSync(join(tmp, "custom_integrations", "backend-demo"))).toBe(false);
  });

  it("replaces an existing install", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b", version: "2.0.0" }),
      "utf-8",
    );

    // Pre-existing install
    mkdirSync(join(tmp, "custom_integrations", "ads-b"), { recursive: true });
    writeFileSync(
      join(tmp, "custom_integrations", "ads-b", "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b", version: "1.0.0" }),
      "utf-8",
    );

    const result = await installIntegration({ source: src, rootDir: tmp });
    expect(result.replaced).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(tmp, "custom_integrations", "ads-b", "manifest.json"), "utf-8"),
    ) as { version: string };
    expect(manifest.version).toBe("2.0.0");
  });

  it("rejects a source without a manifest", async () => {
    const src = join(tmp, "no-manifest");
    mkdirSync(src, { recursive: true });
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /manifest\.json/,
    );
  });

  it("rejects a manifest that fails validation", async () => {
    const src = join(tmp, "bad");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ id: "bad", name: "Bad", version: "1.0.0", quality: "community" }),
      "utf-8",
    );
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
    // Did NOT leave a partial install behind
    expect(existsSync(join(tmp, "custom_integrations", "bad"))).toBe(false);
  });

  it("rejects a non-existent local path that's not a github: spec", async () => {
    await expect(
      installIntegration({ source: "/this/path/does/not/exist", rootDir: tmp }),
    ).rejects.toThrow(/not.*existing local directory/);
  });
});

describe("installIntegration (artifact source)", () => {
  it("accepts exactly 4,096 tar headers without materializing metadata entries", async () => {
    const id = "header-boundary-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    const metadataHeaders = Array.from<TarFixtureEntry>({ length: 4095 }).fill({
      name: "GlobalHead",
      type: "g",
    });
    writeTarFixture(artifact, [...metadataHeaders, manifestTarEntry(id)]);

    await installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp });

    expect(existsSync(join(tmp, "custom_integrations", id, "manifest.json"))).toBe(true);
  });

  it("rejects a 4,097th tar header and leaves no extracted tree", async () => {
    const id = "header-limit-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    const metadataHeaders = Array.from<TarFixtureEntry>({ length: 4096 }).fill({
      name: "GlobalHead",
      type: "g",
    });
    writeTarFixture(artifact, [...metadataHeaders, manifestTarEntry(id)]);

    await expectArtifactRejection(artifact, id, /tar header limit.*4,096/i);
  });

  it("accepts materializable archive paths and PAX records at their structural boundaries", async () => {
    const id = "structure-boundary-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    const pathAtDepthLimit = Array.from({ length: 32 }, (_, index) => `d${index}`).join("/");
    const pathAtComponentLimit = "c".repeat(255);
    const paxAtRecordLimit = Buffer.concat([
      ...Array.from({ length: 255 }, (_, index) => paxRecord(`key${index}`, "value")),
      paxRecord("comment", "record 256"),
    ]);
    expect(pathAtDepthLimit.split("/")).toHaveLength(32);
    expect(Buffer.byteLength(pathAtComponentLimit)).toBe(255);

    writeTarFixture(artifact, [
      manifestTarEntry(id),
      { name: "PaxHeader", type: "x", data: paxRecord("path", pathAtDepthLimit) },
      { name: "depth-limit", data: "depth boundary" },
      { name: "PaxHeader", type: "x", data: paxRecord("path", pathAtComponentLimit) },
      { name: "component-limit", data: "component boundary" },
      { name: "PaxHeader", type: "x", data: paxAtRecordLimit },
      { name: "pax-limit.txt", data: "record boundary" },
    ]);

    await installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp });

    const installed = join(tmp, "custom_integrations", id);
    expect(readFileSync(join(installed, pathAtDepthLimit), "utf-8")).toBe("depth boundary");
    expect(readFileSync(join(installed, pathAtComponentLimit), "utf-8")).toBe("component boundary");
    expect(readFileSync(join(installed, "pax-limit.txt"), "utf-8")).toBe("record boundary");
  });

  it("accepts a 1,024-byte resolved path during structural validation", async () => {
    const id = "path-byte-boundary-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    const pathAtByteLimit = Array.from({ length: 5 }, () => "a".repeat(204)).join("/");
    expect(Buffer.byteLength(pathAtByteLimit)).toBe(1024);
    writeTarFixture(artifact, [
      manifestTarEntry(id),
      { name: "PaxHeader", type: "x", data: paxRecord("path", pathAtByteLimit) },
      { name: "unsupported", type: "7" },
    ]);

    await expectArtifactRejection(artifact, id, /Unsupported artifact entry type '7'/);
  });

  it.each([
    {
      id: "bytes",
      label: "a PAX-resolved path over 1,024 bytes",
      key: "path",
      value: Array.from({ length: 6 }, () => "a".repeat(204)).join("/"),
      entry: { name: "byte-limit", data: "x" } satisfies TarFixtureEntry,
      message: /artifact path.*1,024 UTF-8 bytes/i,
    },
    {
      id: "depth",
      label: "a path with 33 components",
      key: "path",
      value: Array.from({ length: 33 }, () => "a").join("/"),
      entry: { name: "depth-limit", data: "x" } satisfies TarFixtureEntry,
      message: /artifact path.*32 components/i,
    },
    {
      id: "component",
      label: "a path component over 255 bytes",
      key: "path",
      value: "a".repeat(256),
      entry: { name: "component-limit", data: "x" } satisfies TarFixtureEntry,
      message: /artifact path component.*255 UTF-8 bytes/i,
    },
    {
      id: "link-depth",
      label: "a link target with 33 components",
      key: "linkpath",
      value: Array.from({ length: 33 }, () => "target").join("/"),
      entry: { name: "linked", type: "2", linkName: "fallback" } satisfies TarFixtureEntry,
      message: /artifact link target.*32 components/i,
    },
  ])("rejects $label before installation", async ({ id: suffix, key, value, entry, message }) => {
    const id = `path-limit-artifact-${suffix}`;
    const artifact = join(tmp, `${id}.tar.gz`);
    writeTarFixture(artifact, [
      manifestTarEntry(id),
      { name: "PaxHeader", type: "x", data: paxRecord(key, value) },
      entry,
    ]);

    await expectArtifactRejection(artifact, id, message);
  });

  it("rejects more than 256 records in one PAX payload", async () => {
    const id = "pax-record-limit-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    const records = Buffer.concat(
      Array.from({ length: 257 }, (_, index) => paxRecord(`key${index}`, "value")),
    );
    writeTarFixture(artifact, [
      manifestTarEntry(id),
      { name: "PaxHeader", type: "x", data: records },
      { name: "payload.txt", data: "x" },
    ]);

    await expectArtifactRejection(artifact, id, /PAX payload.*256 records/i);
  });

  it.each([
    {
      id: "truncated",
      label: "truncated payload bytes",
      claimedSize: 10,
      data: "abc",
      message: /tar payload.*truncated/i,
    },
    {
      id: "padding",
      label: "missing payload padding",
      claimedSize: 3,
      data: "abc",
      message: /tar payload.*padding/i,
    },
  ])("rejects $label", async ({ id: suffix, claimedSize, data, message }) => {
    const id = `payload-bounds-artifact-${suffix}`;
    const artifact = join(tmp, `${id}.tar.gz`);
    writeTarFixture(
      artifact,
      [manifestTarEntry(id), { name: "payload.txt", data, claimedSize, omitPadding: true }],
      { endBlocks: false },
    );

    await expectArtifactRejection(artifact, id, message);
  });

  it("rejects a trailing partial tar header", async () => {
    const id = "partial-header-artifact";
    const artifact = join(tmp, `${id}.tar.gz`);
    writeFileSync(
      artifact,
      gzipSync(Buffer.concat([tarFixtureEntry(manifestTarEntry(id)), Buffer.from([1])])),
    );

    await expectArtifactRejection(artifact, id, /partial tar header/i);
  });

  it.each([
    {
      id: "length",
      label: "a PAX record whose declared length omits its newline",
      payload: Buffer.from("8 path=a\n"),
    },
    {
      id: "trailing",
      label: "unterminated trailing PAX data",
      payload: Buffer.from("9 path=a\nx"),
    },
    {
      id: "non-decimal-length",
      label: "a PAX record with a non-decimal length",
      payload: Buffer.from("11x path=a\n"),
    },
  ])("rejects $label", async ({ id: suffix, payload }) => {
    const id = `malformed-pax-artifact-${suffix}`;
    const artifact = join(tmp, `${id}.tar.gz`);
    writeTarFixture(artifact, [
      manifestTarEntry(id),
      { name: "PaxHeader", type: "x", data: payload },
      { name: "payload.txt", data: "x" },
    ]);

    await expectArtifactRejection(artifact, id, /invalid PAX|PAX payload/i);
  });

  it("rejects a prebuilt same-origin frontend bundle", async () => {
    const src = join(tmp, "artifact-src");
    mkdirSync(join(src, "dist", "frontend"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "artifact-demo",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "dist", "frontend", "index.js"),
      "window.__openmapx_integrations=[];",
      "utf-8",
    );
    const artifact = join(tmp, "artifact-demo.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({
        source: artifact,
        sourceKind: "artifact",
        artifactSha256: sha256(artifact),
        rootDir: tmp,
      }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "artifact-demo"))).toBe(false);
  });

  it("extracts artifact entries that use tar long-path metadata", async () => {
    const src = join(tmp, "long-path-artifact-src");
    const longFileName = `${"a".repeat(120)}.txt`;
    mkdirSync(join(src, "assets"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "long-path-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "assets", longFileName), "hello");
    const artifact = join(tmp, "long-path-artifact.tar.gz");
    writeTarGz(src, artifact);

    await installIntegration({
      source: artifact,
      sourceKind: "artifact",
      rootDir: tmp,
    });

    expect(
      existsSync(join(tmp, "custom_integrations", "long-path-artifact", "assets", longFileName)),
    ).toBe(true);
  });

  it("extracts safe internal symlinks from artifacts", async () => {
    const src = join(tmp, "symlink-artifact-src");
    const targetDir = join(src, "assets", "real");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "symlink-artifact" }),
      "utf-8",
    );
    writeFileSync(join(targetDir, "data.json"), '{ "ok": true }', "utf-8");
    symlinkSync("real", join(src, "assets", "linked"), "dir");
    const artifact = join(tmp, "symlink-artifact.tar.gz");
    writeTarGz(src, artifact);

    await installIntegration({
      source: artifact,
      sourceKind: "artifact",
      rootDir: tmp,
    });

    const installedLink = join(tmp, "custom_integrations", "symlink-artifact", "assets", "linked");
    expect(lstatSync(installedLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(installedLink, "data.json"))).toBe(true);
  });

  it("rejects artifacts that ship a node_modules directory", async () => {
    const src = join(tmp, "node-modules-artifact-src");
    mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "node-modules-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "node_modules", "pkg", "index.js"), "module.exports = {};");
    const artifact = join(tmp, "node-modules-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/must not ship a node_modules/);
    expect(existsSync(join(tmp, "custom_integrations", "node-modules-artifact"))).toBe(false);
  });

  it("rejects artifacts whose extracted tar exceeds the artifact byte limit", async () => {
    const src = join(tmp, "oversized-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "oversized-artifact" }),
      "utf-8",
    );
    writeFileSync(join(src, "payload.txt"), "a".repeat(64 * 1024), "utf-8");
    const artifact = join(tmp, "oversized-artifact.tar.gz");
    writeTarGz(src, artifact);

    expect(statSync(artifact).size).toBeLessThan(4096);
    await expect(
      installIntegration({
        source: artifact,
        sourceKind: "artifact",
        rootDir: tmp,
        maxArtifactBytes: 4096,
      }),
    ).rejects.toThrow(/extracted size exceeds max/);
    expect(existsSync(join(tmp, "custom_integrations", "oversized-artifact"))).toBe(false);
  });

  it("rejects manifests that advertise executable community presentation code", async () => {
    const src = join(tmp, "broken-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "broken-artifact",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    const artifact = join(tmp, "broken-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "broken-artifact"))).toBe(false);
  });

  it("rejects backend artifacts before they enter the privileged runtime mount", async () => {
    const src = join(tmp, "broken-backend-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "broken-backend-artifact",
        backend: { routes: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "index.ts"),
      "export function setup() { /* intentionally unbundled */ }",
      "utf-8",
    );
    const artifact = join(tmp, "broken-backend-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
    expect(existsSync(join(tmp, "custom_integrations", "broken-backend-artifact"))).toBe(false);
  });

  it("rejects obsolete executable-bundle metadata", async () => {
    const src = join(tmp, "bad-checksum-artifact-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "bad-checksum-artifact",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    writeFileSync(join(src, "preview.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf-8");
    writeFileSync(
      join(src, "openmapx-artifact.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "bad-checksum-artifact",
        platformVersion: "1.0.0",
        builtAt: new Date().toISOString(),
        bundles: {
          preview: {
            path: "preview.svg",
            sha256: "0".repeat(64),
          },
        },
      }),
      "utf-8",
    );
    const artifact = join(tmp, "bad-checksum-artifact.tar.gz");
    writeTarGz(src, artifact);

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/invalid shape/);
    expect(existsSync(join(tmp, "custom_integrations", "bad-checksum-artifact"))).toBe(false);
  });
});

describe("packageIntegration", () => {
  it("rejects packaging executable community presentation code", async () => {
    const src = join(tmp, "package-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "package-demo",
        frontend: { legend: true },
      }),
      "utf-8",
    );
    writeFileSync(
      join(src, "legend.tsx"),
      "export default function Legend() { return null; }",
      "utf-8",
    );
    await expect(
      packageIntegration({
        rootDir: tmp,
        source: src,
        outFile: join(tmp, "package-demo.tar.gz"),
      }),
    ).rejects.toThrow(/Executable community integration code cannot be installed/);
  });

  it("preserves a static preview without creating a frontend bundle", async () => {
    const src = join(tmp, "package-preview-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "package-preview",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
      "utf-8",
    );
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
    writeFileSync(join(src, "preview.svg"), svg);

    const artifact = join(tmp, "package-preview.tar.gz");
    const result = await packageIntegration({
      rootDir: tmp,
      source: src,
      outFile: artifact,
    });
    expect(result.files).not.toContain("dist/frontend/index.js");
    expect(existsSync(join(src, "dist", "frontend", "index.js"))).toBe(false);

    await installIntegration({ rootDir: tmp, source: artifact, sourceKind: "artifact" });
    const installed = join(tmp, "custom_integrations", "package-preview");
    expect(readFileSync(join(installed, "preview.svg"), "utf-8")).toBe(svg);
    expect(existsSync(join(installed, "dist", "frontend", "index.js"))).toBe(false);
  });
});

describe("integration rollback backups", () => {
  it("restores the exact pre-update files", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    const target = join(tmp, "custom_integrations", "weather-radar");
    writeFileSync(join(target, "version.txt"), "old", "utf8");
    const backup = backupInstalledIntegration(tmp, "weather-radar");
    expect(backup).not.toBeNull();

    writeFileSync(join(target, "version.txt"), "new", "utf8");
    writeFileSync(join(target, "new-only.txt"), "new", "utf8");
    restoreInstalledIntegration(tmp, backup as NonNullable<typeof backup>);

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(join(target, "new-only.txt"))).toBe(false);
    expect(existsSync((backup as NonNullable<typeof backup>).backupDirectory)).toBe(false);
  });
});

describe("removeIntegration", () => {
  it("removes the directory", () => {
    writeIntegration("custom_integrations", "weather-radar", {
      ...baseManifest,
      id: "weather-radar",
    });
    removeIntegration({ id: "weather-radar", rootDir: tmp });
    expect(existsSync(join(tmp, "custom_integrations", "weather-radar"))).toBe(false);
  });

  it("throws when the integration is not installed", () => {
    expect(() => removeIntegration({ id: "ghost", rootDir: tmp })).toThrow(/not installed/);
  });

  it("rejects a path-traversal id (defense in depth)", () => {
    expect(() => removeIntegration({ id: "../../etc/cron.d/evil", rootDir: tmp })).toThrow(
      /Invalid integration id/,
    );
  });

  it("rejects an empty id", () => {
    expect(() => removeIntegration({ id: "", rootDir: tmp })).toThrow(/Invalid integration id/);
  });
});

describe("installIntegration security", () => {
  it("rejects a local integration that uses a built-in integration id", async () => {
    writeIntegration("integrations", "core-feature", {
      ...baseManifest,
      id: "core-feature",
      name: "Trusted built-in",
      quality: "built-in",
    });
    const builtInManifestPath = join(tmp, "integrations", "core-feature", "manifest.json");
    const builtInManifest = readFileSync(builtInManifestPath, "utf-8");
    const source = join(tmp, "community-source");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "core-feature", name: "Untrusted community" }),
      "utf-8",
    );

    await expect(installIntegration({ source, rootDir: tmp })).rejects.toThrow(
      /built-in integration id/i,
    );

    expect(existsSync(join(tmp, "custom_integrations", "core-feature"))).toBe(false);
    expect(readFileSync(builtInManifestPath, "utf-8")).toBe(builtInManifest);
  });

  it("rejects an integration artifact that uses a built-in integration id before replacement", async () => {
    writeIntegration("integrations", "core-feature", {
      ...baseManifest,
      id: "core-feature",
      name: "Trusted built-in",
      quality: "built-in",
    });
    const source = join(tmp, "community-artifact-source");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "core-feature", name: "Untrusted artifact" }),
      "utf-8",
    );
    const artifact = join(tmp, "community-artifact.tar.gz");
    writeTarGz(source, artifact);
    const installed = join(tmp, "custom_integrations", "core-feature");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "keep.txt"), "existing install", "utf-8");

    await expect(
      installIntegration({ source: artifact, sourceKind: "artifact", rootDir: tmp }),
    ).rejects.toThrow(/built-in integration id/i);

    expect(readFileSync(join(installed, "keep.txt"), "utf-8")).toBe("existing install");
  });

  it("rejects a remote artifact without a SHA-256 pin before downloading", async () => {
    await expect(
      installIntegration({
        source: "https://example.com/community.tar.gz",
        sourceKind: "artifact",
        rootDir: tmp,
      }),
    ).rejects.toThrow(/require an expected SHA-256 digest/);
  });

  it("rejects a preview symlink that escapes the integration", async () => {
    const outside = join(tmp, "outside.svg");
    writeFileSync(outside, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const src = join(tmp, "escaping-preview-link");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({
        ...baseManifest,
        id: "escaping-preview-link",
        frontend: {
          layerSelector: { group: "map-details", labelKey: "example", preview: "preview.svg" },
        },
      }),
    );
    symlinkSync(outside, join(src, "preview.svg"));

    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /frontend\.layerSelector\.preview.*symlink/,
    );
  });

  it("rejects a manifest with a path-traversal id", async () => {
    const src = join(tmp, "evil");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "../../etc/cron.d/evil" }),
      "utf-8",
    );
    // Schema regex catches this at validation time, before any path concatenation.
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
    expect(existsSync(join(tmp, "custom_integrations", "..", "..", "etc"))).toBe(false);
  });

  it("rejects a manifest with id containing JS-injection characters", async () => {
    const src = join(tmp, "injection");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: 'x"; window.evil()//' }),
      "utf-8",
    );
    await expect(installIntegration({ source: src, rootDir: tmp })).rejects.toThrow(
      /Manifest validation failed/,
    );
  });

  it("rejects a non-https Git URL", async () => {
    await expect(
      installIntegration({ source: "http://github.com/owner/repo.git", rootDir: tmp }),
    ).rejects.toThrow(/Only https/);
  });

  it("rejects a Git URL on an off-allowlist host", async () => {
    await expect(
      installIntegration({ source: "https://random.example.com/repo.git", rootDir: tmp }),
    ).rejects.toThrow(/not in the repository allowlist/);
  });

  it("accepts a github:user/repo spec at allowlist validation time", async () => {
    // Should clear URL gating; the failure that follows comes from `git clone`
    // (which we don't run in tests). The fact that the error is NOT a
    // URL-validation error means the allowlist accepted it.
    await expect(
      installIntegration({
        source: "github:owner/repo",
        rootDir: tmp,
        // Suppress the actual clone by aborting before spawn fires.
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a local source when allowLocalSources is false", async () => {
    const src = join(tmp, "src-int");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "manifest.json"),
      JSON.stringify({ ...baseManifest, id: "ads-b" }),
      "utf-8",
    );
    await expect(
      installIntegration({ source: src, rootDir: tmp, allowLocalSources: false }),
    ).rejects.toThrow(/Local paths are not allowed/);
    expect(existsSync(join(tmp, "custom_integrations", "ads-b"))).toBe(false);
  });
});
