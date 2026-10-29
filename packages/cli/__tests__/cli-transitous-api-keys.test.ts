import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins } from "@openmapx/core/catalog-pins";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  generateTransitousApiKeys,
} from "../src/lib/transitous-api-keys";

let tmp: string;

function writeTransitousCatalog(catalogDir: string): void {
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(join(catalogDir, "transitland-atlas", "feeds", "nested"), { recursive: true });

  writeFileSync(
    join(catalogDir, "feeds", "us-ca.json"),
    JSON.stringify({
      sources: [
        { name: "NeedsKey", "transitland-atlas-id": "atlas-auth-1" },
        { name: "NoAuthNeeded", "transitland-atlas-id": "atlas-open" },
        { name: "AlreadyInCatalog", "transitland-atlas-id": "atlas-auth-1", "api-key": "inline" },
        { name: "CustomUrl", "transitland-atlas-id": "atlas-auth-1", "url-override": "https://x" },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "feeds", "ca-qc.json"),
    JSON.stringify({
      sources: [{ name: "QuebecAgency", "transitland-atlas-id": "atlas-auth-2", skip: true }],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "transitland-atlas", "feeds", "nested", "agencies.dmfr.json"),
    JSON.stringify({
      feeds: [
        { id: "atlas-auth-1", authorization: { type: "api-key" } },
        { id: "atlas-auth-2", authorization: { type: "token" } },
        { id: "atlas-open" },
      ],
    }),
    "utf-8",
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-api-keys-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("generateTransitousApiKeys", () => {
  it("requires active paired pins without refreshing upstream or changing existing values", async () => {
    const output = join(tmp, "services/motis/tools/transitous/api-keys.json"),
      before = JSON.stringify({ "retained/orphan": "  exact value\n" });
    writeFileSync(output, before);
    let calls = 0;
    await expect(
      generateTransitousApiKeys({
        rootDir: tmp,
        runner: async () => {
          calls++;
        },
      }),
    ).rejects.toThrow(/pins/);
    expect(calls).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(before);
  });
  it("refuses mutable repository overrides before any acquisition or output", async () => {
    let calls = 0;
    await expect(
      generateTransitousApiKeys({
        rootDir: tmp,
        transitousRepoUrl: "https://example.test/upstream",
        runner: async () => {
          calls++;
        },
      }),
    ).rejects.toThrow(/overrides/);
    expect(calls).toBe(0);
  });
});

it("uses actual active pin A while upstream is B and preserves unrelated credential bytes", async () => {
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenMapX fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "OpenMapX fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  const upstream = join(tmp, "upstream"),
    cache = join(tmp, "infra/docker/data/.transitous-catalog");
  mkdirSync(upstream);
  writeTransitousCatalog(upstream);
  git(upstream, ["init"]);
  const atlas = join(upstream, "transitland-atlas");
  git(atlas, ["init"]);
  git(atlas, ["add", "."]);
  git(atlas, ["commit", "-m", "Atlas A"]);
  const atlasSha = git(atlas, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(upstream, ".gitmodules"),
    `[submodule "transitland-atlas"]\npath = transitland-atlas\nurl = ${atlas}\n`,
  );
  writeFileSync(
    join(upstream, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "PinnedA", "transitland-atlas-id": "atlas-auth-1" }] }),
  );
  git(upstream, ["add", "feeds", ".gitmodules"]);
  git(upstream, ["update-index", "--add", "--cacheinfo", `160000,${atlasSha},transitland-atlas`]);
  git(upstream, ["commit", "-m", "Catalog A"]);
  const sha = git(upstream, ["rev-parse", "HEAD"]);
  mkdirSync(join(tmp, "infra/docker/data"), { recursive: true });
  git(tmp, ["clone", "--recurse-submodules", "--", upstream, cache]);
  const infra = join(tmp, "infra/docker");
  writeFileSync(
    join(infra, "transitous.lock.json"),
    JSON.stringify({
      ref: `main@${sha}`,
      submodules: { "transitland-atlas": atlasSha },
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    }),
  );
  writeFileSync(
    join(infra, "gbfs-catalog.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: "a".repeat(40),
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"a".repeat(40)}/systems.csv`,
      sha256: "b".repeat(64),
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    }),
  );
  await provisionControlInstallation(infra);
  const installation = openControlInstallation({
    infraDir: infra,
    role: "host-cli",
    serviceIds: ["motis"],
  });
  try {
    await initializeManagedCatalogPins({ rootDir: tmp, installation });
  } finally {
    closeControlInstallation(installation);
  }
  writeFileSync(
    join(upstream, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "UpstreamB", "transitland-atlas-id": "atlas-auth-1" }] }),
  );
  git(upstream, ["add", "feeds"]);
  git(upstream, ["commit", "-m", "Catalog B"]);
  const output = join(tmp, "services/motis/tools/transitous/api-keys.json");
  writeFileSync(output, JSON.stringify({ "retained/orphan": "  exact value\n" }));
  const options = {
    rootDir: tmp,
    runner: async (command: string, args: string[], options: { cwd?: string }) => {
      expect(command).toBe("git");
      git(options.cwd ?? tmp, args);
    },
  };
  const result = await generateTransitousApiKeys(options);
  expect(result).toMatchObject({
    requiredCount: 3,
    preservedCount: 1,
    droppedCount: 0,
    orphanedKeys: ["retained/orphan"],
  });
  expect(lstatSync(output).mode & 0o777).toBe(0o600);
  const values = JSON.parse(readFileSync(output, "utf8"));
  expect(values).toHaveProperty("de/PinnedA", "");
  expect(values).not.toHaveProperty("de/UpstreamB");
  expect(values["retained/orphan"]).toBe("  exact value\n");
  expect(git(cache, ["rev-parse", "HEAD"])).toBe(sha);
  const valid = readFileSync(output, "utf8"),
    malformed = '{"key":"one","key":"two"}';
  writeFileSync(output, malformed);
  await expect(generateTransitousApiKeys(options)).rejects.toThrow(/Feed credential/);
  expect(readFileSync(output, "utf8")).toBe(malformed);
  writeFileSync(output, valid);
  await expect(generateTransitousApiKeys(options)).resolves.toMatchObject({ droppedCount: 0 });
}, 45000);
