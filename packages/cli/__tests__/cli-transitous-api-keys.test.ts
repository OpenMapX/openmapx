import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  describeTransitousApiKeysMigration,
  ensureTransitousApiKeysFile,
  generateTransitousApiKeys,
  legacyTransitousApiKeysPath,
  transitousApiKeysLeftBehindWarning,
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
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

const keysPath = () => transitousApiKeysPath(join(tmp, "infra", "docker"));
const legacyPath = () => legacyTransitousApiKeysPath(tmp);
const mode = (path: string) => lstatSync(path).mode & 0o777;

/** An earlier release's keys file, as an operator kept it. */
function writeLegacy(contents: unknown, fileMode = 0o600): void {
  writeFileSync(legacyPath(), `${JSON.stringify(contents, null, 2)}\n`);
  chmodSync(legacyPath(), fileMode);
}

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

describe("ensureTransitousApiKeysFile", () => {
  it("in an operations agent without the checkout keeps a copied file, and never starts an empty one", () => {
    // The agent names its root; nothing there marks a checkout.
    vi.stubEnv("OPENMAPX_ROOT_DIR", tmp);
    try {
      rmSync(join(tmp, "services"), { recursive: true });
      expect(() => ensureTransitousApiKeysFile(tmp)).toThrow(
        /never copied from the checkout .* runs without the checkout: run `pnpm openmapx compose render` on the host/,
      );
      expect(existsSync(keysPath())).toBe(false);
      mkdirSync(join(tmp, "services"));
      ensureTransitousApiKeysFile(tmp);
      rmSync(join(tmp, "services"), { recursive: true });
      expect(ensureTransitousApiKeysFile(tmp)).toEqual({ path: keysPath(), created: null });
    } finally {
      vi.unstubAllEnvs();
      mkdirSync(join(tmp, "services"), { recursive: true });
    }
  });

  it("creates a private directory holding only an empty keys file", () => {
    const result = ensureTransitousApiKeysFile(tmp);

    expect(result).toEqual({ path: keysPath(), created: "empty" });
    expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
    expect(mode(keysPath())).toBe(0o600);
    expect(mode(join(keysPath(), ".."))).toBe(0o700);
    expect(readdirSync(join(keysPath(), ".."))).toEqual(["api-keys.json"]);
    expect(describeTransitousApiKeysMigration(result, tmp)).toBeNull();
  });

  it("copies the earlier release's file once, leaving it in place", () => {
    writeLegacy({ "us-ca/NeedsKey": "secret" });
    const earlier = readFileSync(legacyPath(), "utf-8");

    const first = ensureTransitousApiKeysFile(tmp);
    expect(first.created).toBe("copied");
    expect(readFileSync(keysPath(), "utf-8")).toBe(earlier);
    expect(readFileSync(legacyPath(), "utf-8")).toBe(earlier);
    expect(mode(legacyPath())).toBe(0o600);
    expect(describeTransitousApiKeysMigration(first, tmp)).toEqual({
      level: "info",
      message:
        "Copied the Transitous API keys from services/motis/tools/transitous/api-keys.json to infra/docker/secrets/transitous-api-keys/api-keys.json; the earlier file stays for rolling back and is no longer read.",
    });

    // Later edits in the checkout are no longer read.
    writeLegacy({ "us-ca/NeedsKey": "changed" });
    expect(ensureTransitousApiKeysFile(tmp)).toEqual({ path: keysPath(), created: null });
    expect(readFileSync(keysPath(), "utf-8")).toBe(earlier);
  });

  it.each([
    ["group or others can write it", () => writeLegacy({ a: "b" }, 0o664)],
    ["it is not a JSON object of key strings", () => writeFileSync(legacyPath(), "{ not json")],
    ["it is not a JSON object of key strings", () => writeLegacy({ a: 1 })],
    [
      "it has 2 links",
      () => {
        writeLegacy({ a: "b" });
        linkSync(legacyPath(), join(tmp, "elsewhere.json"));
      },
    ],
    [
      "it is a symbolic link",
      () => {
        writeFileSync(join(tmp, "target.json"), "{}");
        symlinkSync(join(tmp, "target.json"), legacyPath());
      },
    ],
  ])("leaves an earlier file in place when %s, and starts empty", (reason, arrange) => {
    arrange();
    const earlier = lstatSync(legacyPath());

    const result = ensureTransitousApiKeysFile(tmp);

    expect(result).toEqual({
      path: keysPath(),
      created: "empty",
      leftInPlace: { path: legacyPath(), reason },
    });
    expect(readFileSync(keysPath(), "utf-8")).toBe("{}\n");
    expect(lstatSync(legacyPath()).mtimeMs).toBe(earlier.mtimeMs);
    expect(lstatSync(legacyPath()).mode).toBe(earlier.mode);
    expect(describeTransitousApiKeysMigration(result, tmp)).toEqual({
      level: "warn",
      message: `Left the earlier Transitous API keys file services/motis/tools/transitous/api-keys.json in place and started an empty infra/docker/secrets/transitous-api-keys/api-keys.json: ${reason}. If it is yours, check it and copy its keys into the new file, or run pnpm openmapx data generate-api-keys and enter them again.`,
    });
  });

  it("keeps an existing keys file owner-only", () => {
    ensureTransitousApiKeysFile(tmp);
    chmodSync(keysPath(), 0o664);

    expect(ensureTransitousApiKeysFile(tmp).created).toBeNull();
    expect(mode(keysPath())).toBe(0o600);
  });

  it("refuses an existing keys file it can't use", () => {
    ensureTransitousApiKeysFile(tmp);
    writeFileSync(keysPath(), "[]");

    expect(() => ensureTransitousApiKeysFile(tmp)).toThrow(
      `Transitous API keys at ${keysPath()} can't be used: it is not a JSON object of key strings`,
    );
  });
});

describe("transitousApiKeysLeftBehindWarning", () => {
  const FIX =
    "Copy the keys you meant to keep into infra/docker/secrets/transitous-api-keys/api-keys.json, or run pnpm openmapx data generate-api-keys and enter them again.";

  it("keeps reporting the keys a refused copy left behind, by name only", () => {
    writeLegacy({ "us-ca/NeedsKey": "secret-one", "de/BVG": "secret-two", "fr/Empty": "" }, 0o664);
    expect(ensureTransitousApiKeysFile(tmp).leftInPlace).toBeDefined();

    const warning = transitousApiKeysLeftBehindWarning(tmp);
    expect(warning).toBe(
      `The earlier Transitous API keys file services/motis/tools/transitous/api-keys.json sets 2 keys that infra/docker/secrets/transitous-api-keys/api-keys.json doesn't (de/BVG, us-ca/NeedsKey): it was not copied because group or others can write it. ${FIX}`,
    );
    expect(warning).not.toMatch(/secret-one|secret-two/);
    // Later renders are silent; check keeps saying it.
    expect(describeTransitousApiKeysMigration(ensureTransitousApiKeysFile(tmp), tmp)).toBeNull();
    expect(transitousApiKeysLeftBehindWarning(tmp)).toBe(warning);
  });

  it("names only the keys still missing, and stops once every one is carried over", () => {
    writeLegacy({ "us-ca/NeedsKey": "one", "de/BVG": "two" }, 0o664);
    ensureTransitousApiKeysFile(tmp);
    writeFileSync(keysPath(), JSON.stringify({ "de/BVG": "two", "us-ca/NeedsKey": "" }));
    expect(transitousApiKeysLeftBehindWarning(tmp)).toMatch(
      /sets 1 key that .* doesn't \(us-ca\/NeedsKey\)/,
    );

    writeFileSync(keysPath(), JSON.stringify({ "de/BVG": "two", "us-ca/NeedsKey": "one" }));
    expect(transitousApiKeysLeftBehindWarning(tmp)).toBeNull();
  });

  it("says why it is no longer copied once the earlier file would pass", () => {
    writeLegacy({ "de/BVG": "two" }, 0o664);
    ensureTransitousApiKeysFile(tmp);
    chmodSync(legacyPath(), 0o600);

    expect(transitousApiKeysLeftBehindWarning(tmp)).toMatch(
      /: infra\/docker\/secrets\/transitous-api-keys\/api-keys\.json already existed, so it is no longer copied\./,
    );
  });

  it("reports an earlier file it can't compare", () => {
    writeFileSync(join(tmp, "target.json"), JSON.stringify({ "de/BVG": "two" }));
    symlinkSync(join(tmp, "target.json"), legacyPath());
    ensureTransitousApiKeysFile(tmp);

    expect(transitousApiKeysLeftBehindWarning(tmp)).toBe(
      `The earlier Transitous API keys file services/motis/tools/transitous/api-keys.json was left in place and can't be compared with infra/docker/secrets/transitous-api-keys/api-keys.json: it is a symbolic link. ${FIX}`,
    );
  });

  it("prints no name that could carry terminal controls, only counts it", () => {
    writeLegacy(
      {
        "de/BVG": "one",
        "de/\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007": "two",
        "de/‮gnp.exe": "three",
        "de/line\nbreak": "four",
      },
      0o664,
    );
    ensureTransitousApiKeysFile(tmp);

    const warning = transitousApiKeysLeftBehindWarning(tmp) ?? "";
    expect(warning).toContain("sets 4 keys that");
    expect(warning).toContain("(de/BVG and 3 more)");
    const controls = [...warning].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    });
    expect(controls).toEqual([]);
    expect(warning).not.toContain("evil.example");
  });

  it("lists at most ten names", () => {
    const keys = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`de/S${String(index).padStart(2, "0")}`, "k"]),
    );
    writeLegacy(keys, 0o664);
    ensureTransitousApiKeysFile(tmp);

    expect(transitousApiKeysLeftBehindWarning(tmp)).toMatch(
      /sets 12 keys .* \(de\/S00, .*, de\/S09 and 2 more\)/,
    );
  });

  it("has nothing to say without an earlier file, before the first render, or with only empty slots", () => {
    expect(transitousApiKeysLeftBehindWarning(tmp)).toBeNull();
    writeLegacy({ "de/BVG": "two" }, 0o664);
    expect(transitousApiKeysLeftBehindWarning(tmp)).toBeNull();
    writeLegacy({ "de/BVG": "  " }, 0o664);
    ensureTransitousApiKeysFile(tmp);
    expect(transitousApiKeysLeftBehindWarning(tmp)).toBeNull();
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
