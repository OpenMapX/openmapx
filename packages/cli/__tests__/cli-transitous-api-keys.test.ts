import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import {
  createCatalogPinSet,
  initializeManagedCatalogPins,
  readCatalogPinSet,
  retainCatalogProposal,
} from "@openmapx/core/catalog-pins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureTransitousApiKeysFile,
  generateTransitousApiKeys,
  transitousApiKeysPath,
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
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const keysPath = () => transitousApiKeysPath(join(tmp, "infra", "docker"));
const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("generateTransitousApiKeys", () => {
  it("requires active paired pins without refreshing upstream or changing existing values", async () => {
    ensureTransitousApiKeysFile(tmp);
    const output = keysPath(),
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

describe("ensureTransitousApiKeysFile", () => {
  it("starts an empty keys file in an operations agent without the checkout too", () => {
    // The agent names its root; nothing there marks a checkout.
    vi.stubEnv("OPENMAPX_ROOT_DIR", tmp);
    try {
      rmSync(join(tmp, "services"), { recursive: true });

      expect(ensureTransitousApiKeysFile(tmp)).toEqual({ path: keysPath(), created: "empty" });
      expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
      expect(mode(keysPath())).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates a private directory holding only an empty keys file", () => {
    const result = ensureTransitousApiKeysFile(tmp);

    expect(result).toEqual({ path: keysPath(), created: "empty" });
    expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
    expect(mode(keysPath())).toBe(0o600);
    expect(mode(join(keysPath(), ".."))).toBe(0o700);
    expect(readdirSync(join(keysPath(), ".."))).toEqual(["api-keys.json"]);
  });

  it("keeps an existing keys file owner-only", () => {
    ensureTransitousApiKeysFile(tmp);
    chmodSync(keysPath(), 0o664);

    expect(ensureTransitousApiKeysFile(tmp).created).toBeNull();
    expect(mode(keysPath())).toBe(0o600);
  });

  it.each([
    ["it is not a JSON object of key strings", () => writeFileSync(keysPath(), "[]")],
    ["it is not a JSON object of key strings", () => writeFileSync(keysPath(), "{ not json")],
    ["it is not a JSON object of key strings", () => writeFileSync(keysPath(), '{"a":1}')],
    ["it has 2 links", () => linkSync(keysPath(), join(tmp, "elsewhere.json"))],
    [
      "it is a symbolic link",
      () => {
        writeFileSync(join(tmp, "target.json"), "{}");
        rmSync(keysPath());
        symlinkSync(join(tmp, "target.json"), keysPath());
      },
    ],
    [
      "it is not a regular file",
      () => {
        rmSync(keysPath());
        mkdirSync(keysPath());
      },
    ],
  ])("refuses an existing keys file when %s", (reason, arrange) => {
    ensureTransitousApiKeysFile(tmp);
    arrange();

    expect(() => ensureTransitousApiKeysFile(tmp)).toThrow(
      `Transitous API keys at ${keysPath()} can't be used: ${reason}`,
    );
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
  const output = keysPath();
  ensureTransitousApiKeysFile(tmp);
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
  const proposedSha = git(upstream, ["rev-parse", "HEAD"]);
  git(cache, ["fetch", "origin", proposedSha]);
  const agent = openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const proposalId = "00000000-0000-4000-8000-000000000003";
  const active = readCatalogPinSet(tmp)!;
  const pins = createCatalogPinSet(
    { ...active.transitous, ref: `main@${proposedSha}` },
    active.gbfs,
  );
  try {
    await retainCatalogProposal({
      rootDir: tmp,
      installation: agent,
      proposal: {
        proposalId,
        baseGenerationId: active.generationId,
        pins,
        diffDigest: "e".repeat(64),
        sourcePolicyRevision: "f".repeat(64),
      },
    });
  } finally {
    closeControlInstallation(agent);
  }
  await expect(generateTransitousApiKeys({ ...options, proposalId })).resolves.toMatchObject({
    catalogRevisionId: pins.generationId,
    droppedCount: 0,
  });
  const proposedValues = JSON.parse(readFileSync(output, "utf8"));
  expect(proposedValues).toHaveProperty("de/UpstreamB", "");
  expect(proposedValues).toHaveProperty("de/PinnedA", "");
  expect(proposedValues["retained/orphan"]).toBe("  exact value\n");
  expect(readCatalogPinSet(tmp)?.generationId).toBe(active.generationId);
  expect(git(cache, ["rev-parse", "HEAD"])).toBe(sha);
  // Two real Git repositories/submodules and paired-pin journals exceed 45s on this filesystem.
}, 90000);
